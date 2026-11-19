/**
 * Worker の WebGPU 描画を、メインキャンバスの「背景」として全画面に出す。
 *
 * Skybox の置き換えを想定している。
 * - 画面全体を覆うスクリーン空間の板ポリを、シーンより先に描く
 *   （`renderOrder` を下げ、深度テスト・深度書き込みを無効にする）
 * - メインシーンのオブジェクトは通常どおりその上に描かれる
 * - 板ポリはスクリーン空間に置かれワールドに固定されない。
 *   XR 中は各目の視点で描くので両眼視差は出る
 *
 * XR では three が 1 回の `render()` で両目を描く。板ポリは目ごとのビューポートを
 * そのまま覆い、シェーダが「どちらの目から描いているか」を見てアトラスの左右を選ぶ。
 * さらに Worker 往復の遅延ぶんを補正する:
 *
 * - **再投影** (`reproject`): いま表示している画像を「描いた姿勢」から
 *   「いまの姿勢」への回転差で UV をずらす。背景は事実上無限遠なので回転だけで
 *   十分で、首振り時のブレが減る（並進は無視する）。描画時の姿勢は
 *   `useGpuWorker` の `getViewCameras` で記録し、結果が届いた時点で確定、
 *   テクスチャが更新された時点で昇格する（画像と姿勢の 1 フレームずれを防ぐ）。
 * - **拡大** (`upscale`): 1 視点ぶんの解像度を目の解像度まで拡大するとき、
 *   バイリニアではなく FSR1 の EASU（12 タップのエッジ適応アップサンプル）を
 *   かける。three の `FSR1Node` は TSL / WebGPURenderer 専用のため、EASU だけを
 *   GLSL に移植したもの（RCAS は入っていない）。
 *
 * どちらも XR のときだけ働く（モニタではほぼ 1:1 なので何もしない）。
 *
 * 深度は書かないので、メインシーンとの前後関係は「常に奥」になる。
 * メインシーンとピクセル単位で合成したい場合は `experimental/DepthComposite` を使う。
 */

import { useFrame, useThree } from '@react-three/fiber'
import type { RootState } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrayCamera,
  DoubleSide,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
} from 'three'
import { isWebXrEyeCamera, useGpuWorker } from './useGpuWorker'
import type {
  GpuWorkerReadyInfo,
  GpuWorkerStats,
  TransferMode,
  TransferSelector,
  WorkerConstructor,
} from './useGpuWorker'

/** シーンより先に描くための renderOrder（背景） */
const BACKDROP_RENDER_ORDER = -1000

/**
 * 画面全体を覆う板ポリ。射影を通さず NDC に直接置くので、
 * カメラの画角・XR の非対称フラスタムに関係なくビューポートいっぱいになる。
 */
const vertexShader = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

/**
 * テクスチャは ImageBitmap 由来で上下が反転している（flipY が効かない）。
 *
 * 色は Worker 側でトーンマップ済みの sRGB。texture.colorSpace = SRGBColorSpace により
 * サンプル時にリニアへ戻るので、ここで同じ sRGB へエンコードし直す。
 *
 * `uPerEye = 1` のとき（XR）、描画中のカメラがヘッドの中心より右か左かで
 * アトラスのどちら半分を引くかを決める。three の XR は 1 回の render() で
 * 両目を描くが、そのとき viewMatrix / cameraPosition は目ごとに切り替わる。
 *
 * `uReproject = 1` のとき、さらに「描画時の姿勢 → いまの姿勢」の回転差で
 * サンプル位置をずらす（再投影）。`uEasu = 1` のときサンプルは EASU。
 */
const fragmentShader = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform sampler2D uColor;
uniform float uEyeCount;
// XR で目ごとに描いている（タイルを選ぶ）
uniform float uPerEye;
// 再投影している（描画時の姿勢が確定済み）
uniform float uReproject;
// EASU で拡大する
uniform float uEasu;
// 1 視点ぶんのテクセルサイズ
uniform vec2 uEyeTexel;
uniform vec3 uHeadPosition;
// 描画時のカメラ基底（view 行列）と投影係数 (sx, sy, ox, oy)
uniform mat4 uPrevView0;
uniform mat4 uPrevView1;
uniform vec4 uPrevProj0;
uniform vec4 uPrevProj1;
// 現在の投影係数 (sx, sy, ox, oy)
uniform vec4 uCurProj0;
uniform vec4 uCurProj1;

vec3 linearToSRGB(vec3 color) {
  return mix(
    pow(color, vec3(0.41666)) * 1.055 - 0.055,
    color * 12.92,
    vec3(lessThanEqual(color, vec3(0.0031308)))
  );
}

/** 目タイル内のローカル uv をアトラスの uv にして 1 タップ。タイル外は端で止める */
vec3 sampleEye(vec2 localUv, float eye) {
  vec2 t = clamp(localUv, 0.5 * uEyeTexel, 1.0 - 0.5 * uEyeTexel);
  return texture2D(uColor, vec2((eye + t.x) / uEyeCount, t.y)).rgb;
}

float luma(vec3 c) {
  return c.r * 0.5 + c.g + c.b * 0.5;
}

/** EASU: 4 象限ぶんの勾配（方向と長さ）を足す */
void accumulateEdge(inout vec2 dir, inout float len, float w, float aL, float bL, float cL, float dL, float eL) {
  float dc = dL - cL;
  float cb = cL - bL;
  float dirX = dL - bL;
  float lenX = max(abs(dc), abs(cb));
  float sLenX = clamp(abs(dirX) / max(lenX, 1.0 / 65536.0), 0.0, 1.0);
  dir.x += dirX * w;
  len += sLenX * sLenX * w;

  float ec = eL - cL;
  float ca = cL - aL;
  float dirY = eL - aL;
  float lenY = max(abs(ec), abs(ca));
  float sLenY = clamp(abs(dirY) / max(lenY, 1.0 / 65536.0), 0.0, 1.0);
  dir.y += dirY * w;
  len += sLenY * sLenY * w;
}

/** EASU: 近似 Lanczos2 の重みで 1 タップ足す */
void accumulateTap(inout vec3 acc, inout float aw, vec2 off, vec2 dir, vec2 len2, float lob, float clp, vec3 color) {
  float vx = off.x * dir.x + off.y * dir.y;
  float vy = -off.x * dir.y + off.y * dir.x;
  float sx = vx * len2.x;
  float sy = vy * len2.y;
  float d2 = min(sx * sx + sy * sy, clp);

  float wB = d2 * (2.0 / 5.0) - 1.0;
  float wA = d2 * lob - 1.0;
  float w = (wB * wB * (25.0 / 16.0) - (25.0 / 16.0 - 1.0)) * (wA * wA);

  acc += color * w;
  aw += w;
}

/**
 * FSR1 EASU（AMD FidelityFX FSR1, MIT）の 12 タップ実装。
 * three の FSR1Node（r184+, TSL / WebGPURenderer 専用）の EASU を GLSL に写したもの。
 * uv は目タイル内の [0,1]、texel は 1/解像度。タイル外は sampleEye が端で止める。
 *
 *   b c
 * e f g h
 * i j k l
 *   n o
 */
vec3 easu(vec2 uv, float eye, vec2 texel) {
  // テクセル中心が整数になる座標系（FSR1 の ip に相当）
  vec2 pp = uv / texel - 0.5;
  vec2 f = fract(pp);
  vec2 o = -f;

  vec3 sB = sampleEye(uv + (vec2(0.0, -1.0) + o) * texel, eye);
  vec3 sC = sampleEye(uv + (vec2(1.0, -1.0) + o) * texel, eye);
  vec3 sE = sampleEye(uv + (vec2(-1.0, 0.0) + o) * texel, eye);
  vec3 sF = sampleEye(uv + (vec2(0.0, 0.0) + o) * texel, eye);
  vec3 sG = sampleEye(uv + (vec2(1.0, 0.0) + o) * texel, eye);
  vec3 sH = sampleEye(uv + (vec2(2.0, 0.0) + o) * texel, eye);
  vec3 sI = sampleEye(uv + (vec2(-1.0, 1.0) + o) * texel, eye);
  vec3 sJ = sampleEye(uv + (vec2(0.0, 1.0) + o) * texel, eye);
  vec3 sK = sampleEye(uv + (vec2(1.0, 1.0) + o) * texel, eye);
  vec3 sL = sampleEye(uv + (vec2(2.0, 1.0) + o) * texel, eye);
  vec3 sN = sampleEye(uv + (vec2(0.0, 2.0) + o) * texel, eye);
  vec3 sO = sampleEye(uv + (vec2(1.0, 2.0) + o) * texel, eye);

  float bL = luma(sB), cL = luma(sC);
  float eL = luma(sE), fL = luma(sF), gL = luma(sG), hL = luma(sH);
  float iL = luma(sI), jL = luma(sJ), kL = luma(sK), lL = luma(sL);
  float nL = luma(sN), oL = luma(sO);

  vec2 dir = vec2(0.0);
  float len = 0.0;

  float w0 = (1.0 - f.x) * (1.0 - f.y);
  float w1 = f.x * (1.0 - f.y);
  float w2 = (1.0 - f.x) * f.y;
  float w3 = f.x * f.y;

  accumulateEdge(dir, len, w0, bL, eL, fL, gL, jL);
  accumulateEdge(dir, len, w1, cL, fL, gL, hL, kL);
  accumulateEdge(dir, len, w2, fL, iL, jL, kL, nL);
  accumulateEdge(dir, len, w3, gL, jL, kL, lL, oL);

  // 勾配が無視できるときは (1, 0) に倒す
  float dirSq = dot(dir, dir);
  bool zro = dirSq < 1.0 / 32768.0;
  float rDirLen = inversesqrt(max(dirSq, 1.0 / 32768.0));
  dir.x = zro ? 1.0 : dir.x;
  dir *= zro ? 1.0 : rDirLen;

  // エッジの強さでカーネルを変形する
  len *= 0.5;
  len *= len;

  // 軸に揃ったエッジで 1.0、斜めで sqrt(2)
  float stretch = dot(dir, dir) / max(abs(dir.x), abs(dir.y));
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - len * 0.5);

  // 負のローブ: 平坦部で強く (0.5)、エッジで弱く (0.21)
  float lob = 0.5 + (0.25 - 0.04 - 0.5) * len;
  float clp = 1.0 / lob;

  vec3 acc = vec3(0.0);
  float aw = 0.0;
  accumulateTap(acc, aw, vec2(0.0, -1.0) - f, dir, len2, lob, clp, sB);
  accumulateTap(acc, aw, vec2(1.0, -1.0) - f, dir, len2, lob, clp, sC);
  accumulateTap(acc, aw, vec2(-1.0, 0.0) - f, dir, len2, lob, clp, sE);
  accumulateTap(acc, aw, vec2(0.0, 0.0) - f, dir, len2, lob, clp, sF);
  accumulateTap(acc, aw, vec2(1.0, 0.0) - f, dir, len2, lob, clp, sG);
  accumulateTap(acc, aw, vec2(2.0, 0.0) - f, dir, len2, lob, clp, sH);
  accumulateTap(acc, aw, vec2(-1.0, 1.0) - f, dir, len2, lob, clp, sI);
  accumulateTap(acc, aw, vec2(0.0, 1.0) - f, dir, len2, lob, clp, sJ);
  accumulateTap(acc, aw, vec2(1.0, 1.0) - f, dir, len2, lob, clp, sK);
  accumulateTap(acc, aw, vec2(2.0, 1.0) - f, dir, len2, lob, clp, sL);
  accumulateTap(acc, aw, vec2(0.0, 2.0) - f, dir, len2, lob, clp, sN);
  accumulateTap(acc, aw, vec2(1.0, 2.0) - f, dir, len2, lob, clp, sO);

  acc /= aw;

  // リンギング抑止: 最近傍 4 テクセル（f, g, j, k）の範囲に収める
  vec3 mn4 = min(min(sF, sG), min(sJ, sK));
  vec3 mx4 = max(max(sF, sG), max(sJ, sK));
  return clamp(acc, mn4, mx4);
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);

  if (uPerEye > 0.5) {
    // いま描いている目（ヘッド中心より左右どちらか）
    vec3 right = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
    float side = dot(cameraPosition - uHeadPosition, right);
    float eye = side >= 0.0 ? 1.0 : 0.0;

    vec2 uv0 = uv;
    if (uReproject > 0.5) {
      mat4 pv;
      vec4 pp;
      vec4 cp;
      if (eye < 0.5) { pv = uPrevView0; pp = uPrevProj0; cp = uCurProj0; }
      else { pv = uPrevView1; pp = uPrevProj1; cp = uCurProj1; }

      // 現在のピクセルの視線（view 空間、c = 1）
      float sx1 = cp.x;
      float sy1 = cp.y;
      float ox1 = cp.z;
      float oy1 = cp.w;
      float ndcX = vUv.x * 2.0 - 1.0;
      float ndcY = vUv.y * 2.0 - 1.0;
      float a1 = (ndcX + ox1) / sx1;
      float b1 = (ndcY + oy1) / sy1;

      vec3 r1 = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
      vec3 u1 = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
      vec3 f1 = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
      vec3 d = a1 * r1 + b1 * u1 + f1; // 視線のワールド方向

      // 描画時の基底に射影し直す
      vec3 r0 = vec3(pv[0][0], pv[1][0], pv[2][0]);
      vec3 u0 = vec3(pv[0][1], pv[1][1], pv[2][1]);
      vec3 f0 = -vec3(pv[0][2], pv[1][2], pv[2][2]);
      float a0 = dot(d, r0);
      float b0 = dot(d, u0);
      float c0 = dot(d, f0);
      float c = abs(c0) < 1e-5 ? 1e-5 : c0;

      vec2 ndc0 = vec2(pp.x * a0 / c - pp.z, pp.y * b0 / c - pp.w);
      // NDC（上が +y）から sampleEye と同じ「下向きが +v」の座標へ戻す。
      // 反転前の uv0（= uv）も同じ座標系なので、以降の経路は共通でよい
      uv0 = clamp(vec2(ndc0.x * 0.5 + 0.5, 0.5 - ndc0.y * 0.5), 0.0, 1.0);
    }

    // どちらの経路の uv0 も「下向きが +v」（テクスチャの行順と同じ）なので
    // そのまま sampleEye / easu へ渡す
    vec3 color = uEasu > 0.5 ? easu(uv0, eye, uEyeTexel) : sampleEye(uv0, eye);
    gl_FragColor = vec4(linearToSRGB(color), 1.0);
    return;
  }

  gl_FragColor = vec4(linearToSRGB(texture2D(uColor, uv).rgb), 1.0);
}
`

type Camera = PerspectiveCamera

/** 投影行列から、再投影シェーダが使う係数 (sx, sy, ox, oy) を取り出す */
function writeProj(out: Vector4, camera: Camera) {
  const p = camera.projectionMatrix.elements
  out.set(p[0] || 1, p[5] || 1, p[8] || 0, p[9] || 0)
}

export interface GpuBackdropProps {
  /** `import MyWorker from './my.worker.ts?worker'` の既定エクスポート */
  worker: WorkerConstructor
  /** Worker の起動時に 1 回だけ渡す任意のデータ */
  workerData?: unknown
  /** Worker の描画解像度の上限（1 視点ぶんの横幅 px） */
  maxWidth?: number
  /** 解像度スケール（devicePixelRatio に掛ける） */
  resolutionScale?: number
  /** Worker を描画する最大頻度 */
  maxFps?: number
  enabled?: boolean
  /**
   * モニタでも左右 2 視点で描く（SBS で並ぶ確認用）。
   * XR 中は自動で 2 視点になる。
   */
  stereo?: boolean
  /** SBS の眼間距離（m） */
  eyeSeparation?: number
  /**
   * XR 中、描画に使った姿勢から現在の姿勢への回転差でサンプル位置をずらして、
   * Worker 往復の遅延による首振りのブレを補正する（既定 true）。
   * 背景は事実上無限遠なので回転だけの再投影で十分で、並進は無視する。
   */
  reproject?: boolean
  /**
   * XR 中、1 視点ぶんの解像度を目の解像度へ拡大するときに FSR1 の EASU を
   * 使う（既定 true）。`false` だとバイリニア。RCAS（2 パス目のシャープ）は
   * 入っていないので、輪郭の立ち方は EASU 単体のぶん。
   */
  upscale?: boolean
  onReady?: (info: GpuWorkerReadyInfo) => void
  onError?: (message: string) => void
  /** コンソールに ready / fps を出す */
  debug?: boolean
  /**
   * 区間別の計測を有効にするか（既定 false）。
   * true のときだけ Worker とメイン描画の時間を測って、
   * 約 1000ms ごとに `onStats` を呼ぶ。描画経路は変えない。
   * マウント時に評価する。切り替えるには再マウントすること。
   * @internal デモ / 開発時の計測用。公開 API ではない。
   */
  profile?: boolean
  /**
   * 計測窓ごとの集計（profile: true のときだけ呼ばれる）
   * @internal デモ / 開発時の計測用。公開 API ではない。
   */
  onStats?: (stats: GpuWorkerStats) => void
  /**
   * 背景画像の受け渡し経路。
   * 未指定なら `selectTransferMode` の既定判定（dGPU / Blink は 'bitmap'、それ以外は 'buffer'）。
   * 固定値か、環境を見て選ぶ関数（マウント時に 1 回だけ評価）を渡して上書きできる。
   * 詳しくは `useGpuWorker` の `transfer` を参照。
   */
  transfer?: TransferMode | TransferSelector
}

export const GpuBackdrop: React.FC<GpuBackdropProps> = ({
  worker,
  workerData,
  maxWidth = 1280,
  resolutionScale = 1,
  maxFps = 60,
  enabled = true,
  stereo = false,
  eyeSeparation = 0.064,
  reproject = true,
  upscale = true,
  onReady,
  onError,
  debug = false,
  profile = false,
  onStats,
  transfer,
}) => {
  const gl = useThree((state) => state.gl)
  const size = useThree((state) => state.size)
  const dpr = useThree((state) => state.viewport.dpr)

  /** XR 中の 1 視点ぶんのアスペクト（XR に入るまで null） */
  const [xrAspect, setXrAspect] = useState<number | null>(null)

  const eyeCount = xrAspect !== null ? 2 : stereo ? 2 : 1
  const displayAspect =
    size.width > 0 && size.height > 0 ? size.width / size.height : 1
  // XR のアスペクトが壊れている（0 / NaN）ときはモニタのアスペクトで代用する
  const imageAspect =
    xrAspect !== null && Number.isFinite(xrAspect) && xrAspect > 0 ? xrAspect : displayAspect

  // --- Worker 側の解像度（1 視点ぶん） --------------------------------------
  const resolution = useMemo(() => {
    const width = Math.max(
      64,
      Math.min(maxWidth, Math.round((size.width * dpr * resolutionScale) / eyeCount)),
    )
    // アスペクトが 0 / NaN のときに高さが Infinity にならないようにする
    return { width, height: Math.max(1, Math.round(width / imageAspect)) }
  }, [size.width, dpr, resolutionScale, maxWidth, eyeCount, imageAspect])

  // --- 視点（カメラ）--------------------------------------------------------
  const eyeCameras = useMemo(() => [new PerspectiveCamera(), new PerspectiveCamera()], [])
  const headPosition = useMemo(() => new Vector3(), [])
  const rightVector = useMemo(() => new Vector3(), [])
  const tmpVector = useMemo(() => new Vector3(), [])

  // --- 再投影用の姿勢 --------------------------------------------------------
  // 送信時の視点（保留）。結果が届いた時点で「確定」に移し、テクスチャが
  // 更新された時点で「表示中の姿勢」に昇格する。この 2 段階で、表示中の画像と
  // それを描いた視点が 1 フレームもずれないようにする。
  const pendingView = useMemo(() => [new Matrix4(), new Matrix4()], [])
  const pendingProj = useMemo(() => [new Vector4(1, 1, 0, 0), new Vector4(1, 1, 0, 0)], [])
  const frozenView = useMemo(() => [new Matrix4(), new Matrix4()], [])
  const frozenProj = useMemo(() => [new Vector4(1, 1, 0, 0), new Vector4(1, 1, 0, 0)], [])
  const prevView = useMemo(() => [new Matrix4(), new Matrix4()], [])
  const prevProj = useMemo(() => [new Vector4(1, 1, 0, 0), new Vector4(1, 1, 0, 0)], [])
  const hasPrev = useRef(false)
  const lastImage = useRef<unknown>(null)

  /** 送信する視点の姿勢を「保留」に記録する（useGpuWorker が送信直前に呼ぶ） */
  const recordPose = useCallback(
    (camera: Camera, index: number) => {
      // 送信する視点（useGpuWorker が view に使う matrixWorldInverse）と
      // 同じ姿勢を記録する。XR の目カメラは WebXRManager が rig 込みで
      // 更新済みなので updateMatrixWorld() は呼ばない（rig 抜きに戻ってしまう）。
      // それ以外のカメラはここで最新化しておく。
      if (!isWebXrEyeCamera(gl, camera)) camera.updateMatrixWorld()
      pendingView[index].copy(camera.matrixWorldInverse)
      const p = camera.projectionMatrix.elements
      pendingProj[index].set(p[0] || 1, p[5] || 1, p[8] || 0, p[9] || 0)
    },
    [gl, pendingView, pendingProj],
  )

  /**
   * Worker の結果が届いた時点で、その画像を描いた視点（= 最後に送った視点）を
   * 「確定」に移す。結果待ちの間は新しい送信が無いので、この時点の保留が
   * 結果の視点と一致する（useGpuWorker の onFrameResult から呼ばれる）。
   */
  const handleFrameResult = useCallback(() => {
    frozenView[0].copy(pendingView[0])
    frozenView[1].copy(pendingView[1])
    frozenProj[0].copy(pendingProj[0])
    frozenProj[1].copy(pendingProj[1])
  }, [pendingView, pendingProj, frozenView, frozenProj])

  /** 新しい画像が届いたら、確定済みの視点を「表示中の姿勢」に昇格する */
  const promotePoseIfNewFrame = useCallback(
    (image: unknown) => {
      if (!image || image === lastImage.current) return
      lastImage.current = image
      prevView[0].copy(frozenView[0])
      prevView[1].copy(frozenView[1])
      prevProj[0].copy(frozenProj[0])
      prevProj[1].copy(frozenProj[1])
      hasPrev.current = true
    },
    [frozenView, frozenProj, prevView, prevProj],
  )

  /** 視点を解決する。record = true のとき「描画時の姿勢」も記録する */
  const resolveCameras = useCallback(
    (state: RootState, record: boolean): Camera[] => {
      // XR 中はブラウザが用意した目のカメラをそのまま使う。
      // 画像は目ごとのビューポートいっぱいに貼るので、射影行列も目のものを使う。
      const xrCamera = gl.xr.isPresenting ? (gl.xr.getCamera() as ArrayCamera) : null
      if (xrCamera && xrCamera.cameras.length >= 2) {
        const eyes = xrCamera.cameras as Camera[]

        // 目を判定するための基準点（両目の中間）
        headPosition
          .setFromMatrixPosition(eyes[0].matrixWorld)
          .add(tmpVector.setFromMatrixPosition(eyes[1].matrixWorld))
          .multiplyScalar(0.5)

        if (record) eyes.forEach((eye, index) => recordPose(eye, index))
        return eyes
      }

      const main = state.camera as Camera

      if (!stereo) {
        headPosition.setFromMatrixPosition(main.matrixWorld)
        if (record) recordPose(main, 0)
        return [main]
      }

      // モニタ確認用の SBS: メインカメラを左右にずらす（画角はそのまま）
      rightVector.setFromMatrixColumn(main.matrixWorld, 0).normalize()
      const center = tmpVector.setFromMatrixPosition(main.matrixWorld)

      eyeCameras.forEach((eye, index) => {
        eye.copy(main)
        eye.position
          .copy(center)
          .addScaledVector(rightVector, index === 0 ? -eyeSeparation / 2 : eyeSeparation / 2)
        eye.updateMatrixWorld()
        if (record) recordPose(eye, index)
      })

      headPosition.copy(center)
      return eyeCameras
    },
    [gl, stereo, eyeSeparation, eyeCameras, headPosition, rightVector, tmpVector, recordPose],
  )

  const getViewCameras = useCallback(
    (state: RootState): Camera[] => resolveCameras(state, true),
    [resolveCameras],
  )

  const { colorTexture, hasFrame } = useGpuWorker({
    worker,
    workerData,
    width: resolution.width,
    height: resolution.height,
    maxFps,
    enabled,
    getViewCameras,
    onFrameResult: handleFrameResult,
    onReady,
    onError,
    debug,
    profile,
    onStats,
    transfer,
  })

  // --- 背景の板ポリ ---------------------------------------------------------
  const backdropRef = useRef<Mesh>(null)
  const geometry = useMemo(() => new PlaneGeometry(2, 2), [])

  const material = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: {
          uColor: { value: null },
          uEyeCount: { value: 1 },
          uPerEye: { value: 0 },
          uReproject: { value: 0 },
          uEasu: { value: 0 },
          uEyeTexel: { value: new Vector2(1 / 640, 1 / 640) },
          uHeadPosition: { value: new Vector3() },
          uPrevView0: { value: new Matrix4() },
          uPrevView1: { value: new Matrix4() },
          uPrevProj0: { value: new Vector4(1, 1, 0, 0) },
          uPrevProj1: { value: new Vector4(1, 1, 0, 0) },
          uCurProj0: { value: new Vector4(1, 1, 0, 0) },
          uCurProj1: { value: new Vector4(1, 1, 0, 0) },
        },
        vertexShader,
        fragmentShader,
        depthTest: false,
        depthWrite: false,
        side: DoubleSide,
        toneMapped: false,
      }),
    [],
  )

  useEffect(() => {
    return () => {
      geometry.dispose()
      material.dispose()
    }
  }, [geometry, material])

  useEffect(() => {
    // three は `xr.enabled` が true でないと、セッション中でも XR 用の描画に切り替えない。
    // セッションの生成（Enter VR）はホスト側の仕事なので、ここでは許可だけしておく。
    gl.xr.enabled = true
  }, [gl])

  useFrame((state) => {
    const mesh = backdropRef.current
    if (!mesh) return

    const visible = enabled && hasFrame
    mesh.visible = visible
    if (!visible) return

    // テクスチャが更新されていれば、確定済みの視点を「表示中の姿勢」に昇格
    promotePoseIfNewFrame(colorTexture?.image)

    // 視点を更新（headPosition もここで更新される）
    const cameras = resolveCameras(state, false)
    const presenting = gl.xr.isPresenting
    const eyeMode = presenting && cameras.length >= 2

    // XR に入ったら、目のアスペクトで Worker の解像度を合わせ直す
    if (eyeMode) {
      const projection = cameras[0].projectionMatrix.elements
      const aspect = projection[5] / projection[0]
      if (xrAspect === null || Math.abs(aspect - xrAspect) > 0.01) setXrAspect(aspect)
    } else if (xrAspect !== null) {
      setXrAspect(null)
    }

    const u = material.uniforms
    u.uColor.value = colorTexture
    u.uEyeCount.value = cameras.length
    u.uPerEye.value = eyeMode ? 1 : 0
    // 再投影するのは「XR かつ 描画時の姿勢が確定済み」のときだけ
    u.uReproject.value = eyeMode && reproject && hasPrev.current ? 1 : 0
    // 拡大は常に XR のときだけ（モニタではほぼ 1:1 なので 12 タップの意味がない）
    u.uEasu.value = eyeMode && upscale ? 1 : 0
    u.uEyeTexel.value.set(1 / Math.max(1, resolution.width), 1 / Math.max(1, resolution.height))
    ;(u.uHeadPosition.value as Vector3).copy(headPosition)
    ;(u.uPrevView0.value as Matrix4).copy(prevView[0])
    ;(u.uPrevView1.value as Matrix4).copy(prevView[1])
    ;(u.uPrevProj0.value as Vector4).copy(prevProj[0])
    ;(u.uPrevProj1.value as Vector4).copy(prevProj[1])
    writeProj(u.uCurProj0.value as Vector4, cameras[0])
    writeProj(u.uCurProj1.value as Vector4, cameras[Math.min(1, cameras.length - 1)])
  })

  return (
    <mesh
      ref={backdropRef}
      geometry={geometry}
      material={material}
      frustumCulled={false}
      renderOrder={BACKDROP_RENDER_ORDER}
    />
  )
}

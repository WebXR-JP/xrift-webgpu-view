/**
 * メインシーンの深度と Worker の深度を比較して、全画面に合成する（実験的）
 *
 * これはライブラリの安定 API ではない。`@webxr-jp/webgpu-view/experimental` からの
 * 直接 import でだけ使える。通常は `GpuBackdrop` を使うこと。
 *
 * 仕組み:
 * 1. メインシーンを HDR のレンダーターゲット（色 + DepthTexture）へ描く
 * 2. 全画面クアッドで「シーン色」と「Worker の色」をピクセルごとに選択する
 *    - シーンの深度 → 視点からの距離に変換
 *    - Worker の深度画像（R,G に 16bit でパックされた距離）を復号
 *    - Worker の距離の方が近ければ Worker の色を採用
 * 3. シーン色は RT 由来でリニア + トーンマップ前なので、ここでレンダラと
 *    同じトーンマップ + sRGB エンコードを適用する
 *
 * WebGL2 には gl_FragDepth が無いため、深度を「書く」のではなく
 * 深度を比較して色を選ぶ方式にしている。
 *
 * **XR では動かない。** WebXR のフレームバッファはブラウザが所有しており、
 * メインシーンを自分の RT に描いてから目ごとに合成する経路が無い。
 * XR 中は Worker を出さずに通常描画へフォールバックする。
 */

import { useFrame, useThree } from '@react-three/fiber'
import type { RootState } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  ACESFilmicToneMapping,
  ArrayCamera,
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  LinearToneMapping,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderTarget,
} from 'three'
import { useGpuWorker } from '../useGpuWorker'
import type { WorkerConstructor } from '../useGpuWorker'

/** Worker 側の深度パック範囲（worker/defineGpuWorker.ts の DEPTH_RANGE と合わせる） */
const DEPTH_RANGE = 50
/** ステレオ確認用の眼間距離の半分（メートル） */
const EYE_OFFSET = 0.032

const vertexShader = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

/** three.js の ACESFilmicToneMapping と同じ実装（合成側で使う） */
const TONE_MAPPING_CHUNK = /* glsl */ `
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesFilmic(vec3 color) {
  const mat3 ACESInputMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777)
  );
  const mat3 ACESOutputMat = mat3(
    vec3(1.60475, -0.10208, -0.00327),
    vec3(-0.53108, 1.10813, -0.07276),
    vec3(-0.07367, -0.00605, 1.07602)
  );
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}

vec3 linearToSRGB(vec3 color) {
  return mix(
    pow(color, vec3(0.41666)) * 1.055 - 0.055,
    color * 12.92,
    vec3(lessThanEqual(color, vec3(0.0031308)))
  );
}
`

const fragmentShader = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform sampler2D uWorkerColor;
uniform sampler2D uWorkerDepth;

uniform float uNear;
uniform float uFar;
uniform float uDepthRange;
uniform float uExposure;
uniform float uWorkerExposure;
uniform float uEyeCount;
uniform int uToneMapping;
uniform int uDebug;

${TONE_MAPPING_CHUNK}

// R,G に詰めた 16bit 距離を [0,1] に戻す
float unpackDepth(vec2 bytes) {
  float hi = floor(bytes.r * 255.0 + 0.5);
  float lo = floor(bytes.g * 255.0 + 0.5);
  return (hi * 256.0 + lo) / 65535.0;
}

void main() {
  // ステレオのときは画面を左右に分け、それぞれの視点の画像を引く
  float eye = 0.0;
  vec2 uv = vUv;
  if (uEyeCount > 1.5) {
    eye = step(0.5, vUv.x);
    uv.x = fract(vUv.x * 2.0);
  }

  vec2 sceneUv = vec2((eye + uv.x) / uEyeCount, vUv.y);
  // Worker の画像は上下反転で入っているので V を反転して引く
  vec2 workerUv = vec2((eye + uv.x) / uEyeCount, 1.0 - vUv.y);

  // シーンの深度（window z）→ 視点からの距離
  float depth = texture2D(uSceneDepth, sceneUv).x;
  float sceneDist = -(uNear * uFar) / ((uFar - uNear) * depth - uFar);

  float packedDepth = unpackDepth(texture2D(uWorkerDepth, workerUv).rg);
  float workerDist = packedDepth <= 0.0 ? 1e9 : packedDepth * uDepthRange;

  if (uDebug == 5) {
    // アトラス全体（目の分割なし）を表示
    gl_FragColor = vec4(texture2D(uWorkerColor, vec2(vUv.x, 1.0 - vUv.y)).rgb, 1.0);
    return;
  }

  if (uDebug == 4) {
    // どちらを採用したかのマスク（緑 = Worker / 赤 = シーン）
    bool useWorker = workerDist < sceneDist;
    gl_FragColor = vec4(useWorker ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), 1.0);
    return;
  }

  if (uDebug == 3) {
    // Worker の色だけを表示（合成の色処理を確認するため）
    gl_FragColor = vec4(texture2D(uWorkerColor, workerUv).rgb, 1.0);
    return;
  }

  if (uDebug == 2) {
    // パックしたバイトをそのまま可視化（R = 上位, G = 下位）
    gl_FragColor = vec4(texture2D(uWorkerDepth, workerUv).rg, 0.0, 1.0);
    return;
  }

  if (uDebug == 1) {
    // 深度パックの確認用
    float t = packedDepth <= 0.0 ? 1.0 : packedDepth;
    gl_FragColor = vec4(vec3(t), 1.0);
    return;
  }

  if (workerDist < sceneDist) {
    // Worker はトーンマップ無しのリニア値を sRGB で出力している。
    // sRGB テクスチャはサンプル時にハードウェアでリニアへ戻るので、
    // ここでは ACES とエンコードだけを行う
    vec3 workerColor = texture2D(uWorkerColor, workerUv).rgb;
    workerColor = acesFilmic(workerColor * (uWorkerExposure / 0.6));
    gl_FragColor = vec4(linearToSRGB(workerColor), 1.0);
    return;
  }

  // シーン色はリニアなので、レンダラと同じ変換をここで行う
  vec3 color = texture2D(uSceneColor, sceneUv).rgb;
  if (uToneMapping == 4) {
    color = acesFilmic(color * (uExposure / 0.6));
  } else if (uToneMapping == 1) {
    color = clamp(color * uExposure, 0.0, 1.0);
  }
  gl_FragColor = vec4(linearToSRGB(color), 1.0);
}
`

export interface DepthCompositeProps {
  /** `import MyWorker from './my.worker.ts?worker'` の既定エクスポート */
  worker: WorkerConstructor
  /** Worker の起動時に 1 回だけ渡す任意のデータ */
  workerData?: unknown
  enabled?: boolean
  /** 左右 2 視点で描く（モニタでは左右に並べて表示される） */
  stereo?: boolean
  /** Worker 側の描画解像度の上限（1 視点ぶんの横幅 px） */
  maxWidth?: number
  /** 解像度スケール（devicePixelRatio に掛ける） */
  resolutionScale?: number
  maxFps?: number
  /**
   * デバッグ表示
   * 0: 通常 / 1: パック深度を距離として可視化 / 2: パックした生バイト
   * 3: Worker の色のみ / 4: 採用マスク（緑 = Worker, 赤 = シーン）/ 5: アトラス全体
   */
  debug?: 0 | 1 | 2 | 3 | 4 | 5
}

export const DepthComposite: React.FC<DepthCompositeProps> = ({
  worker,
  workerData,
  enabled = true,
  stereo = false,
  maxWidth = 1280,
  resolutionScale = 1,
  maxFps = 60,
  debug = 0,
}) => {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera) as PerspectiveCamera
  const size = useThree((state) => state.size)
  const dpr = useThree((state) => state.viewport.dpr)

  const eyeCount = stereo ? 2 : 1

  // --- メインシーンを描く HDR ターゲット -----------------------------------
  const target = useMemo(() => {
    const width = Math.max(1, Math.floor(size.width * dpr))
    const height = Math.max(1, Math.floor(size.height * dpr))
    return new WebGLRenderTarget(width, height, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: true,
      depthTexture: new DepthTexture(width, height),
      stencilBuffer: false,
      samples: 4,
    })
  }, [size.width, size.height, dpr])

  useEffect(() => {
    return () => target.dispose()
  }, [target])

  // --- 視点（カメラ）--------------------------------------------------------
  const eyeCameras = useMemo(() => [new PerspectiveCamera(), new PerspectiveCamera()], [])
  const renderCamerasRef = useRef<PerspectiveCamera[]>([camera])
  const rightVector = useMemo(() => new Vector3(), [])

  /** このフレームの視点カメラを返す（Worker へ送るのと、メインシーンの描画で同じものを使う） */
  const getViewCameras = useCallback(
    (state: RootState): PerspectiveCamera[] => {
      // XR 中はブラウザが用意した目のカメラを使う（合成自体は XR では行わない）
      const xrCamera = gl.xr.isPresenting ? (gl.xr.getCamera() as ArrayCamera) : null
      if (xrCamera && xrCamera.cameras.length >= 2) {
        const eyes = [xrCamera.cameras[0] as PerspectiveCamera, xrCamera.cameras[1] as PerspectiveCamera]
        renderCamerasRef.current = eyes
        return eyes
      }

      const main = state.camera as PerspectiveCamera

      if (eyeCount === 1) {
        renderCamerasRef.current = [main]
        return [main]
      }

      // モニタ確認用のステレオ: メインカメラを左右にずらす（画角はそのまま）
      rightVector.setFromMatrixColumn(main.matrixWorld, 0).normalize()
      eyeCameras.forEach((eye, index) => {
        eye.copy(main)
        eye.position.copy(main.position).addScaledVector(rightVector, index === 0 ? -EYE_OFFSET : EYE_OFFSET)
        eye.updateMatrixWorld()
      })
      renderCamerasRef.current = eyeCameras
      return eyeCameras
    },
    [gl, eyeCount, eyeCameras, rightVector],
  )

  // --- Worker の解像度（1 視点あたり） --------------------------------------
  const resolution = useMemo(() => {
    // 幅が 0 のときに高さが Infinity にならないようにする
    const aspect = size.width > 0 && size.height > 0 ? size.height / size.width : 1
    const totalWidth = size.width * dpr * resolutionScale
    const width = Math.max(64, Math.min(maxWidth, Math.round(totalWidth / eyeCount)))
    return { width, height: Math.max(1, Math.round(width * aspect)) }
  }, [size.width, size.height, dpr, maxWidth, resolutionScale, eyeCount])

  const { colorTexture, depthTexture, hasFrame } = useGpuWorker({
    worker,
    workerData,
    width: resolution.width,
    height: resolution.height,
    internalDepth: true,
    maxFps,
    enabled,
    getViewCameras,
  })

  // --- 合成パス ------------------------------------------------------------
  const composite = useMemo(() => {
    const material = new ShaderMaterial({
      uniforms: {
        uSceneColor: { value: null },
        uSceneDepth: { value: null },
        uWorkerColor: { value: null },
        uWorkerDepth: { value: null },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uDepthRange: { value: DEPTH_RANGE },
        uExposure: { value: 1 },
        uWorkerExposure: { value: 1.15 },
        uEyeCount: { value: 1 },
        uToneMapping: { value: 0 },
        uDebug: { value: 0 },
      },
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })

    const geometry = new PlaneGeometry(2, 2)
    const mesh = new Mesh(geometry, material)
    mesh.frustumCulled = false

    const quadScene = new Scene()
    quadScene.add(mesh)

    return { material, geometry, scene: quadScene, camera: new OrthographicCamera(-1, 1, 1, -1, 0, 1) }
  }, [])

  useEffect(() => {
    return () => {
      composite.geometry.dispose()
      composite.material.dispose()
    }
  }, [composite])

  useFrame(() => {
    if (!enabled) return

    // XR 中はブラウザ所有のフレームバッファに合成できないので通常描画
    if (gl.xr.isPresenting) {
      gl.render(scene, camera)
      return
    }

    // Worker の出力がまだ無いときは通常描画にフォールバック
    if (!hasFrame || !depthTexture) {
      gl.render(scene, camera)
      return
    }

    const uniforms = composite.material.uniforms
    uniforms.uSceneColor.value = target.texture
    uniforms.uSceneDepth.value = target.depthTexture
    uniforms.uWorkerColor.value = colorTexture
    uniforms.uWorkerDepth.value = depthTexture
    uniforms.uNear.value = camera.near
    uniforms.uFar.value = camera.far
    uniforms.uExposure.value = gl.toneMappingExposure
    uniforms.uEyeCount.value = eyeCount
    uniforms.uToneMapping.value =
      gl.toneMapping === ACESFilmicToneMapping ? 4 : gl.toneMapping === LinearToneMapping ? 1 : 0
    uniforms.uDebug.value = debug

    // メインシーンを視点ごとに描く（RT を横に分割）
    // 注意: three の setViewport / setScissor は CSS ピクセル指定で、
    // 内部で pixelRatio が掛かる（フレームバッファの実ピクセルではない）
    const logicalWidth = size.width
    const logicalHeight = size.height
    const eyeWidth = logicalWidth / eyeCount
    const cameras = renderCamerasRef.current

    gl.setRenderTarget(target)
    for (let i = 0; i < eyeCount; i++) {
      gl.setViewport(i * eyeWidth, 0, eyeWidth, logicalHeight)
      gl.setScissor(i * eyeWidth, 0, eyeWidth, logicalHeight)
      gl.setScissorTest(true)
      gl.render(scene, cameras[i] ?? camera)
    }
    gl.setScissorTest(false)
    gl.setViewport(0, 0, logicalWidth, logicalHeight)
    gl.setRenderTarget(null)

    gl.render(composite.scene, composite.camera)
  }, enabled ? 1 : 0)

  return null
}

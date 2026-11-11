/**
 * Worker の WebGPU 描画を、メインキャンバスの「背景」として全画面に出す。
 *
 * Skybox の置き換えを想定している。
 * - 画面全体を覆うスクリーン空間の板ポリを、シーンより先に描く
 *   （`renderOrder` を下げ、深度テスト・深度書き込みを無効にする）
 * - メインシーンのオブジェクトは通常どおりその上に描かれる
 * - カメラに追従するので、背景として視差は出ない
 *
 * XR では three が 1 回の `render()` で両目を描く。板ポリは目ごとのビューポートを
 * そのまま覆い、シェーダが「どちらの目から描いているか」を見てアトラスの左右を選ぶ。
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
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three'
import { useGpuWorker } from './useGpuWorker'
import type { GpuWorkerReadyInfo, WorkerConstructor } from './useGpuWorker'

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
 */
const fragmentShader = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform sampler2D uColor;
uniform float uEyeCount;
uniform float uPerEye;
uniform vec3 uHeadPosition;

vec3 linearToSRGB(vec3 color) {
  return mix(
    pow(color, vec3(0.41666)) * 1.055 - 0.055,
    color * 12.92,
    vec3(lessThanEqual(color, vec3(0.0031308)))
  );
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);

  if (uPerEye > 0.5) {
    // view 行列の 1 行目がカメラの右方向（ワールド空間）
    vec3 right = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
    float side = dot(cameraPosition - uHeadPosition, right);
    float eye = step(0.0, side);
    uv.x = (eye + uv.x) / uEyeCount;
  }

  gl_FragColor = vec4(linearToSRGB(texture2D(uColor, uv).rgb), 1.0);
}
`

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
  onReady?: (info: GpuWorkerReadyInfo) => void
  onError?: (message: string) => void
  /** コンソールに ready / fps を出す */
  debug?: boolean
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
  onReady,
  onError,
  debug = false,
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

  const getViewCameras = useCallback(
    (state: RootState): PerspectiveCamera[] => {
      // XR 中はブラウザが用意した目のカメラをそのまま使う。
      // 画像は目ごとのビューポートいっぱいに貼るので、射影行列も目のものを使う。
      const xrCamera = gl.xr.isPresenting ? (gl.xr.getCamera() as ArrayCamera) : null
      if (xrCamera && xrCamera.cameras.length >= 2) {
        const eyes = xrCamera.cameras as PerspectiveCamera[]

        // 目を判定するための基準点（両目の中間）
        headPosition
          .setFromMatrixPosition(eyes[0].matrixWorld)
          .add(tmpVector.setFromMatrixPosition(eyes[1].matrixWorld))
          .multiplyScalar(0.5)

        return eyes
      }

      const main = state.camera as PerspectiveCamera

      if (!stereo) {
        headPosition.setFromMatrixPosition(main.matrixWorld)
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
      })

      headPosition.copy(center)
      return eyeCameras
    },
    [gl, stereo, eyeSeparation, eyeCameras, headPosition, rightVector, tmpVector],
  )

  const { colorTexture, hasFrame } = useGpuWorker({
    worker,
    workerData,
    width: resolution.width,
    height: resolution.height,
    maxFps,
    enabled,
    getViewCameras,
    onReady,
    onError,
    debug,
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
          uHeadPosition: { value: new Vector3() },
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

    // 視点を更新（headPosition もここで更新される）
    const cameras = getViewCameras(state)
    const presenting = gl.xr.isPresenting

    // XR に入ったら、目のアスペクトで Worker の解像度を合わせ直す
    if (presenting && cameras.length >= 2) {
      const projection = cameras[0].projectionMatrix.elements
      const aspect = projection[5] / projection[0]
      if (xrAspect === null || Math.abs(aspect - xrAspect) > 0.01) setXrAspect(aspect)
    } else if (xrAspect !== null) {
      setXrAspect(null)
    }

    material.uniforms.uColor.value = colorTexture
    material.uniforms.uEyeCount.value = cameras.length
    material.uniforms.uPerEye.value = presenting && cameras.length >= 2 ? 1 : 0
    ;(material.uniforms.uHeadPosition.value as Vector3).copy(headPosition)
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

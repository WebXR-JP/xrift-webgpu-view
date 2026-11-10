/**
 * Worker の WebGPU 描画を、カメラに追従するスクリーンとしてメインキャンバスに出す。
 *
 * - 通常（モニタ）: カメラの視錐台に合わせた板ポリ 1 枚に貼る。
 *   `coverage` を 1 にすると画面いっぱい、小さくするとパネルになる。
 * - XR: ヘッドの少し前に板ポリを置き、シェーダが「どちらの目から描いているか」を
 *   見てアトラスの左右を選ぶ。3D の遮蔽はしないが、両眼で正しいステレオになる。
 *
 * 深度合成はしない（experimental/DepthComposite を参照）。
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
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three'
import type { Matrix4 } from 'three'
import { getFrustumRect } from './frustum'
import type { ViewAnchor } from './frustum'
import { useGpuWorker } from './useGpuWorker'
import type { GpuWorkerReadyInfo, WorkerConstructor } from './useGpuWorker'

const vertexShader = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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

export interface GpuWorkerViewProps {
  /** `import MyWorker from './my.worker.ts?worker'` の既定エクスポート */
  worker: WorkerConstructor
  /** Worker の起動時に 1 回だけ渡す任意のデータ */
  workerData?: unknown
  /** 画面に対する大きさ（1 = 視錐台いっぱい、0.6 = 画面の 60%） */
  coverage?: number
  anchor?: ViewAnchor
  /** 画面端からの余白（NDC 単位。1 で画面の半分） */
  margin?: number
  /** カメラからの距離（m）。大きさは coverage で決まるので通常は触らない */
  distance?: number
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
  /** シーンの手前の物で隠す（既定 false = 常に手前） */
  depthTest?: boolean
  onReady?: (info: GpuWorkerReadyInfo) => void
  onError?: (message: string) => void
  /** コンソールに ready / fps を出す */
  debug?: boolean
}

export const GpuWorkerView: React.FC<GpuWorkerViewProps> = ({
  worker,
  workerData,
  coverage = 0.6,
  anchor = 'center',
  margin = 0.03,
  distance = 1,
  maxWidth = 1280,
  resolutionScale = 1,
  maxFps = 60,
  enabled = true,
  stereo = false,
  eyeSeparation = 0.064,
  depthTest = false,
  onReady,
  onError,
  debug = false,
}) => {
  const gl = useThree((state) => state.gl)
  const size = useThree((state) => state.size)
  const dpr = useThree((state) => state.viewport.dpr)

  /** XR 中のアスペクト（XR に入るまで null） */
  const [xrAspect, setXrAspect] = useState<number | null>(null)

  const eyeCount = xrAspect !== null ? 2 : stereo ? 2 : 1
  const displayAspect = size.width / Math.max(1, size.height)
  const imageAspect = xrAspect ?? displayAspect

  // --- Worker 側の解像度（1 視点ぶん） --------------------------------------
  const resolution = useMemo(() => {
    const width = Math.max(
      64,
      Math.min(maxWidth, Math.round((size.width * dpr * resolutionScale) / eyeCount)),
    )
    return { width, height: Math.max(1, Math.round(width / imageAspect)) }
  }, [size.width, dpr, resolutionScale, maxWidth, eyeCount, imageAspect])

  // --- 視点（カメラ）--------------------------------------------------------
  const eyeCameras = useMemo(() => [new PerspectiveCamera(), new PerspectiveCamera()], [])
  const headPosition = useMemo(() => new Vector3(), [])
  const rightVector = useMemo(() => new Vector3(), [])
  const tmpVector = useMemo(() => new Vector3(), [])

  const getViewCameras = useCallback(
    (state: RootState): PerspectiveCamera[] => {
      // XR 中はブラウザが用意した目のカメラを使う。
      // 描画は「目の位置 + 左右共通の射影行列（union）」にそろえる。
      // こうすると各目の画像を同じ板ポリに貼れて、視差は目の位置だけで付く。
      const xrCamera = gl.xr.isPresenting ? (gl.xr.getCamera() as ArrayCamera) : null
      if (xrCamera && xrCamera.cameras.length >= 2) {
        const eyes = xrCamera.cameras as PerspectiveCamera[]
        const projection = xrCamera.projectionMatrix

        eyeCameras.forEach((eye, index) => {
          const source = eyes[index]
          eye.position.copy(source.position)
          eye.quaternion.copy(source.quaternion)
          eye.scale.copy(source.scale)
          eye.projectionMatrix.copy(projection)
          eye.projectionMatrixInverse.copy(projection).invert()
          eye.near = source.near
          eye.far = source.far
          eye.fov = source.fov
          eye.aspect = source.aspect
          eye.updateMatrixWorld()
        })

        headPosition
          .setFromMatrixPosition(eyes[0].matrixWorld)
          .add(tmpVector.setFromMatrixPosition(eyes[1].matrixWorld))
          .multiplyScalar(0.5)

        return eyeCameras
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

  // --- スクリーン -----------------------------------------------------------
  const screenRef = useRef<Mesh>(null)
  const geometry = useMemo(() => new PlaneGeometry(1, 1), [])

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
        depthTest,
        depthWrite: false,
        side: DoubleSide,
        toneMapped: false,
      }),
    [depthTest],
  )

  useEffect(() => {
    return () => {
      geometry.dispose()
      material.dispose()
    }
  }, [geometry, material])

  const screenPosition = useMemo(() => new Vector3(), [])
  const screenQuaternion = useMemo(() => new Quaternion(), [])
  const sourcePosition = useMemo(() => new Vector3(), [])

  useFrame((state) => {
    const mesh = screenRef.current
    if (!mesh) return

    const visible = enabled && hasFrame
    mesh.visible = visible

    const presenting = gl.xr.isPresenting
    const xrCamera = presenting ? (gl.xr.getCamera() as ArrayCamera) : null
    const xrEyes = xrCamera && xrCamera.cameras.length >= 2 ? xrCamera : null

    // XR に入ったら、実際の目のアスペクトで Worker の解像度を合わせ直す
    if (xrEyes) {
      const projection = xrEyes.projectionMatrix.elements
      const aspect = projection[5] / projection[0]
      if (xrAspect === null || Math.abs(aspect - xrAspect) > 0.01) setXrAspect(aspect)
    } else if (xrAspect !== null) {
      setXrAspect(null)
    }

    if (!visible) return

    // 視点を更新（headPosition もここで更新される）
    const cameras = getViewCameras(state)

    let projection: Matrix4
    let position: Vector3
    let quaternion: Quaternion

    if (xrEyes) {
      // スクリーンは両目の中間に置く（視差は目の位置から自然に付く）
      projection = xrEyes.projectionMatrix
      position = headPosition
      quaternion = screenQuaternion.setFromRotationMatrix(xrEyes.matrixWorld)
    } else {
      const camera = cameras[0] ?? (state.camera as PerspectiveCamera)
      camera.updateMatrixWorld()
      projection = camera.projectionMatrix
      position = sourcePosition.setFromMatrixPosition(camera.matrixWorld)
      quaternion = screenQuaternion.setFromRotationMatrix(camera.matrixWorld)
    }

    const rect = getFrustumRect(projection, { distance, coverage, anchor, margin })
    screenPosition.set(rect.x, rect.y, -distance).applyQuaternion(quaternion).add(position)

    mesh.position.copy(screenPosition)
    mesh.quaternion.copy(quaternion)
    mesh.scale.set(rect.width, rect.height, 1)

    const viewCount = cameras.length
    material.uniforms.uColor.value = colorTexture
    material.uniforms.uEyeCount.value = viewCount
    material.uniforms.uPerEye.value = xrEyes && viewCount >= 2 ? 1 : 0
    ;(material.uniforms.uHeadPosition.value as Vector3).copy(headPosition)
  })

  return <mesh ref={screenRef} geometry={geometry} material={material} frustumCulled={false} renderOrder={1000} />
}

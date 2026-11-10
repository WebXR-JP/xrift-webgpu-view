/**
 * Worker で WebGPU 描画した結果をメインキャンバスへ投影するパネル
 *
 * カメラの行列は useGpuWorker が毎フレーム Worker へ送る。ここでは返ってきた
 * テクスチャをカメラ追従の板ポリに貼るだけ（深度合成はしない）。
 */

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { Mesh, PerspectiveCamera, PlaneGeometry, Vector3 } from 'three'
import { useGpuWorker } from '../../gpu-worker/useGpuWorker'

export type PanelAnchor = 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export interface WorkerRenderPanelProps {
  /** 画面に対するパネルの大きさ（0〜1） */
  coverage?: number
  anchor?: PanelAnchor
  /** 画面端からの余白（NDC 単位。1 で画面の半分） */
  margin?: number
  /** カメラからの距離。見た目の大きさは coverage で決まるので通常は触らない */
  distance?: number
  /** Worker 側の描画解像度の上限（横幅 px） */
  maxWidth?: number
  /** 解像度スケール（devicePixelRatio に掛ける） */
  resolutionScale?: number
  /** Worker を描画する最大頻度 */
  maxFps?: number
  enabled?: boolean
}

/** 板ポリの UV を上下反転する（ImageBitmap は flipY が効かないため） */
function createPanelGeometry() {
  const geometry = new PlaneGeometry(1, 1)
  const uv = geometry.getAttribute('uv')
  for (let i = 0; i < uv.count; i++) {
    uv.setY(i, 1 - uv.getY(i))
  }
  uv.needsUpdate = true
  return geometry
}

function anchorToNdc(anchor: PanelAnchor, coverage: number, margin: number): [number, number] {
  const edge = 1 - coverage - margin
  switch (anchor) {
    case 'top-left':
      return [-edge, edge]
    case 'top-right':
      return [edge, edge]
    case 'bottom-left':
      return [-edge, -edge]
    case 'bottom-right':
      return [edge, -edge]
    default:
      return [0, 0]
  }
}

export const WorkerRenderPanel: React.FC<WorkerRenderPanelProps> = ({
  coverage = 0.55,
  anchor = 'bottom-right',
  margin = 0.03,
  distance = 1,
  maxWidth = 1280,
  resolutionScale = 1,
  maxFps = 60,
  enabled = true,
}) => {
  const size = useThree((state) => state.size)
  const pixelRatio = useMemo(
    () => (typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2)),
    [],
  )

  const frameRef = useRef<Mesh>(null)
  const panelRef = useRef<Mesh>(null)

  // --- 解像度（Worker 側の描画サイズ） -------------------------------------
  const resolution = useMemo(() => {
    const aspect = size.height > 0 ? size.height / size.width : 1
    const width = Math.max(64, Math.min(maxWidth, Math.round(size.width * coverage * pixelRatio * resolutionScale)))
    return { width, height: Math.max(1, Math.round(width * aspect)) }
  }, [size.width, size.height, coverage, pixelRatio, resolutionScale, maxWidth])

  const { colorTexture, hasFrame } = useGpuWorker({
    width: resolution.width,
    height: resolution.height,
    maxFps,
    enabled,
  })

  const geometry = useMemo(() => createPanelGeometry(), [])

  useEffect(() => {
    return () => {
      geometry.dispose()
    }
  }, [geometry])

  const worldPosition = useMemo(() => new Vector3(), [])

  useFrame((state) => {
    const camera = state.camera as PerspectiveCamera
    const panel = panelRef.current
    const border = frameRef.current
    if (!panel) return

    if (camera.isPerspectiveCamera) {
      const projection = camera.projectionMatrix.elements
      const halfHeight = distance / projection[5]
      const halfWidth = distance / projection[0]
      const width = 2 * halfWidth * coverage
      const height = 2 * halfHeight * coverage

      const [ndcX, ndcY] = anchorToNdc(anchor, coverage, margin)

      worldPosition
        .set(ndcX * halfWidth, ndcY * halfHeight, -distance)
        .applyQuaternion(camera.quaternion)
        .add(camera.position)

      panel.scale.set(width, height, 1)
      panel.quaternion.copy(camera.quaternion)
      panel.position.copy(worldPosition)

      if (border) {
        border.scale.set(width * 1.02, height * 1.02, 1)
        border.quaternion.copy(camera.quaternion)
        border.position.copy(worldPosition)
      }
    }
  })

  return (
    <group visible={hasFrame && enabled}>
      {/* 縁（見やすさのための枠） */}
      <mesh ref={frameRef} geometry={geometry} frustumCulled={false} renderOrder={999}>
        <meshBasicMaterial color={0x0a0c11} depthTest={false} depthWrite={false} toneMapped={false} fog={false} />
      </mesh>
      <mesh ref={panelRef} geometry={geometry} frustumCulled={false} renderOrder={1000}>
        <meshBasicMaterial map={colorTexture} depthTest={false} depthWrite={false} toneMapped={false} fog={false} />
      </mesh>
    </group>
  )
}

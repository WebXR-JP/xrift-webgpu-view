/**
 * Worker で WebGPU 描画した結果をメインキャンバスへ投影するパネル
 *
 * 1. Worker に「メインシーンのカメラ行列」を毎フレーム送る
 * 2. Worker は同じ視点で WebGPURenderer によりコーネルボックス + GPU パーティクルを描画
 * 3. `transferToImageBitmap()` の結果を ImageBitmap として受け取り、テクスチャ化
 * 4. メインの WebGLRenderer でカメラ追従の板ポリに貼って描画（= メインキャンバスへの投影）
 */

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  LinearFilter,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  SRGBColorSpace,
  Texture,
  Vector3,
} from 'three'
import type { FrameRequest, WorkerRequest, WorkerResponse } from '../../worker/protocol'

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

  const workerRef = useRef<Worker | null>(null)
  const readyRef = useRef(false)
  const inFlightRef = useRef(false)
  const frameIdRef = useRef(0)
  const lastSentRef = useRef(0)
  const pendingBitmapRef = useRef<ImageBitmap | null>(null)
  const stats = useRef({ frames: 0, renderMs: 0, since: performance.now() })
  const retiredBitmapRef = useRef<ImageBitmap | null>(null)

  const [hasFrame, setHasFrame] = useState(false)

  // --- 解像度（Worker 側の描画サイズ） -------------------------------------
  const resolution = useMemo(() => {
    const aspect = size.height > 0 ? size.height / size.width : 1
    const width = Math.max(64, Math.min(maxWidth, Math.round(size.width * coverage * pixelRatio * resolutionScale)))
    return { width, height: Math.max(1, Math.round(width * aspect)) }
  }, [size.width, size.height, coverage, pixelRatio, resolutionScale, maxWidth])

  const resolutionRef = useRef(resolution)
  resolutionRef.current = resolution

  // --- テクスチャ ----------------------------------------------------------
  const texture = useMemo(() => {
    const tex = new Texture()
    tex.colorSpace = SRGBColorSpace
    // ImageBitmap では flipY が無視されるので、板ポリ側の UV で反転している
    tex.flipY = false
    tex.minFilter = LinearFilter
    tex.magFilter = LinearFilter
    tex.generateMipmaps = false
    return tex
  }, [])

  const geometry = useMemo(() => createPanelGeometry(), [])

  useEffect(() => {
    return () => {
      texture.dispose()
      geometry.dispose()
    }
  }, [texture, geometry])

  // --- Worker 起動 ---------------------------------------------------------
  // 注意: Vite はこの URL をビルド時に `base` 基準の絶対パスへ書き換える。
  // ルート以外（CDN のサブパス等）に配信する場合は base の設定か、
  // `xrift upload` 後に配信 URL からの相対解決が必要になる
  useEffect(() => {
    const worker = new Worker(new URL('../../worker/gpuWorker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    readyRef.current = false

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data

      if (message.type === 'ready') {
        readyRef.current = true
        console.info(
          `[worker-render] ready: ${message.backend} ${message.adapter} / ${message.width}x${message.height} / ${message.particles.toLocaleString()} particles`,
        )
        return
      }

      if (message.type === 'error') {
        readyRef.current = false
        console.error('[worker-render]', message.message)
        return
      }

      inFlightRef.current = false
      stats.current.frames++
      stats.current.renderMs += message.renderMs

      if (stats.current.frames >= 120) {
        const fps = (stats.current.frames * 1000) / (performance.now() - stats.current.since)
        console.info(
          `[worker-render] ${fps.toFixed(1)} fps / ${message.width}x${message.height} / worker render ${(stats.current.renderMs / stats.current.frames).toFixed(2)} ms`,
        )
        stats.current = { frames: 0, renderMs: 0, since: performance.now() }
      }

      // 未反映の bitmap は捨てる（最新のみ表示）
      const previous = pendingBitmapRef.current
      if (previous) previous.close()

      pendingBitmapRef.current = message.bitmap
    }

    worker.onerror = (event) => {
      console.error('[worker-render] worker error:', event.message)
    }

    worker.postMessage({ type: 'init', ...resolutionRef.current } satisfies WorkerRequest)

    return () => {
      workerRef.current = null
      readyRef.current = false
      inFlightRef.current = false
      pendingBitmapRef.current?.close()
      pendingBitmapRef.current = null
      retiredBitmapRef.current?.close()
      retiredBitmapRef.current = null
      worker.terminate()
    }
  }, [])

  // --- リサイズ -----------------------------------------------------------
  useEffect(() => {
    workerRef.current?.postMessage({ type: 'resize', ...resolution } satisfies WorkerRequest)
  }, [resolution])

  // --- 毎フレーム: パネル配置 + カメラ送信 --------------------------------
  const worldPosition = useMemo(() => new Vector3(), [])

  useFrame((state, delta) => {
    const camera = state.camera as PerspectiveCamera
    const panel = panelRef.current
    const border = frameRef.current
    if (!panel) return

    // --- 1. パネルをカメラの正面に置く ---
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

    // --- 2. 受け取った ImageBitmap をテクスチャへ ---
    const bitmap = pendingBitmapRef.current
    if (bitmap) {
      pendingBitmapRef.current = null
      texture.image = bitmap
      texture.needsUpdate = true

      // 前回の bitmap はこのフレームで転送済みなので解放してよい
      retiredBitmapRef.current?.close()
      retiredBitmapRef.current = bitmap

      if (!hasFrame) setHasFrame(true)
    }

    // --- 3. メインのカメラ値を Worker へ送る ---
    if (!enabled || !readyRef.current || inFlightRef.current) return

    const time = state.clock.elapsedTime
    if (time - lastSentRef.current < 1 / maxFps) return
    lastSentRef.current = time

    camera.updateMatrixWorld()

    const message: FrameRequest = {
      type: 'frame',
      id: ++frameIdRef.current,
      time,
      delta: Math.min(delta, 0.1),
      view: Array.from(camera.matrixWorldInverse.elements),
      projection: Array.from(camera.projectionMatrix.elements),
      camera: {
        fov: camera.fov,
        aspect: camera.aspect,
        near: camera.near,
        far: camera.far,
      },
    }

    inFlightRef.current = true
    workerRef.current?.postMessage(message)
  })

  return (
    <group visible={hasFrame && enabled}>
      {/* 縁（見やすさのための枠） */}
      <mesh ref={frameRef} geometry={geometry} frustumCulled={false} renderOrder={999}>
        <meshBasicMaterial color={0x0a0c11} depthTest={false} depthWrite={false} toneMapped={false} fog={false} />
      </mesh>
      <mesh ref={panelRef} geometry={geometry} frustumCulled={false} renderOrder={1000}>
        <meshBasicMaterial map={texture} depthTest={false} depthWrite={false} toneMapped={false} fog={false} />
      </mesh>
    </group>
  )
}

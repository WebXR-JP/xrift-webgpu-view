/**
 * Worker の WebGPU 描画をメインスレッドから使うためのフック
 *
 * - Worker の起動 / init / resize / 破棄
 * - 毎フレーム、視点カメラの行列を送って 1 フレーム 1 リクエストで描かせる
 * - 返ってきた ImageBitmap（色）をテクスチャへ反映する
 *
 * ImageBitmap は WebGL の `UNPACK_FLIP_Y_WEBGL` が効かないため、テクスチャは
 * 上下反転した状態で入る。使う側でサンプリング時に V を反転する。
 */

import { useFrame } from '@react-three/fiber'
import type { RootState } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import { LinearFilter, NearestFilter, PerspectiveCamera, Source, SRGBColorSpace, Texture } from 'three'
import { normalizeDimension } from './protocol'
import type { WorkerResponse } from './protocol'
import type { FrameRequest, ViewMatrices } from './protocol'

/**
 * Worker から結果が返らないまま待つ上限（ms）。
 * これを超えたら「結果待ち」を解除して次のフレームを送り直す。
 * Worker が落ちたり 1 フレームだけ失敗して応答が来なくなっても、
 * 描画が止まったままにならないようにするため。
 */
const FRAME_TIMEOUT_MS = 2000

/** Vite の `?worker` import が返すコンストラクタ */
export type WorkerConstructor = new () => Worker

export interface GpuWorkerReadyInfo {
  /** 1 視点ぶんのサイズ（px） */
  width: number
  height: number
  /** 実行中のバックエンド（基本は 'webgpu'） */
  backend: string
  /** アダプタ情報（取れない環境では空文字） */
  adapter: string
  /** シーン側が返した任意の情報 */
  meta?: Record<string, unknown>
}

export interface UseGpuWorkerOptions {
  /** `import MyWorker from './my.worker.ts?worker'` の既定エクスポート */
  worker: WorkerConstructor
  /**
   * Worker の起動時に 1 回だけ渡す任意のデータ。
   * シーン側では `GpuWorkerInit.data` で受け取る。
   */
  workerData?: unknown
  /** 1 視点ぶんの描画解像度 */
  width: number
  height: number
  /** Worker を描画する最大頻度（既定 60） */
  maxFps?: number
  enabled?: boolean
  /**
   * 視点を返す関数。1 要素なら単眼、2 要素ならステレオ（[0] = 左目, [1] = 右目）。
   * 省略時はメインカメラ 1 視点。
   */
  getViewCameras?: (state: RootState) => PerspectiveCamera[]
  onReady?: (info: GpuWorkerReadyInfo) => void
  onError?: (message: string) => void
  /** コンソールに ready / fps を出す（既定 false） */
  debug?: boolean
  /**
   * 深度画像も受け取る（毎フレーム 2 パス描画になる）。
   * @internal experimental/DepthComposite 専用。
   */
  internalDepth?: boolean
}

export interface UseGpuWorkerResult {
  /** 描画結果（色）。ImageBitmap なので上下が反転している */
  colorTexture: Texture
  /**
   * 距離を R,G に 16bit でパックした画像（internalDepth: true のときのみ）
   * @internal
   */
  depthTexture: Texture | null
  /** 最初のフレームを受け取ったか */
  hasFrame: boolean
  /** 初期化エラー（WebGPU 非対応など） */
  error: string | null
}

function createTexture(nearest: boolean) {
  const texture = new Texture()
  texture.flipY = false
  texture.generateMipmaps = false
  texture.minFilter = nearest ? NearestFilter : LinearFilter
  texture.magFilter = nearest ? NearestFilter : LinearFilter
  if (!nearest) texture.colorSpace = SRGBColorSpace
  return texture
}

/**
 * テクスチャに新しい ImageBitmap を反映する。
 *
 * three は同じ `Source` のまま画像だけ差し替えると、最初に確保した
 * テクスチャ領域のサイズを再利用する。ウィンドウを広げて画像が大きくなると
 * 転送が領域をはみ出して `GL_INVALID_VALUE` になり、**表示が固まったまま**になる
 * （フレームは届いているのにテクスチャが更新されない）。
 * サイズが変わったときだけ `Source` ごと作り直して領域を確保し直す。
 */
function updateTexture(texture: Texture, bitmap: ImageBitmap) {
  const previous = texture.image as ImageBitmap | null
  if (!previous || previous.width !== bitmap.width || previous.height !== bitmap.height) {
    // 古い領域を GL 側で解放してから、新しいサイズで作り直す
    texture.dispose()
    texture.source = new Source(bitmap)
  } else {
    texture.image = bitmap
  }
  texture.needsUpdate = true
}

export function useGpuWorker({
  worker: WorkerClass,
  workerData,
  width,
  height,
  maxFps = 60,
  enabled = true,
  getViewCameras,
  onReady,
  onError,
  debug = false,
  internalDepth = false,
}: UseGpuWorkerOptions): UseGpuWorkerResult {
  const workerRef = useRef<Worker | null>(null)
  const readyRef = useRef(false)
  const inFlightRef = useRef(false)
  /** 最後にフレームを送った時刻（応答待ちのタイムアウト判定用） */
  const sentAtRef = useRef(0)
  const frameIdRef = useRef(0)
  const lastSentRef = useRef(0)
  const lastErrorMessageRef = useRef<string | null>(null)
  const stats = useRef({ frames: 0, renderMs: 0, since: performance.now() })

  const colorPending = useRef<ImageBitmap | null>(null)
  const colorRetired = useRef<ImageBitmap | null>(null)
  const depthPending = useRef<ImageBitmap | null>(null)
  const depthRetired = useRef<ImageBitmap | null>(null)

  const [hasFrame, setHasFrame] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const textures = useMemo(
    () => ({ color: createTexture(false), depth: internalDepth ? createTexture(true) : null }),
    [internalDepth],
  )

  useEffect(() => {
    return () => {
      textures.color.dispose()
      textures.depth?.dispose()
    }
  }, [textures])

  const optionsRef = useRef({ width, height, internalDepth, workerData })
  optionsRef.current = { width, height, internalDepth, workerData }

  const getViewCamerasRef = useRef(getViewCameras)
  getViewCamerasRef.current = getViewCameras

  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady

  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const debugRef = useRef(debug)
  debugRef.current = debug

  // --- Worker 起動 ---------------------------------------------------------
  useEffect(() => {
    const worker = new WorkerClass()
    workerRef.current = worker
    readyRef.current = false
    setHasFrame(false)

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data

      if (message.type === 'ready') {
        readyRef.current = true
        setError(null)
        onReadyRef.current?.({
          width: message.width,
          height: message.height,
          backend: message.backend,
          adapter: message.adapter,
          meta: message.meta,
        })
        if (debugRef.current) {
          console.info(
            `[webgpu-view] ready: ${message.backend} ${message.adapter} / ${message.width}x${message.height}`,
            message.meta ?? '',
          )
        }
        return
      }

      if (message.type === 'error') {
        // 結果待ちを解除して次のフレームを止めない。
        // 止めてよいのは初期化失敗（fatal）だけ。
        // resize 直後などは 1 フレームだけ失敗することがあり、
        // そこで `ready` を落とすとそのまま描画が再開しなくなる。
        inFlightRef.current = false
        const fatal = message.fatal !== false
        if (fatal) readyRef.current = false

        // 同じエラーが毎フレーム続いてもログを溢れさせない
        if (lastErrorMessageRef.current !== message.message) {
          lastErrorMessageRef.current = message.message
          if (fatal) {
            setError(message.message)
            onErrorRef.current?.(message.message)
            console.error('[webgpu-view]', message.message)
          } else {
            // 一時的な失敗。次のフレームで復帰するので `error` にはしない
            console.warn('[webgpu-view] frame failed (継続します):', message.message)
          }
        }
        return
      }

      inFlightRef.current = false
      lastErrorMessageRef.current = null
      stats.current.frames++
      stats.current.renderMs += message.renderMs

      if (debugRef.current && stats.current.frames >= 120) {
        const fps = (stats.current.frames * 1000) / (performance.now() - stats.current.since)
        console.info(
          `[webgpu-view] ${fps.toFixed(1)} fps / ${message.width}x${message.height} / worker render ${(
            stats.current.renderMs / stats.current.frames
          ).toFixed(2)} ms`,
        )
        stats.current = { frames: 0, renderMs: 0, since: performance.now() }
      }

      // 未反映の bitmap は捨てる（最新のみ表示）
      colorPending.current?.close()
      colorPending.current = message.bitmap

      if (message.depthBitmap) {
        depthPending.current?.close()
        depthPending.current = message.depthBitmap
      }
    }

    worker.onerror = (event) => {
      // 1 回の例外で恒久的に止めない（次のフレームを送れるように結果待ちを解除する）
      inFlightRef.current = false
      if (lastErrorMessageRef.current === event.message) return
      lastErrorMessageRef.current = event.message
      setError(event.message)
      onErrorRef.current?.(event.message)
      console.error('[webgpu-view] worker error:', event.message)
    }

    const { width: w, height: h, internalDepth: d, workerData: data } = optionsRef.current
    worker.postMessage({
      type: 'init',
      width: normalizeDimension(w),
      height: normalizeDimension(h),
      depth: d,
      data,
    })

    return () => {
      workerRef.current = null
      readyRef.current = false
      inFlightRef.current = false
      colorPending.current?.close()
      colorPending.current = null
      colorRetired.current?.close()
      colorRetired.current = null
      depthPending.current?.close()
      depthPending.current = null
      depthRetired.current?.close()
      depthRetired.current = null
      worker.terminate()
    }
  }, [WorkerClass])

  // --- リサイズ -----------------------------------------------------------
  useEffect(() => {
    workerRef.current?.postMessage({
      type: 'resize',
      width: normalizeDimension(width),
      height: normalizeDimension(height),
    })
  }, [width, height])

  // --- 毎フレーム: テクスチャ更新 + カメラ送信 -----------------------------
  useFrame((state, delta) => {
    const { color, depth: depthTexture } = textures

    const colorBitmap = colorPending.current
    if (colorBitmap) {
      colorPending.current = null
      updateTexture(color, colorBitmap)

      // 前回の bitmap はこのフレームで転送済みなので解放してよい
      colorRetired.current?.close()
      colorRetired.current = colorBitmap

      if (!hasFrame) setHasFrame(true)
    }

    const depthBitmap = depthPending.current
    if (depthBitmap && depthTexture) {
      depthPending.current = null
      updateTexture(depthTexture, depthBitmap)

      depthRetired.current?.close()
      depthRetired.current = depthBitmap
    }

    if (!enabled || !readyRef.current) return

    if (inFlightRef.current) {
      // 応答が返らないまま止まったままにしない（Worker のクラッシュ / 1 フレームの失敗）
      if (performance.now() - sentAtRef.current < FRAME_TIMEOUT_MS) return
      inFlightRef.current = false
      if (debugRef.current) {
        console.warn('[webgpu-view] frame response timed out; retrying')
      }
    }

    const time = state.clock.elapsedTime
    if (time - lastSentRef.current < 1 / maxFps) return
    lastSentRef.current = time

    const getViews = getViewCamerasRef.current
    const viewCameras = getViews ? getViews(state) : [(state.camera as PerspectiveCamera)]

    const views: ViewMatrices[] = viewCameras.map((camera) => {
      camera.updateMatrixWorld()
      return {
        view: Array.from(camera.matrixWorldInverse.elements),
        projection: Array.from(camera.projectionMatrix.elements),
        camera: {
          fov: camera.isPerspectiveCamera ? camera.fov : 50,
          aspect: camera.isPerspectiveCamera ? camera.aspect : 1,
          near: camera.near,
          far: camera.far,
        },
      }
    })

    const message: FrameRequest = {
      type: 'frame',
      id: ++frameIdRef.current,
      time,
      delta: Math.min(delta, 0.1),
      views,
    }

    inFlightRef.current = true
    sentAtRef.current = performance.now()
    workerRef.current?.postMessage(message)
  })

  return { colorTexture: textures.color, depthTexture: textures.depth, hasFrame, error }
}

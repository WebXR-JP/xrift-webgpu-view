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

import { useFrame, useThree } from '@react-three/fiber'
import type { RootState } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  LinearFilter,
  NearestFilter,
  PerspectiveCamera,
  Source,
  SRGBColorSpace,
  Texture,
} from 'three'
import type { WebGLRenderer } from 'three'
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

/**
 * `gl.render` の計測リスナー共有表。同じ `WebGLRenderer` に複数の計測利用者が
 * いてもラップは 1 回だけにし、任意順の解除で壊れないようにする。
 * 後から別のコードが `gl.render` を上書きした場合は、解除時に上書きしない
 * （`gl.render === patched` のときだけ元に戻す）。
 */
interface RenderTimingEntry {
  original: WebGLRenderer['render']
  patched: WebGLRenderer['render']
  listeners: Set<(ms: number) => void>
}

const renderTimingByRenderer = new WeakMap<WebGLRenderer, RenderTimingEntry>()

/**
 * `renderer.render` を 1 回だけラップして実行時間を全リスナーへ配る。
 * 解除関数を返す。最後のリスナーが外れたら、現在の `render` がラップした
 * ものと同じ場合だけ元に戻す。
 */
function addRenderTiming(renderer: WebGLRenderer, listener: (ms: number) => void): () => void {
  let entry = renderTimingByRenderer.get(renderer)
  if (!entry) {
    const original = renderer.render
    const listeners = new Set<(ms: number) => void>()
    const patched = function (
      this: WebGLRenderer,
      ...args: Parameters<WebGLRenderer['render']>
    ) {
      const start = performance.now()
      try {
        return original.apply(this, args)
      } finally {
        const ms = performance.now() - start
        for (const fn of listeners) fn(ms)
      }
    } as WebGLRenderer['render']
    entry = { original, patched, listeners }
    renderer.render = patched
    renderTimingByRenderer.set(renderer, entry)
  }
  entry.listeners.add(listener)
  return () => {
    const current = renderTimingByRenderer.get(renderer)
    if (!current) return
    current.listeners.delete(listener)
    if (current.listeners.size === 0) {
      if (renderer.render === current.patched) {
        renderer.render = current.original
      }
      renderTimingByRenderer.delete(renderer)
    }
  }
}

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
   * 区間別の計測を有効にするか（既定 false）。
   * true のときだけ Worker に計測を指示し、テクスチャ転送とメイン描画も測って
   * 約 1000ms ごとに `onStats` を呼ぶ。false のときは計測も追加の同期も行わない。
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
   * 深度画像も受け取る（毎フレーム 2 パス描画になる）。
   * @internal experimental/DepthComposite 専用。
   */
  internalDepth?: boolean
}

/**
 * 約 1000ms の計測窓で平均した描画統計。
 *
 * - `roundTripMs` は送信→結果受信（Worker 描画 + 転送 + メッセージ往復）。
 * - `intervalMs` はフレーム送信の間隔。Worker が詰まると `maxFps` より延びる。
 * - `mainFrameMs` は rAF の間隔（メインスレッドの忙しさ）。
 * - `uploadMs` は ImageBitmap→GL テクスチャ転送。`initTexture` で即時転送して測る。
 * - `mainRenderMs` はメインの `gl.render` 呼び出し時間（背景板 + シーン全体）。
 * - `updateMs` / `renderMs` / `snapshotMs` / `workerTotalMs` は Worker 内の JS 区間。
 * - `gpuRenderMs` / `gpuComputeMs` は GPU 上の実時間の非同期サンプル平均
 *   （30 フレームに 1 回だけ解決する値を窓内で平均したもので、全フレーム平均ではない）。
 *   取れない環境では undefined。
 *
 * @internal デモ / 開発時の計測用。公開 API ではない。
 */
export interface GpuWorkerStats {
  /** 集計窓の長さ (ms) */
  windowMs: number
  /** 窓内に届いた Worker 結果の数 */
  frames: number
  /** 背景の実効 fps（frames / windowMs * 1000） */
  fps: number
  /** 1 視点ぶんの解像度 */
  width: number
  height: number
  /** main: 送信→結果受信の平均 (ms)。Worker 描画 + 転送 + メッセージを含む */
  roundTripMs: number
  /** main: フレーム送信間隔の平均 (ms) */
  intervalMs: number
  /** main: rAF 間隔の平均 (ms) */
  mainFrameMs: number
  /** main: ImageBitmap→GL テクスチャ転送の平均 (ms)。profile 時は initTexture で即時転送して測る */
  uploadMs: number
  /** main: gl.render の JS 時間平均 (ms)。profile 時のみ計測 */
  mainRenderMs: number
  /** worker: 区間平均 (ms) */
  updateMs: number
  renderMs: number
  snapshotMs: number
  workerTotalMs: number
  /**
   * worker: GPU 実時間の非同期サンプル平均 (ms)。
   * 30 フレームに 1 回だけ解決する値を窓内で平均したもので、全フレーム平均ではない。
   * 取れないときは undefined。
   */
  gpuRenderMs?: number
  gpuComputeMs?: number
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

/** 計測窓ごとの累積値を作る（窓の切り替えごとに捨てる） */
function createProfileAccumulator() {
  return {
    windowStart: performance.now(),
    frames: 0,
    roundTripSum: 0,
    roundTripCount: 0,
    prevSentAt: 0,
    intervalSum: 0,
    intervalCount: 0,
    mainFrameSum: 0,
    mainFrameCount: 0,
    uploadSum: 0,
    uploadCount: 0,
    mainRenderSum: 0,
    mainRenderCount: 0,
    updateSum: 0,
    renderSum: 0,
    snapshotSum: 0,
    workerTotalSum: 0,
    workerCount: 0,
    gpuRenderSum: 0,
    gpuRenderCount: 0,
    gpuComputeSum: 0,
    gpuComputeCount: 0,
  }
}

type ProfileAccumulator = ReturnType<typeof createProfileAccumulator>

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
  profile = false,
  onStats,
  internalDepth = false,
}: UseGpuWorkerOptions): UseGpuWorkerResult {
  const workerRef = useRef<Worker | null>(null)
  const readyRef = useRef(false)
  const inFlightRef = useRef(false)
  /** 最後にフレームを送った時刻（応答待ちのタイムアウト判定用） */
  const sentAtRef = useRef(0)
  const frameIdRef = useRef(0)
  /** request id ごとの送信時刻（roundTrip 対応付け用。profileEnabled のときだけ記録） */
  const sentAtByIdRef = useRef(new Map<number, number>())
  /** 次にフレーム送信を許可する予定時刻（performance.now の ms。位相を保って間引く用） */
  const nextSendAtRef = useRef(0)
  const lastErrorMessageRef = useRef<string | null>(null)
  const stats = useRef({ frames: 0, renderMs: 0, since: performance.now() })

  // フックの順序を固定するため購読自体は常に行う。
  // profile=false のときは参照・initTexture・ラップのいずれも行わない。
  const glForProfile = useThree((state) => state.gl)

  // `profile` はマウント時に評価する。切り替えるには再マウントすること。
  const profileEnabled = useRef(profile).current
  /**
   * 計測窓ごとの累積値。profileEnabled（マウント時固定）のときだけ書き込み・読み出しする。
   * useFrame 側で経過時間を見て emit するため、Worker が遅くて結果が来なくても出る。
   * profile=false で `performance.now()` を読む初期化が走らないよう遅延生成する。
   */
  const profileStats = useRef<ProfileAccumulator | null>(null)
  const ensureProfileStats = () => (profileStats.current ??= createProfileAccumulator())

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

  const optionsRef = useRef({ width, height, internalDepth, workerData, profile: profileEnabled })
  optionsRef.current = { width, height, internalDepth, workerData, profile: profileEnabled }

  const getViewCamerasRef = useRef(getViewCameras)
  getViewCamerasRef.current = getViewCameras

  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady

  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const debugRef = useRef(debug)
  debugRef.current = debug

  // profile はマウント時に固定（profileEnabled）するため profileRef は持たない

  const onStatsRef = useRef(onStats)
  onStatsRef.current = onStats

  // --- Worker 起動 ---------------------------------------------------------
  useEffect(() => {
    // maxFps 変更や Worker 起動で位相の基準を戻す（古い予定時刻を引きずらない）
    nextSendAtRef.current = 0
    sentAtByIdRef.current.clear()
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

      // profile 時のみ送信時刻からの実測を累積する（false のときは時計も読まない）
      if (profileEnabled) {
        const accumulated = ensureProfileStats()
        accumulated.frames++
        // request id で送信時刻を対応付ける。タイムアウト後に古い結果が返っても
        // 別リクエストの時刻で計算しない。対応がなければ加算しない。
        const sentAt = sentAtByIdRef.current.get(message.id)
        if (sentAt !== undefined) {
          accumulated.roundTripSum += performance.now() - sentAt
          accumulated.roundTripCount++
        }
        sentAtByIdRef.current.delete(message.id)
        const timings = message.timings
        if (timings) {
          accumulated.updateSum += timings.updateMs
          accumulated.renderSum += timings.renderMs
          accumulated.snapshotSum += timings.snapshotMs
          accumulated.workerTotalSum += timings.totalMs
          accumulated.workerCount++
          if (typeof timings.gpuRenderMs === 'number') {
            accumulated.gpuRenderSum += timings.gpuRenderMs
            accumulated.gpuRenderCount++
          }
          if (typeof timings.gpuComputeMs === 'number') {
            accumulated.gpuComputeSum += timings.gpuComputeMs
            accumulated.gpuComputeCount++
          }
        }
      }

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

    const { width: w, height: h, internalDepth: d, workerData: data, profile: p } = optionsRef.current
    worker.postMessage({
      type: 'init',
      width: normalizeDimension(w),
      height: normalizeDimension(h),
      depth: d,
      profile: p,
      data,
    })

    return () => {
      workerRef.current = null
      readyRef.current = false
      inFlightRef.current = false
      sentAtByIdRef.current.clear()
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

  // maxFps が変わったら送信予定の基準を戻す（古い間隔の位相を引きずらない）
  useEffect(() => {
    nextSendAtRef.current = 0
  }, [maxFps])

  // --- リサイズ -----------------------------------------------------------
  useEffect(() => {
    workerRef.current?.postMessage({
      type: 'resize',
      width: normalizeDimension(width),
      height: normalizeDimension(height),
    })
  }, [width, height])

  // --- メイン描画の計測（profileEnabled のときだけ gl.render を包む） -------------
  // XR 中も r3f は同じ gl.render 経路で描くため、そのまま測れる。
  // profile はマウント時固定なので切り替え時の取り直しは不要。
  // addRenderTiming で参照カウントし、任意順の解除でも壊れないようにする。
  useEffect(() => {
    if (!profileEnabled) return
    return addRenderTiming(glForProfile, (ms) => {
      // 集計オブジェクトがまだ無い（初回計測前）ときは無視する
      const accumulated = profileStats.current
      if (!accumulated) return
      accumulated.mainRenderSum += ms
      accumulated.mainRenderCount++
    })
  }, [profileEnabled, glForProfile])

  // --- 毎フレーム: テクスチャ更新 + カメラ送信 -----------------------------
  useFrame((state, delta) => {
    const { color, depth: depthTexture } = textures

    const colorBitmap = colorPending.current
    if (colorBitmap) {
      colorPending.current = null
      updateTexture(color, colorBitmap)

      // profile 時のみ即時転送して時間を測る（通常は描画時にまかせて触らない）
      if (profileEnabled) {
        const uploadStart = performance.now()
        glForProfile.initTexture(color)
        const accumulated = ensureProfileStats()
        accumulated.uploadSum += performance.now() - uploadStart
        accumulated.uploadCount++
      }

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

    // profile 時は結果が来なくても窓の経過で emit する（Worker 停滞の切り分け用）
    if (profileEnabled) {
      const accumulated = ensureProfileStats()
      accumulated.mainFrameSum += delta * 1000
      accumulated.mainFrameCount++
      const now = performance.now()
      const windowMs = now - accumulated.windowStart
      if (windowMs >= 1000) {
        const { width: w, height: h } = optionsRef.current
        const avg = (sum: number, count: number) => (count > 0 ? sum / count : 0)
        onStatsRef.current?.({
          windowMs,
          frames: accumulated.frames,
          fps: (accumulated.frames * 1000) / windowMs,
          width: w,
          height: h,
          roundTripMs: avg(accumulated.roundTripSum, accumulated.roundTripCount),
          intervalMs: avg(accumulated.intervalSum, accumulated.intervalCount),
          mainFrameMs: avg(accumulated.mainFrameSum, accumulated.mainFrameCount),
          uploadMs: avg(accumulated.uploadSum, accumulated.uploadCount),
          mainRenderMs: avg(accumulated.mainRenderSum, accumulated.mainRenderCount),
          updateMs: avg(accumulated.updateSum, accumulated.workerCount),
          renderMs: avg(accumulated.renderSum, accumulated.workerCount),
          snapshotMs: avg(accumulated.snapshotSum, accumulated.workerCount),
          workerTotalMs: avg(accumulated.workerTotalSum, accumulated.workerCount),
          gpuRenderMs:
            accumulated.gpuRenderCount > 0
              ? accumulated.gpuRenderSum / accumulated.gpuRenderCount
              : undefined,
          gpuComputeMs:
            accumulated.gpuComputeCount > 0
              ? accumulated.gpuComputeSum / accumulated.gpuComputeCount
              : undefined,
        })
        const keptPrevSentAt = accumulated.prevSentAt
        profileStats.current = { ...createProfileAccumulator(), windowStart: now, prevSentAt: keptPrevSentAt }
      }
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

    // maxFps が 0 以下 / 非有限のときは送らない。NaN の誤送信を避けるため先に確認する
    if (!Number.isFinite(maxFps) || maxFps <= 0) return
    const intervalMs = 1000 / maxFps
    // Number.MIN_VALUE のような極小値では intervalMs が Infinity になるため弾く
    if (!Number.isFinite(intervalMs)) return
    const nowMs = performance.now()
    // 予定時刻より前なら送らない。+1ms は rAF の量子化（16.67ms と 1/60 の差）の許容。
    if (nowMs + 1 < nextSendAtRef.current) return
    // 次回の予定は「前回の予定 + 間隔」。ジッタで遅れた分は次以降で回収し、
    // タブ非表示などで大きく遅れたときは now を下限にして burst しない。
    nextSendAtRef.current = Math.max(nextSendAtRef.current + intervalMs, nowMs)

    // Worker に送るアニメーション時間は従来どおり clock を使う
    const time = state.clock.elapsedTime

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
    if (profileEnabled) {
      const accumulated = ensureProfileStats()
      if (accumulated.prevSentAt > 0) {
        accumulated.intervalSum += sentAtRef.current - accumulated.prevSentAt
        accumulated.intervalCount++
      }
      accumulated.prevSentAt = sentAtRef.current
      // request id で送信時刻を対応付ける（上限 8 件を超えたら最古から捨てる）
      const sentAtById = sentAtByIdRef.current
      sentAtById.set(message.id, sentAtRef.current)
      if (sentAtById.size > 8) {
        const oldest = sentAtById.keys().next()
        if (!oldest.done) sentAtById.delete(oldest.value)
      }
    }
    workerRef.current?.postMessage(message)
  })

  return { colorTexture: textures.color, depthTexture: textures.depth, hasFrame, error }
}

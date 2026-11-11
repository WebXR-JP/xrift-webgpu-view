/**
 * Worker 側のランタイム
 *
 * 利用者は Worker のエントリで `defineGpuWorker(factory)` を呼ぶだけでよい。
 * ここが WebGPURenderer の生成、カメラ行列の反映、視点ぶんのアトラス描画、
 * ImageBitmap の転送、メッセージ処理をまとめて面倒を見る。
 *
 * 重要:
 * - Worker には requestAnimationFrame が無い（canvas を transfer していない）ため、
 *   メインスレッドからの 'frame' メッセージが描画トリガーになる。
 * - 前のフレームが終わる前に次の要求が来たら「最新だけ」残して捨てる（遅延を溜めない）。
 * - 結果は postMessage で transfer する。ImageBitmap は受け取った側が close() する。
 */

import { MeshBasicNodeMaterial, PerspectiveCamera, WebGPURenderer } from 'three/webgpu'
import { clamp, positionView, sRGBTransferEOTF, vec3 } from 'three/tsl'
import { MAX_DIMENSION, normalizeDimension } from '../protocol'
import type { FrameRequest, ViewMatrices, WorkerRequest, WorkerResponse } from '../protocol'
import type { GpuWorkerScene, GpuWorkerSceneFactory } from './types'

/** worker スコープ（tsconfig が DOM lib なので最小限を自前で宣言する） */
const scope = globalThis as unknown as {
  postMessage: (message: WorkerResponse, transfer?: Transferable[]) => void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
}

/**
 * 深度パスで 0..1 に正規化する距離の上限（ワールド単位）。
 * 16bit（65535 段階）で表現するので 50 / 65535 ≒ 0.76mm 精度になる。
 */
const DEPTH_RANGE = 50

let renderer: WebGPURenderer | null = null
let canvas: OffscreenCanvas | null = null
let userScene: GpuWorkerScene | null = null

/** 視点ごとのカメラ（[0] が単眼 or 左目、[1] が右目） */
const cameras: PerspectiveCamera[] = []

/**
 * 1 視点ぶんの目標サイズ。canvas はこれを視点数ぶん横に並べたアトラスになる。
 *
 * `resize` で来た値をその場で renderer に適用すると、描画中のフレームと
 * canvas のサイズが食い違い、`transferToImageBitmap()` が失敗することがある。
 * そのため適用は次の描画の直前（`applyCanvasSize`）にまとめて行う。
 */
let targetSize = { width: 0, height: 0 }
/** renderer / canvas に適用済みのアトラス全体のサイズ */
let appliedSize = { width: 0, height: 0 }
/** 実際に描画に使っている 1 視点ぶんのサイズ */
let viewSize = { width: 0, height: 0 }

let initialized = false
let busy = false
let pending: FrameRequest | null = null

/** 深度画像も返すか（@internal） */
let wantDepth = false
let depthMaterial: MeshBasicNodeMaterial | null = null

/**
 * 区間別の計測をするか（`init` メッセージの `profile` で決まる。既定 false）。
 * false のときは従来どおり計測も timestamp-query も行わない。
 */
let profile = false
/**
 * GPU 実時間の直近値。`resolveTimestampsAsync` は毎フレーム待つとヒッチになるため、
 * profile 時のみ 30 フレームに 1 回だけ非同期に解決し、解決できるまで前回値を載せる。
 * 載せる値はあくまで非同期サンプルであり、全フレーム平均ではない。
 */
let lastGpuRenderMs: number | undefined
let lastGpuComputeMs: number | undefined
let gpuResolving = false
let profiledFrames = 0
/** timestamp 解決の世代。init 開始と dispose で進め、古い解決を捨てる */
let profileGeneration = 0
/** GPU 時間を解決する間隔（フレーム数）。毎フレームの await を避けるため */
const GPU_PROFILE_INTERVAL = 30

function getCamera(index: number) {
  let camera = cameras[index]
  if (!camera) {
    camera = new PerspectiveCamera(50, 1, 0.1, 1000)
    cameras.push(camera)
  }
  return camera
}

function applyView(camera: PerspectiveCamera, { view, projection, camera: info }: ViewMatrices) {
  // view からワールド行列を作り、分解して position/quaternion/scale に反映する。
  // （WebGPURenderer は matrix から matrixWorld / matrixWorldInverse を更新するため）
  camera.matrix.fromArray(view).invert()
  camera.matrix.decompose(camera.position, camera.quaternion, camera.scale)
  camera.matrixWorld.copy(camera.matrix)
  camera.matrixWorldInverse.fromArray(view)
  camera.projectionMatrix.fromArray(projection)
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()

  camera.fov = info.fov
  camera.aspect = info.aspect
  camera.near = info.near
  camera.far = info.far
}

/**
 * 目標サイズと視点数を canvas / renderer に反映する。
 * 描画の直前にだけ呼ぶ（描画中のサイズ変更を避けるため）。
 */
function applyCanvasSize(count: number) {
  const perViewWidth = normalizeDimension(targetSize.width)
  const perViewHeight = normalizeDimension(targetSize.height)
  // ステレオでも 1 辺の上限を超えないようにする
  const totalWidth = normalizeDimension(perViewWidth * count, MAX_DIMENSION)

  viewSize = { width: Math.floor(totalWidth / count), height: perViewHeight }

  if (!renderer) return
  if (appliedSize.width === totalWidth && appliedSize.height === perViewHeight) return

  renderer.setSize(totalWidth, perViewHeight, false)
  appliedSize = { width: totalWidth, height: perViewHeight }
}

/** アトラス（横並び）の 1 視点分にビューポートとシザーを合わせる */
function applyViewport(index: number) {
  if (!renderer) return
  renderer.setViewport(index * viewSize.width, 0, viewSize.width, viewSize.height)
  renderer.setScissor(index * viewSize.width, 0, viewSize.width, viewSize.height)
  renderer.setScissorTest(true)
}

/** OffscreenCanvas の内容を ImageBitmap にする（WebGPU コンテキストでも動く方を使う） */
async function snapshot(target: OffscreenCanvas) {
  try {
    return target.transferToImageBitmap()
  } catch {
    return await createImageBitmap(target)
  }
}

/**
 * 距離を R,G に 16bit でパックした深度画像を描く。
 * @internal experimental/DepthComposite 専用。
 */
async function renderDepthPass(count: number) {
  if (!renderer || !canvas || !depthMaterial || !userScene) return null

  const previousBackground = userScene.scene.background
  const previousOverride = userScene.scene.overrideMaterial
  const excluded = userScene.depthExclude ?? []
  const previousVisibility = excluded.map((object) => object.visible)

  userScene.scene.background = null // 背景色が深度として書かれないようにする（クリアは黒）
  userScene.scene.overrideMaterial = depthMaterial
  excluded.forEach((object) => (object.visible = false))

  for (let i = 0; i < count; i++) {
    applyViewport(i)
    renderer.render(userScene.scene, getCamera(i))
  }

  const bitmap = await snapshot(canvas)

  userScene.scene.background = previousBackground
  userScene.scene.overrideMaterial = previousOverride
  excluded.forEach((object, index) => (object.visible = previousVisibility[index]))

  return bitmap
}

function createDepthMaterial() {
  // 視点からの距離（view 空間の -z）を DEPTH_RANGE で正規化し、R,G に 16bit で
  // パックする。R,G = 0 は「描画なし」を表す。
  // 出力段で sRGB エンコードされるため、事前に EOTF で打ち消してバイト値を保つ。
  const material = new MeshBasicNodeMaterial()
  material.toneMapped = false

  const normalized = clamp(positionView.z.negate().div(DEPTH_RANGE), 0, 0.9999)
  const scaled = normalized.mul(65535).floor()
  const high = scaled.div(256).floor()
  const low = scaled.sub(high.mul(256))
  material.colorNode = vec3(sRGBTransferEOTF(vec3(high.div(255), low.div(255), 0)))

  return material
}

async function renderFrame(frame: FrameRequest) {
  if (!renderer || !canvas || !userScene) return

  // 計測なしの通常経路。profile=false のときはここだけを使い、
  // 余計な performance.now() 呼び出しも増やさない。
  if (!profile) {
    const started = performance.now()

    // ステレオは最大 2 視点。アトラスの横幅を等分して描く
    const count = Math.min(2, Math.max(1, frame.views.length))
    // サイズ（resize）は描画の直前まで遅らせて反映する
    applyCanvasSize(count)
    for (let i = 0; i < count; i++) {
      applyView(getCamera(i), frame.views[i])
    }

    await userScene.update?.({ time: frame.time, delta: frame.delta, viewCount: count, renderer })

    const depthBitmap = wantDepth ? await renderDepthPass(count) : null

    for (let i = 0; i < count; i++) {
      applyViewport(i)
      renderer.render(userScene.scene, getCamera(i))
    }
    renderer.setScissorTest(false)

    const bitmap = await snapshot(canvas)

    scope.postMessage(
      {
        type: 'result',
        id: frame.id,
        bitmap,
        depthBitmap: depthBitmap ?? undefined,
        width: appliedSize.width,
        height: appliedSize.height,
        renderMs: performance.now() - started,
      },
      depthBitmap ? [bitmap, depthBitmap] : [bitmap],
    )
    return
  }

  // 計測ありの経路（profile: true のときだけ）。
  const frameStart = performance.now()

  const count = Math.min(2, Math.max(1, frame.views.length))
  applyCanvasSize(count)
  for (let i = 0; i < count; i++) {
    applyView(getCamera(i), frame.views[i])
  }

  const updateStart = performance.now()
  await userScene.update?.({ time: frame.time, delta: frame.delta, viewCount: count, renderer })
  const updateMs = performance.now() - updateStart

  // renderMs は renderer.render() の JS 呼び出し時間（深度パスを含む）。
  // GPU の完了待ちは含まない。
  const renderStart = performance.now()
  const depthBitmap = wantDepth ? await renderDepthPass(count) : null
  for (let i = 0; i < count; i++) {
    applyViewport(i)
    renderer.render(userScene.scene, getCamera(i))
  }
  renderer.setScissorTest(false)
  const renderMs = performance.now() - renderStart

  // snapshot は GPU 完了待ちを含みうる
  const snapshotStart = performance.now()
  const bitmap = await snapshot(canvas)
  const snapshotMs = performance.now() - snapshotStart

  const totalMs = performance.now() - frameStart

  // GPU 実時間は毎フレーム待つとヒッチになるため、N フレームに 1 回だけ非同期に解決する。
  // 解決中・未対応・例外のときは前回値（または undefined）のまま載せる。
  profiledFrames++
  if (profiledFrames % GPU_PROFILE_INTERVAL === 0 && !gpuResolving) {
    gpuResolving = true
    void resolveGpuTimestamps()
  }

  scope.postMessage(
    {
      type: 'result',
      id: frame.id,
      bitmap,
      depthBitmap: depthBitmap ?? undefined,
      width: appliedSize.width,
      height: appliedSize.height,
      renderMs: totalMs,
      timings: {
        updateMs,
        renderMs,
        snapshotMs,
        totalMs,
        gpuRenderMs: lastGpuRenderMs,
        gpuComputeMs: lastGpuComputeMs,
      },
    },
    depthBitmap ? [bitmap, depthBitmap] : [bitmap],
  )
}

/**
 * GPU の描画 / compute パスの実時間を非同期に解決して直近値に保存する。
 * 未対応（WebGL フォールバックなど）や例外は握りつぶし、呼び出し側は待たない。
 */
async function resolveGpuTimestamps() {
  const generation = profileGeneration
  try {
    const current = renderer
    if (!current) return
    const [render, compute] = await Promise.all([
      current.resolveTimestampsAsync('render'),
      current.resolveTimestampsAsync('compute'),
    ])
    // await 中に init / dispose で世代が進んでいたら古い解決として捨てる
    if (generation !== profileGeneration) return
    if (typeof render === 'number' && Number.isFinite(render)) lastGpuRenderMs = render
    if (typeof compute === 'number' && Number.isFinite(compute)) lastGpuComputeMs = compute
  } catch {
    // 計測の失敗で描画を止めない
  } finally {
    gpuResolving = false
  }
}

async function flush() {
  if (busy) return
  busy = true

  try {
    // 溜まっている要求は最新だけ処理する
    while (pending) {
      const frame = pending
      pending = null
      await renderFrame(frame)
    }
  } catch (error) {
    // 1 フレームの失敗で描画ループを止めない（resize 直後など一時的に失敗することがある）。
    // 止めてよいのは初期化失敗だけ。
    scope.postMessage({ type: 'error', message: String(error), fatal: false })
  } finally {
    busy = false
  }
}

async function init(data?: unknown) {
  // 開始時に世代を進め、進行中の古い timestamp 解決を無効化する
  profileGeneration++
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new Error('この Worker では navigator.gpu が利用できません（WebGPU 非対応のブラウザ / Worker）')
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })

  const perViewWidth = normalizeDimension(targetSize.width)
  const perViewHeight = normalizeDimension(targetSize.height)

  canvas = new OffscreenCanvas(perViewWidth, perViewHeight)
  renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    // profile のときだけ timestamp-query を有効にする（既定は従来どおり無効）
    trackTimestamp: profile,
  })
  renderer.setPixelRatio(1)
  applyCanvasSize(1)

  await renderer.init()

  userScene = await factory({ width: perViewWidth, height: perViewHeight, renderer, canvas, data })
  if (wantDepth) depthMaterial = createDepthMaterial()

  // 最初の 'frame' が来るまでの見た目
  const warmupCamera = getCamera(0)
  warmupCamera.position.set(0, 1.7, 8)
  warmupCamera.aspect = perViewWidth / perViewHeight
  warmupCamera.updateProjectionMatrix()
  userScene.warmup?.(warmupCamera)
  warmupCamera.updateMatrixWorld()

  renderer.render(userScene.scene, warmupCamera)

  return {
    backend: 'webgpu',
    adapter: adapter?.info?.description ?? adapter?.info?.vendor ?? '',
  }
}

let factory: GpuWorkerSceneFactory = () => {
  throw new Error('defineGpuWorker() が呼ばれていません')
}

/**
 * Worker のエントリで 1 回だけ呼ぶ。
 *
 * ```ts
 * // my.worker.ts
 * import { defineGpuWorker } from '@webxr-jp/webgpu-view/worker'
 * defineGpuWorker(({ renderer }) => {
 *   const scene = new Scene()
 *   renderer.compute(initCompute)
 *   return { scene, update: ({ time }) => { uTime.value = time } }
 * })
 * ```
 */
export function defineGpuWorker(sceneFactory: GpuWorkerSceneFactory) {
  factory = sceneFactory
}

scope.onmessage = async (event) => {
  const message = event.data

  if (message.type === 'init') {
    targetSize = {
      width: normalizeDimension(message.width),
      height: normalizeDimension(message.height),
    }
    wantDepth = message.depth === true
    profile = message.profile === true

    if (initialized) return

    try {
      const info = await init(message.data)
      initialized = true
      scope.postMessage({
        type: 'ready',
        width: normalizeDimension(targetSize.width),
        height: normalizeDimension(targetSize.height),
        backend: info.backend,
        adapter: info.adapter,
        meta: userScene?.meta,
      })
    } catch (error) {
      scope.postMessage({ type: 'error', message: String(error), fatal: true })
    }
    return
  }

  if (message.type === 'resize') {
    // 反映は次の描画の直前（renderFrame → applyCanvasSize）に回す。
    // ここで renderer.setSize() すると、描画中のフレームと canvas のサイズが
    // 食い違って transferToImageBitmap() が失敗することがある。
    targetSize = {
      width: normalizeDimension(message.width),
      height: normalizeDimension(message.height),
    }
    return
  }

  if (message.type === 'frame') {
    if (!initialized) return
    pending = message
    void flush()
    return
  }

  if (message.type === 'dispose') {
    // 世代を進めて進行中の timestamp 解決を無効化する
    profileGeneration++
    userScene?.dispose?.()
    userScene = null
    depthMaterial?.dispose()
    depthMaterial = null
    renderer?.dispose()
    renderer = null
    initialized = false
    appliedSize = { width: 0, height: 0 }
    viewSize = { width: 0, height: 0 }
    lastGpuRenderMs = undefined
    lastGpuComputeMs = undefined
    gpuResolving = false
    profiledFrames = 0
  }
}

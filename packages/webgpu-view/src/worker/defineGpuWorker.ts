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

/** 1 視点ぶんのサイズ。canvas は横に viewCount 並べたアトラスになる */
let size = { width: 0, height: 0 }
/** 現在の視点数（1 = 単眼 / 2 = ステレオ） */
let viewCount = 1

let initialized = false
let busy = false
let pending: FrameRequest | null = null

/** 深度画像も返すか（@internal） */
let wantDepth = false
let depthMaterial: MeshBasicNodeMaterial | null = null

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
 * 視点数が変わったら canvas（アトラス）のサイズを合わせる。
 * size は 1 視点ぶん。
 */
function applyViewCount(count: number) {
  if (!renderer || count === viewCount || size.width === 0) return
  viewCount = count
  renderer.setSize(size.width * count, size.height, false)
}

/** アトラス（横並び）の 1 視点分にビューポートとシザーを合わせる */
function applyViewport(index: number) {
  if (!renderer) return
  renderer.setViewport(index * size.width, 0, size.width, size.height)
  renderer.setScissor(index * size.width, 0, size.width, size.height)
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

  const started = performance.now()

  // ステレオは最大 2 視点。アトラスの横幅を等分して描く
  const count = Math.min(2, Math.max(1, frame.views.length))
  applyViewCount(count)
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
      width: size.width * count,
      height: size.height,
      renderMs: performance.now() - started,
    },
    depthBitmap ? [bitmap, depthBitmap] : [bitmap],
  )
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
    scope.postMessage({ type: 'error', message: String(error) })
  } finally {
    busy = false
  }
}

async function init(width: number, height: number, data?: unknown) {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new Error('この Worker では navigator.gpu が利用できません（WebGPU 非対応のブラウザ / Worker）')
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })

  canvas = new OffscreenCanvas(width, height)
  renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(1)
  renderer.setSize(width, height, false)

  await renderer.init()

  userScene = await factory({ width, height, renderer, canvas, data })
  if (wantDepth) depthMaterial = createDepthMaterial()

  // 最初の 'frame' が来るまでの見た目
  const warmupCamera = getCamera(0)
  warmupCamera.position.set(0, 1.7, 8)
  warmupCamera.aspect = width / height
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
 * import { defineGpuWorker } from '@xrift/webgpu-view/worker'
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
    size = { width: message.width, height: message.height }
    wantDepth = message.depth === true

    if (initialized) return

    try {
      const info = await init(size.width, size.height, message.data)
      initialized = true
      scope.postMessage({
        type: 'ready',
        width: size.width,
        height: size.height,
        backend: info.backend,
        adapter: info.adapter,
        meta: userScene?.meta,
      })
    } catch (error) {
      scope.postMessage({ type: 'error', message: String(error) })
    }
    return
  }

  if (message.type === 'resize') {
    size = { width: message.width, height: message.height }
    if (!renderer) return
    renderer.setSize(size.width * viewCount, size.height, false)
    return
  }

  if (message.type === 'frame') {
    if (!initialized) return
    pending = message
    void flush()
    return
  }

  if (message.type === 'dispose') {
    userScene?.dispose?.()
    userScene = null
    depthMaterial?.dispose()
    depthMaterial = null
    renderer?.dispose()
    renderer = null
    initialized = false
  }
}

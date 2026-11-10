/**
 * WebGPU 描画 Worker
 *
 * メインスレッドの Three.js カメラ行列を受け取り、OffscreenCanvas 上の
 * WebGPURenderer でコーネルボックス + GPU パーティクルを描画して
 * ImageBitmap としてメインスレッドへ転送する。
 *
 * ポイント:
 * - rAF はワーカーに無い（canvas が transfer されていない）ので、
 *   メインスレッドからの 'frame' メッセージを描画トリガーにする。
 * - 前フレームが終わる前に次の要求が来たら「最新だけ」残して捨てる（遅延を溜めない）。
 */

import {
  ACESFilmicToneMapping,
  AmbientLight,
  BoxGeometry,
  Color,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Scene,
  Sprite,
  SpriteNodeMaterial,
  WebGPURenderer,
} from 'three/webgpu'
import {
  Fn,
  clamp,
  float,
  hash,
  instancedArray,
  instanceIndex,
  mix,
  shapeCircle,
  uniform,
  vec3,
} from 'three/tsl'
import type { FrameRequest, WorkerRequest, WorkerResponse } from './protocol'

/** worker スコープ（tsconfig が DOM lib なので最小限を自前で宣言する） */
const scope = globalThis as unknown as {
  postMessage: (message: WorkerResponse, transfer?: Transferable[]) => void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
}

// ---------------------------------------------------------------------------
// シーン定数
// ---------------------------------------------------------------------------

const PARTICLE_COUNT = 40_000

const ROOM = {
  /** 内寸（幅・奥行き） */
  size: 6,
  /** 内寸（高さ） */
  height: 5.5,
  /** 壁の厚み */
  thickness: 0.2,
} as const

/** パーティクルが反射する境界（部屋の内側） */
const PARTICLE_BOUND = ROOM.size / 2 - 0.45

// ---------------------------------------------------------------------------
// シーン構築（メインスレッドのカメラで覗くためのコーネルボックス）
// ---------------------------------------------------------------------------

let scene = new Scene()
let camera = new PerspectiveCamera(50, 1, 0.1, 1000)

let renderer: WebGPURenderer | null = null
let offscreen: OffscreenCanvas | null = null

/** TSL の ComputeNode（型は renderer.compute() の引数から借りる） */
type ComputeTask = Parameters<WebGPURenderer['compute']>[0]

let computeInit: ComputeTask | null = null
let computeUpdate: ComputeTask | null = null
let uTime = uniform(0)
let uDelta = uniform(1 / 60)

function createScene() {
  scene = new Scene()
  scene.background = new Color(0x05070c)

  const { size: s, height: h, thickness: t } = ROOM

  const surface = (color: number, roughness = 0.85) =>
    new MeshStandardNodeMaterial({ color, roughness, metalness: 0 })

  const addBox = (
    w: number,
    bh: number,
    d: number,
    x: number,
    y: number,
    z: number,
    material: MeshStandardNodeMaterial,
  ) => {
    const mesh = new Mesh(new BoxGeometry(w, bh, d), material)
    mesh.position.set(x, y, z)
    scene.add(mesh)
    return mesh
  }

  // 床・天井・奥（白）
  // 床は手前（カメラ側）まで伸ばす。メインカメラは目線の高さなので、
  // 短い床だと視錐台の下端が床の外に出て背景が見えてしまう
  addBox(s, t, 16, 0, -t / 2, 4, surface(0xe9e9e9))
  addBox(s, t, s, 0, h + t / 2, 0, surface(0xe9e9e9))
  addBox(s, h, t, 0, h / 2, -s / 2 - t / 2, surface(0xe9e9e9))
  // 左（赤）/ 右（緑）
  addBox(t, h, s, -s / 2 - t / 2, h / 2, 0, surface(0xbd1b22))
  addBox(t, h, s, s / 2 + t / 2, h / 2, 0, surface(0x159a3a))

  // 中のブロック
  const cube = new Mesh(new BoxGeometry(1.7, 1.7, 1.7), surface(0xdcdcdc))
  cube.position.set(-1.05, 0.85, 0.55)
  cube.rotation.y = 0.32
  scene.add(cube)

  const tall = new Mesh(new BoxGeometry(1.3, 2.8, 1.3), surface(0xcccccc))
  tall.position.set(1.1, 1.4, -0.55)
  tall.rotation.y = -0.38
  scene.add(tall)

  // 天井の照明パネル（発光）
  const panelMaterial = new MeshBasicNodeMaterial()
  panelMaterial.colorNode = vec3(7.0, 6.5, 5.8)
  const panel = new Mesh(new PlaneGeometry(2.4, 2.4), panelMaterial)
  panel.rotation.x = Math.PI / 2 // 法線を下向きに
  panel.position.set(0, h - 0.02, 0)
  scene.add(panel)

  scene.add(new AmbientLight(0xffffff, 0.18))
  const light = new PointLight(0xfff1de, 68, 0, 2)
  light.position.set(0, h - 0.6, 0)
  scene.add(light)

  // 手前（開いている面）からの弱いフィル。ブロックの正面を沈ませないため
  const fill = new PointLight(0xfff4e6, 14, 0, 2)
  fill.position.set(0, 3.2, 4.4)
  scene.add(fill)

  // ---------------------------------------------------------------
  // GPU パーティクル（ストレージバッファ + コンピュートシェーダ）
  // ---------------------------------------------------------------
  const positions = instancedArray(PARTICLE_COUNT, 'vec3')
  const velocities = instancedArray(PARTICLE_COUNT, 'vec3')

  uTime = uniform(0)
  uDelta = uniform(1 / 60)

  const initParticles = Fn(() => {
    const position = positions.element(instanceIndex)
    const velocity = velocities.element(instanceIndex)

    const r0 = hash(instanceIndex)
    const r1 = hash(instanceIndex.add(1))
    const r2 = hash(instanceIndex.add(2))
    const r3 = hash(instanceIndex.add(3))

    position.assign(
      vec3(
        r0.sub(0.5).mul(PARTICLE_BOUND * 2),
        r1.mul(ROOM.height * 0.62).add(0.6),
        r2.sub(0.5).mul(PARTICLE_BOUND * 2),
      ),
    )

    const angle = r0.mul(Math.PI * 2)
    velocity.assign(
      vec3(angle.cos().mul(0.35), r3.sub(0.5).mul(0.2), angle.sin().mul(0.35)),
    )
  })()
  computeInit = (initParticles as unknown as { compute: (count: number) => ComputeTask }).compute(PARTICLE_COUNT)

  const updateParticles = Fn(() => {
    const position = positions.element(instanceIndex)
    const velocity = velocities.element(instanceIndex)

    const step = uDelta.min(0.05)

    // sin/cos の積で作る擬似カール場。パーティクルが部屋全体を漂う
    const flowX = position.y.mul(1.1).add(uTime.mul(0.5)).sin().mul(position.z.mul(1.3).sub(uTime.mul(0.4)).cos())
    const flowY = position.z.mul(1.2).add(uTime.mul(0.6)).sin().mul(position.x.mul(1.0).sub(uTime.mul(0.5)).cos())
    const flowZ = position.x.mul(1.3).add(uTime.mul(0.45)).sin().mul(position.y.mul(1.2).sub(uTime.mul(0.7)).cos())

    velocity.addAssign(vec3(flowX, flowY, flowZ).mul(1.3).mul(step))
    velocity.mulAssign(float(1).sub(step.mul(1.1)))

    position.addAssign(velocity.mul(step))

    // 中心から離れすぎたら内側へ押し戻す（壁に溜まらないように）
    const cloudCenter = vec3(0, ROOM.height * 0.45, 0)
    const toCenter = position.sub(cloudCenter)
    const overflow = toCenter.length().sub(1.9).max(0)
    velocity.addAssign(toCenter.normalize().mul(overflow).mul(-6).mul(step))

    // 念のための外壁クランプ
    position.x.assign(clamp(position.x, -2.7, 2.7))
    position.z.assign(clamp(position.z, -2.7, 2.7))
    position.y.assign(clamp(position.y, 0.25, ROOM.height - 0.25))
  })()
  computeUpdate = (updateParticles as unknown as { compute: (count: number) => ComputeTask }).compute(PARTICLE_COUNT)

  const particleMaterial = new SpriteNodeMaterial()
  particleMaterial.positionNode = positions.toAttribute()
  particleMaterial.scaleNode = float(0.032).mul(hash(instanceIndex.add(11)).mul(0.7).add(0.6))
  particleMaterial.colorNode = mix(
    vec3(1.0, 0.42, 0.06),
    vec3(0.2, 0.65, 1.0),
    hash(instanceIndex.add(17)),
  ).mul(1.0)
  particleMaterial.opacityNode = shapeCircle()
  particleMaterial.transparent = true
  particleMaterial.depthWrite = false

  const particles = new Sprite(particleMaterial)
  particles.count = PARTICLE_COUNT
  particles.frustumCulled = false
  scene.add(particles)
}

// ---------------------------------------------------------------------------
// レンダラ
// ---------------------------------------------------------------------------

async function initRenderer(width: number, height: number) {
  if (!navigator.gpu) {
    throw new Error('この Worker では navigator.gpu が利用できません（WebGPU 非対応のブラウザ/Worker）')
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })

  offscreen = new OffscreenCanvas(width, height)
  renderer = new WebGPURenderer({
    canvas: offscreen,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(1)
  renderer.setSize(width, height, false)
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.15

  await renderer.init()

  createScene()

  // 初期配置（最初の 'frame' が来るまでの見た目）
  camera.position.set(0, 1.7, 8)
  camera.aspect = width / height
  camera.updateProjectionMatrix()

  renderer.compute(computeInit!)
  renderer.render(scene, camera)

  return {
    backend: 'webgpu',
    adapter: adapter?.info?.description ?? adapter?.info?.vendor ?? '',
  }
}

// ---------------------------------------------------------------------------
// メッセージ処理
// ---------------------------------------------------------------------------

let size = { width: 0, height: 0 }
let initialized = false
let busy = false
let pending: FrameRequest | null = null

function applyCamera(frame: FrameRequest) {
  const { view, projection, camera: info } = frame

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

/** OffscreenCanvas の内容を ImageBitmap にする（WebGPU コンテキストでも動く方を使う） */
async function snapshot(canvas: OffscreenCanvas) {
  try {
    return canvas.transferToImageBitmap()
  } catch {
    return await createImageBitmap(canvas)
  }
}

async function renderFrame(frame: FrameRequest) {
  if (!renderer || !offscreen) return

  const started = performance.now()

  applyCamera(frame)
  uTime.value = frame.time
  uDelta.value = frame.delta

  renderer.compute(computeUpdate!)
  renderer.render(scene, camera)

  const bitmap = await snapshot(offscreen)

  scope.postMessage(
    {
      type: 'result',
      id: frame.id,
      bitmap,
      width: size.width,
      height: size.height,
      renderMs: performance.now() - started,
    },
    [bitmap],
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

scope.onmessage = async (event) => {
  const message = event.data

  if (message.type === 'init') {
    size = { width: message.width, height: message.height }

    if (initialized) return

    try {
      const info = await initRenderer(size.width, size.height)
      initialized = true
      scope.postMessage({
        type: 'ready',
        width: size.width,
        height: size.height,
        backend: info.backend,
        adapter: info.adapter,
        particles: PARTICLE_COUNT,
      })
    } catch (error) {
      scope.postMessage({ type: 'error', message: String(error) })
    }
    return
  }

  if (message.type === 'resize') {
    size = { width: message.width, height: message.height }
    if (!renderer) return
    renderer.setSize(size.width, size.height, false)
    camera.aspect = size.width / size.height
    camera.updateProjectionMatrix()
    return
  }

  if (message.type === 'frame') {
    if (!initialized) return
    pending = message
    void flush()
    return
  }

  if (message.type === 'dispose') {
    renderer?.dispose()
    renderer = null
    initialized = false
  }
}

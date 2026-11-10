/**
 * デモ用の WebGPU シーン（コーネルボックス + GPU パーティクル）
 *
 * Worker 側のエントリ（`demoView.worker.ts` / `demoComposite.worker.ts`）から
 * `defineGpuWorker` に渡す。ライブラリ本体には含めない。
 */

import {
  ACESFilmicToneMapping,
  AmbientLight,
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  NoToneMapping,
  PlaneGeometry,
  PointLight,
  Scene,
  Sprite,
  SpriteNodeMaterial,
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
import type { GpuWorkerInit, GpuWorkerScene } from '@xrift/webgpu-view/worker'

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

/**
 * 部屋を持ち上げる量。
 * メイン世界の地面も y=0 なので、そのままだと床同士が同一平面になり
 * 深度合成（experimental）が z-fighting する。数 cm だけ浮かせて決着させる。
 */
const ROOM_LIFT = 0.06

/** TSL の ComputeNode（型は renderer.compute() の引数から借りる） */
type ComputeTask = Parameters<GpuWorkerInit['renderer']['compute']>[0]

export interface DemoSceneOptions {
  /**
   * Worker 側で ACES を掛けるか。
   * - GpuWorkerView（通常）: true（Worker の見た目をそのまま出す）
   * - DepthComposite（実験）: false（合成パス側で ACES を掛ける）
   */
  toneMapping: boolean
}

export function createDemoScene({ renderer }: GpuWorkerInit, { toneMapping }: DemoSceneOptions): GpuWorkerScene {
  renderer.toneMapping = toneMapping ? ACESFilmicToneMapping : NoToneMapping
  renderer.toneMappingExposure = 1.15

  const scene = new Scene()
  scene.background = new Color(0x05070c)

  const room = new Group()
  room.position.y = ROOM_LIFT
  scene.add(room)

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
    room.add(mesh)
    return mesh
  }

  // 床・天井・奥（白）
  // 床は部屋の範囲だけ。手前はメイン世界の地面が見える（深度合成の確認になる）
  addBox(s, t, s, 0, -t / 2, 0, surface(0xe9e9e9))
  addBox(s, t, s, 0, h + t / 2, 0, surface(0xe9e9e9))
  addBox(s, h, t, 0, h / 2, -s / 2 - t / 2, surface(0xe9e9e9))
  // 左（赤）/ 右（緑）
  addBox(t, h, s, -s / 2 - t / 2, h / 2, 0, surface(0xbd1b22))
  addBox(t, h, s, s / 2 + t / 2, h / 2, 0, surface(0x159a3a))

  // 中のブロック
  const cube = new Mesh(new BoxGeometry(1.7, 1.7, 1.7), surface(0xdcdcdc))
  cube.position.set(-1.05, 0.85, 0.55)
  cube.rotation.y = 0.32
  room.add(cube)

  const tall = new Mesh(new BoxGeometry(1.3, 2.8, 1.3), surface(0xcccccc))
  tall.position.set(1.1, 1.4, -0.55)
  tall.rotation.y = -0.38
  room.add(tall)

  // 天井の照明パネル（発光）
  const panelMaterial = new MeshBasicNodeMaterial()
  panelMaterial.colorNode = vec3(7.0, 6.5, 5.8)
  const panel = new Mesh(new PlaneGeometry(2.4, 2.4), panelMaterial)
  panel.rotation.x = Math.PI / 2 // 法線を下向きに
  panel.position.set(0, h - 0.02, 0)
  room.add(panel)

  scene.add(new AmbientLight(0xffffff, 0.18))
  const light = new PointLight(0xfff1de, 68, 0, 2)
  light.position.set(0, h - 0.6, 0)
  room.add(light)

  // 手前（開いている面）からの弱いフィル。ブロックの正面を沈ませないため
  const fill = new PointLight(0xfff4e6, 14, 0, 2)
  fill.position.set(0, 3.2, 4.4)
  room.add(fill)

  // ---------------------------------------------------------------
  // GPU パーティクル（ストレージバッファ + コンピュートシェーダ）
  // ---------------------------------------------------------------
  const positions = instancedArray(PARTICLE_COUNT, 'vec3')
  const velocities = instancedArray(PARTICLE_COUNT, 'vec3')

  const uTime = uniform(0)
  const uDelta = uniform(1 / 60)

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
    velocity.assign(vec3(angle.cos().mul(0.35), r3.sub(0.5).mul(0.2), angle.sin().mul(0.35)))
  })()
  const computeInit = (initParticles as unknown as { compute: (count: number) => ComputeTask }).compute(
    PARTICLE_COUNT,
  )

  const updateParticles = Fn(() => {
    const position = positions.element(instanceIndex)
    const velocity = velocities.element(instanceIndex)

    const step = uDelta.min(0.05)

    // sin/cos の積で作る擬似カール場。パーティクルが部屋全体を漂う
    const flowX = position.y
      .mul(1.1)
      .add(uTime.mul(0.5))
      .sin()
      .mul(position.z.mul(1.3).sub(uTime.mul(0.4)).cos())
    const flowY = position.z
      .mul(1.2)
      .add(uTime.mul(0.6))
      .sin()
      .mul(position.x.mul(1.0).sub(uTime.mul(0.5)).cos())
    const flowZ = position.x
      .mul(1.3)
      .add(uTime.mul(0.45))
      .sin()
      .mul(position.y.mul(1.2).sub(uTime.mul(0.7)).cos())

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
  const computeUpdate = (updateParticles as unknown as { compute: (count: number) => ComputeTask }).compute(
    PARTICLE_COUNT,
  )

  const particleMaterial = new SpriteNodeMaterial()
  particleMaterial.positionNode = positions.toAttribute()
  particleMaterial.scaleNode = float(0.032).mul(hash(instanceIndex.add(11)).mul(0.7).add(0.6))
  particleMaterial.colorNode = mix(vec3(1.0, 0.42, 0.06), vec3(0.2, 0.65, 1.0), hash(instanceIndex.add(17))).mul(
    1.0,
  )
  particleMaterial.opacityNode = shapeCircle()
  particleMaterial.transparent = true
  particleMaterial.depthWrite = false

  const particles = new Sprite(particleMaterial)
  particles.count = PARTICLE_COUNT
  particles.frustumCulled = false
  room.add(particles)

  renderer.compute(computeInit)

  return {
    scene,
    meta: { particles: PARTICLE_COUNT },
    // 深度を書かないもの（パーティクル）は深度パスから外す
    depthExclude: [particles],
    update: ({ time, delta, renderer: activeRenderer }) => {
      uTime.value = time
      uDelta.value = delta
      activeRenderer.compute(computeUpdate)
    },
  }
}

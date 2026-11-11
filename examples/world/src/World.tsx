import { SpawnPoint } from '@xrift/world-components'
import { RigidBody } from '@react-three/rapier'
import { useCallback, useMemo, useRef } from 'react'
import { Mesh } from 'three'
import { GpuBackdrop } from '@webxr-jp/webgpu-view'
import type { GpuBackdropProps } from '@webxr-jp/webgpu-view'

/** 内部計測（profile）の集計型。公開 API ではないので props から導出する */
type GpuWorkerStats = Parameters<NonNullable<GpuBackdropProps['onStats']>>[0]
import { DepthComposite } from '@webxr-jp/webgpu-view/experimental'
import { Skybox } from './components/Skybox'
import { COLORS, WORLD_CONFIG } from './constants'
import DemoWorker from './worker/demo.worker.ts?worker'

/**
 * false = 全画面の背景として出す（通常 / XR。深度は書かない = 常に奥）
 * true  = メインシーンの深度と合成する（experimental / XR 非対応）
 */
const USE_COMPOSITE = false

/** モニタでも左右 2 視点で描く（SBS）。XR 中は自動で 2 視点 */
const STEREO = false

/** 正の有限数だけ受け付け、それ以外は既定値にする */
function queryNumber(value: string | null, fallback: number) {
  if (value === null) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** particles クエリ（0 以上だけ受け付け、null や不正値は未指定扱い） */
function queryParticles(value: string | null) {
  if (value === null) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined
}

export interface WorldProps {
  position?: [number, number, number]
  scale?: number
}

export const World: React.FC<WorldProps> = ({ position = [0, 0, 0], scale = 1 }) => {
  const groundRef = useRef<Mesh>(null)
  const worldSize = WORLD_CONFIG.size * scale
  const wallHeight = WORLD_CONFIG.wallHeight * scale
  const wallThickness = WORLD_CONFIG.wallThickness * scale

  // 計測用の URL クエリ（例: ?profile=1&maxWidth=640&maxFps=30&particles=0&debug=1）
  const query = useMemo(() => new URLSearchParams(window.location.search), [])
  const profile = query.get('profile') === '1'
  const debugQuery = query.get('debug') === '1'
  const maxWidth = useMemo(() => queryNumber(query.get('maxWidth'), 1280), [query])
  const maxFps = useMemo(() => queryNumber(query.get('maxFps'), 60), [query])
  const particles = useMemo(() => queryParticles(query.get('particles')), [query])
  const workerData = useMemo(
    () => ({ toneMapping: true, ...(particles !== undefined ? { particles } : {}) }),
    [particles],
  )

  const handleStats = useCallback(
    (stats: GpuWorkerStats) => {
      // 計測結果は CustomEvent で外に出す（window への代入は
      // `@xrift/code-security` の no-global-override に触れるため使わない）。
      // DevTools では `addEventListener('webgpu-view:stats', (e) => ...)` で受けられる。
      window.dispatchEvent(new CustomEvent('webgpu-view:stats', { detail: stats }))
      if (debugQuery) console.info('[webgpu-view] stats', stats)
    },
    [debugQuery],
  )

  return (
    <>
      <group position={position} scale={scale}>
        {/* ========== 環境・照明 ========== */}
        {/* WebGPU の背景より先に描いておく（WebGPU が使えない環境ではこれが見える） */}
        <Skybox radius={500} renderOrder={-2000} />
        <ambientLight intensity={0.3} />
        <directionalLight
          position={[5, 10, 5]}
          intensity={1.5}
          castShadow
          shadow-mapSize-width={512}
          shadow-mapSize-height={512}
          shadow-camera-far={80}
          shadow-camera-left={-30}
          shadow-camera-right={30}
          shadow-camera-top={30}
          shadow-camera-bottom={-30}
        />
        <RigidBody type="fixed" colliders="cuboid" restitution={0} friction={0}>
          <mesh ref={groundRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
            <planeGeometry args={[worldSize, worldSize]} />
            <meshLambertMaterial color={COLORS.ground} />
          </mesh>
        </RigidBody>

        {/* ========== 壁 ========== */}
        <RigidBody type="fixed" colliders="cuboid" restitution={0} friction={0}>
          <mesh position={[worldSize / 2, wallHeight / 2, 0]} castShadow>
            <boxGeometry args={[wallThickness, wallHeight, worldSize]} />
            <meshLambertMaterial color={COLORS.wall} />
          </mesh>
        </RigidBody>
        <RigidBody type="fixed" colliders="cuboid" restitution={0} friction={0}>
          <mesh position={[-worldSize / 2, wallHeight / 2, 0]} castShadow>
            <boxGeometry args={[wallThickness, wallHeight, worldSize]} />
            <meshLambertMaterial color={COLORS.wall} />
          </mesh>
        </RigidBody>
        <RigidBody type="fixed" colliders="cuboid" restitution={0} friction={0}>
          <mesh position={[0, wallHeight / 2, worldSize / 2]} castShadow>
            <boxGeometry args={[worldSize, wallHeight, wallThickness]} />
            <meshLambertMaterial color={COLORS.wall} />
          </mesh>
        </RigidBody>
        <RigidBody type="fixed" colliders="cuboid" restitution={0} friction={0}>
          <mesh position={[0, wallHeight / 2, -worldSize / 2]} castShadow>
            <boxGeometry args={[worldSize, wallHeight, wallThickness]} />
            <meshLambertMaterial color={COLORS.wall} />
          </mesh>
        </RigidBody>

        {/* ========== 深度合成の確認用オクルーダー（不要なら削除） ========== */}
        <mesh position={[0, 1.5, 4.2]} rotation={[0.3, 0.5, 0]} castShadow>
          <torusKnotGeometry args={[0.5, 0.18, 128, 16]} />
          <meshStandardMaterial color="#f2c14e" roughness={0.35} metalness={0.2} />
        </mesh>

        {/* ========== スポーン ========== */}
        <group position={[0, 0, 8]}>
          <SpawnPoint />
        </group>
      </group>

      {/* ========== Worker + WebGPU の描画結果 ========== */}
      {USE_COMPOSITE ? (
        <DepthComposite worker={DemoWorker} workerData={{ toneMapping: false }} stereo={STEREO} />
      ) : (
        <GpuBackdrop
          worker={DemoWorker}
          workerData={workerData}
          maxWidth={maxWidth}
          maxFps={maxFps}
          stereo={STEREO}
          debug={debugQuery}
          profile={profile}
          onStats={handleStats}
        />
      )}
    </>
  )
}

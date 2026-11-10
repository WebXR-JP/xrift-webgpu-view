import { SpawnPoint } from '@xrift/world-components'
import { RigidBody } from '@react-three/rapier'
import { useRef } from 'react'
import { Mesh } from 'three'
import { DepthComposite } from './components/DepthComposite'
import { Skybox } from './components/Skybox'
import { WorkerRenderPanel } from './components/WorkerRenderPanel'
import { COLORS, WORLD_CONFIG } from './constants'

/**
 * true  = メインシーンと深度合成して全画面に描く（DepthComposite）
 * false = 画面隅のパネルに投影する（WorkerRenderPanel / 深度なし）
 */
const USE_DEPTH_COMPOSITE = true

export interface WorldProps {
  position?: [number, number, number]
  scale?: number
}

export const World: React.FC<WorldProps> = ({ position = [0, 0, 0], scale = 1 }) => {
  const groundRef = useRef<Mesh>(null)
  const worldSize = WORLD_CONFIG.size * scale
  const wallHeight = WORLD_CONFIG.wallHeight * scale
  const wallThickness = WORLD_CONFIG.wallThickness * scale

  return (
    <>
      <group position={position} scale={scale}>
        {/* ========== 環境・照明 ========== */}
        <Skybox radius={500} />
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
      {USE_DEPTH_COMPOSITE ? (
        <DepthComposite />
      ) : (
        <WorkerRenderPanel coverage={0.55} anchor="bottom-right" />
      )}
    </>
  )
}

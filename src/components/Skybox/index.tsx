import { useTexture } from '@react-three/drei'
import { BackSide } from 'three'
import { useXRift } from '@xrift/world-components'

export interface SkyboxProps {
  /** skyboxのサイズ（半径） */
  radius?: number
  /** 描画順（既定 0）。背景より先に描きたいときは小さい値にする */
  renderOrder?: number
}

/**
 * Skyboxコンポーネント
 * public/tokyo-station.jpg を360度パノラマ背景として表示します
 */
export const Skybox: React.FC<SkyboxProps> = ({ radius = 500, renderOrder = 0 }) => {
  const { baseUrl } = useXRift()
  const texture = useTexture(`${baseUrl}tokyo-station.jpg`)

  return (
    <mesh renderOrder={renderOrder}>
      <sphereGeometry args={[radius, 60, 40]} />
      <meshBasicMaterial map={texture} side={BackSide} />
    </mesh>
  )
}

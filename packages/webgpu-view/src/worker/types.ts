import type { Object3D, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu'

/** Worker 側の初期化時に渡される情報 */
export interface GpuWorkerInit {
  /** 1 視点ぶんの描画サイズ（px）。canvas は視点数ぶん横に並ぶ */
  width: number
  height: number
  /** この Worker の WebGPURenderer（toneMapping などはここで設定する） */
  renderer: WebGPURenderer
  /** Worker が描画に使っている OffscreenCanvas */
  canvas: OffscreenCanvas
  /** メインスレッドから `workerData` で渡された値 */
  data?: unknown
}

/** 毎フレームの更新で渡される情報 */
export interface GpuWorkerUpdateContext {
  /** 経過秒 */
  time: number
  /** 前フレームからの秒数 */
  delta: number
  /** このフレームの視点数（1 = 単眼 / 2 = ステレオ） */
  viewCount: number
  renderer: WebGPURenderer
}

/** シーン側（利用者のコード）が返すもの */
export interface GpuWorkerScene {
  /** 描画するシーン */
  scene: Scene
  /**
   * 毎フレーム、描画の直前に呼ばれる。
   * パーティクルの compute や uniform の更新はここで行う。
   */
  update?: (context: GpuWorkerUpdateContext) => void | Promise<void>
  /**
   * 最初のフレームが届くまでの見た目を作るためのカメラ初期化。
   * 省略すると (0, 1.7, 8) から原点方向を見る。
   */
  warmup?: (camera: PerspectiveCamera) => void
  /**
   * 深度パスから除外するもの（深度を書かない透過物など）。
   * @internal experimental/DepthComposite 専用。
   */
  depthExclude?: Object3D[]
  /** ready メッセージに載せる任意の情報（パーティクル数など） */
  meta?: Record<string, unknown>
  /** Worker 破棄時に呼ばれる */
  dispose?: () => void
}

export type GpuWorkerSceneFactory = (init: GpuWorkerInit) => GpuWorkerScene | Promise<GpuWorkerScene>

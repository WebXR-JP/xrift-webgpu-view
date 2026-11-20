import type { Object3D, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu'
import type { GpuWorkerRenderMode, ViewMatrices } from '../protocol'

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
  /** このフレームの描画モード（`views.length` と一致する） */
  mode: GpuWorkerRenderMode
  /** 1 視点ぶんの描画サイズ（px）。ポストの解像度やカメラのアスペクト合わせに使う */
  width: number
  /** 1 視点ぶんの描画サイズ（px） */
  height: number
}

/**
 * カスタム描画で渡される情報（`GpuWorkerScene.render`）。
 *
 * 既定の描画（`renderer.render(scene, camera)` を視点ぶん繰り返す）の代わりに、
 * 自前のポストプロセス付きパイプラインなどで描くときに使う。
 * 描画先は呼び出し側で用意済み（bitmap 経路は canvas、
 * buffer 経路は `setRenderTarget` 済みの RenderTarget）。
 */
export interface GpuWorkerRenderContext {
  renderer: WebGPURenderer
  /** このフレームの視点（1 = 単眼/XR 1 視点モード, 2 = ステレオ） */
  views: ViewMatrices[]
  /** このフレームの描画モード（`views.length` と一致する） */
  mode: GpuWorkerRenderMode
  /** 1 視点ぶんの描画サイズ（px） */
  width: number
  /** 1 視点ぶんの描画サイズ（px） */
  height: number
  /**
   * 視点ぶんのビューポートを適用済みか（通常は呼び出し側で適用済み）。
   *
   * 呼び出し側はフックを呼ぶ前に描画先全体（アトラス全体）の
   * ビューポートを当ててシザクリアしているので、そのまま描き始められる。
   * 視点ごとに既定と同じ描き分けをしたいときは
   * `applyViewport(index)` を呼ぶ。
   */
  viewportApplied: boolean
  /**
   * 既定の描画と同じ 1 視点ぶんのビューポート＋シザーを当てる
   *（アトラスを横に並べる配置と同一）。
   */
  applyViewport: (index: number) => void
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
   * カスタム描画。指定すると既定の描画
   *（`renderer.render(scene, camera)` を視点ぶん繰り返す）の代わりに呼ばれる。
   *
   * 自前のポストプロセス付きパイプライン（残像・bloom・コンポジットなど）を
   * 自分で所有して `pipeline.render()` で描くときに使う。
   * `transfer: 'buffer'` のときも同じフックが使われ、
   * フック内は現在の描画先（`renderer.setRenderTarget` 済み）に描く前提。
   * 未指定時は従来どおり既定の描画になる（後方互換）。
   */
  render?: (context: GpuWorkerRenderContext) => void | Promise<void>
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

/**
 * メインスレッド ⇔ 描画 Worker のメッセージ定義
 *
 * ここには DOM / three.js に依存する値を置かない（両方から読み込むため）。
 */

/** 行列は three.js と同じ column-major の 16 要素 */
export type Mat4 = number[]

export interface InitRequest {
  type: 'init'
  width: number
  height: number
}

export interface ResizeRequest {
  type: 'resize'
  width: number
  height: number
}

export interface FrameRequest {
  type: 'frame'
  id: number
  /** 経過秒（Worker 側のアニメーション用） */
  time: number
  /** 前フレームからの秒数 */
  delta: number
  /** ワールド → ビュー（カメラの matrixWorldInverse） */
  view: Mat4
  /** カメラの projectionMatrix */
  projection: Mat4
  camera: {
    fov: number
    aspect: number
    near: number
    far: number
  }
}

export interface DisposeRequest {
  type: 'dispose'
}

export type WorkerRequest = InitRequest | ResizeRequest | FrameRequest | DisposeRequest

export interface ReadyResponse {
  type: 'ready'
  width: number
  height: number
  /** 実行中のバックエンド（基本は 'webgpu'） */
  backend: string
  /** アダプタ情報（取れない環境では空文字） */
  adapter: string
  particles: number
}

export interface ErrorResponse {
  type: 'error'
  message: string
}

export interface FrameResponse {
  type: 'result'
  id: number
  bitmap: ImageBitmap
  width: number
  height: number
  /** Worker 側で 1 フレーム描画に要した時間（ms） */
  renderMs: number
}

export type WorkerResponse = ReadyResponse | ErrorResponse | FrameResponse

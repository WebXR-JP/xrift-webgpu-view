/**
 * メインスレッド ⇔ 描画 Worker のメッセージ定義
 *
 * ここには DOM / three.js に依存する値を置かない（両方から読み込むため）。
 */

/** 行列は three.js と同じ column-major の 16 要素 */
export type Mat4 = number[]

/**
 * 1 辺の上限（px）。GPU のテクスチャ上限に合わせる。
 * アトラス（ステレオで横 2 倍）でもこの値を超えないように丸める。
 */
export const MAX_DIMENSION = 16384

/**
 * 描画サイズを canvas に渡せる値へ丸める。
 *
 * `0` / 負数 / `NaN` / `Infinity` をそのまま `canvas.width` 等へ代入すると
 * `TypeError` になり、Worker の描画ループが止まる。ウィンドウを極端に細くしたときや
 * アスペクト比が 0 になったときに発生しうるので、必ず 1 以上の有限整数にする。
 */
export function normalizeDimension(value: number, max = MAX_DIMENSION) {
  if (!Number.isFinite(value)) return 1
  return Math.min(max, Math.max(1, Math.round(value)))
}

export interface InitRequest {
  type: 'init'
  /** 1 視点ぶんの横幅（px）。キャンバスはこれを視点数ぶん横に並べたアトラスになる */
  width: number
  /** 1 視点ぶんの高さ（px） */
  height: number
  /**
   * 深度画像（距離を R,G の 16bit でパックした RGBA8）も返すか。
   * @internal experimental/DepthComposite 専用。通常のビューでは使わない。
   */
  depth?: boolean
  /**
   * 区間別の計測を有効にするか（既定 false）。
   *
   * true のときだけ Worker は `trackTimestamp` を有効にし、
   * `FrameResponse.timings` を返す。false のときは従来どおり計測しない。
   */
  profile?: boolean
  /** シーン側へ渡す任意のデータ（structured clone できるもの） */
  data?: unknown
}

export interface ResizeRequest {
  type: 'resize'
  /** 1 視点ぶんのサイズ */
  width: number
  height: number
}

/** 1 視点分のカメラ。2 つ渡すと左右ステレオになる */
export interface ViewMatrices {
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

export interface FrameRequest {
  type: 'frame'
  id: number
  /** 経過秒（Worker 側のアニメーション用） */
  time: number
  /** 前フレームからの秒数 */
  delta: number
  /**
   * 視点の配列。Worker は横に並べて描く（アトラス）。
   * 1 要素 = 単眼、2 要素 = ステレオ（[0] が左目、[1] が右目）
   */
  views: ViewMatrices[]
}

export interface DisposeRequest {
  type: 'dispose'
}

export type WorkerRequest = InitRequest | ResizeRequest | FrameRequest | DisposeRequest

export interface ReadyResponse {
  type: 'ready'
  /** 1 視点ぶんのサイズ */
  width: number
  height: number
  /** 実行中のバックエンド（基本は 'webgpu'） */
  backend: string
  /** アダプタ情報（取れない環境では空文字） */
  adapter: string
  /** シーン側が返した任意の情報（パーティクル数など） */
  meta?: Record<string, unknown>
}

export interface ErrorResponse {
  type: 'error'
  message: string
  /**
   * 描画を継続できないエラーか（既定 true）。
   * 初期化失敗は true、1 フレームの描画失敗は false（次のフレームを続ける）。
   */
  fatal?: boolean
}

/**
 * Worker 側 1 フレームの区間別計測（`InitRequest.profile` が true のときだけ送られる）。
 *
 * 数値の意味を区別するための定義:
 * - `updateMs` / `renderMs` / `snapshotMs` は Worker 内の JS 区間時間
 *  （`performance.now()` の差）。`renderMs` は `renderer.render()` の呼び出し時間で、
 *   GPU の完了待ちは含まない（完了待ちを含みうるのは `snapshotMs`）。
 * - `gpuRenderMs` / `gpuComputeMs` は GPU 上の実実行時間（timestamp-query）。
 *   取れない環境では `undefined` のままになる。
 * - `totalMs` は描画要求の受領から `postMessage` 直前までの全体。
 *
 * @internal 計測用（profile: true のときだけ返る）。公開 API ではない。
 */
export interface FrameTimings {
  /** userScene.update（パーティクルの compute 発行を含む）の JS 時間 (ms) */
  updateMs: number
  /** 描画ループ（renderer.render）の JS 時間 (ms) */
  renderMs: number
  /** transferToImageBitmap の時間 (ms)。GPU 完了待ちを含みうる */
  snapshotMs: number
  /** renderFrame 全体（postMessage 直前まで）(ms) */
  totalMs: number
  /** GPU の描画パス実時間 (ms)。timestamp-query が使えないときは undefined */
  gpuRenderMs?: number
  /** GPU の compute パス実時間 (ms)。同上 */
  gpuComputeMs?: number
}

export interface FrameResponse {
  type: 'result'
  id: number
  /** アトラス全体（幅 = 1 視点ぶん × 視点数） */
  bitmap: ImageBitmap
  /** depth: true のときだけ。R,G に 16bit 距離がパックされている */
  depthBitmap?: ImageBitmap
  /** アトラス全体のサイズ */
  width: number
  height: number
  /** Worker 側で 1 フレーム描画に要した時間（ms）。timings.totalMs と同じ値 */
  renderMs: number
  /** 区間別の内訳（profile: true のときだけ） */
  timings?: FrameTimings
}

export type WorkerResponse = ReadyResponse | ErrorResponse | FrameResponse

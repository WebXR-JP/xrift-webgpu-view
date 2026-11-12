/**
 * メインスレッド用の入口（`@webxr-jp/webgpu-view`）
 *
 * Worker 側は `@webxr-jp/webgpu-view/worker` から読み込む（React を巻き込まないため）。
 * 深度合成はここには含めない（`@webxr-jp/webgpu-view/experimental`）。
 */

export { GpuBackdrop } from './GpuBackdrop'
export type { GpuBackdropProps } from './GpuBackdrop'
export { selectTransferMode } from './transfer'
export type { TransferContext, TransferSelector } from './transfer'
export { useGpuWorker } from './useGpuWorker'
export type {
  GpuWorkerReadyInfo,
  UseGpuWorkerOptions,
  UseGpuWorkerResult,
  WorkerConstructor,
} from './useGpuWorker'
export type {
  BitmapFrameResponse,
  BufferFrameResponse,
  FrameRequest,
  FrameResponse,
  Mat4,
  TransferMode,
  ViewMatrices,
  WorkerResponse,
} from './protocol'

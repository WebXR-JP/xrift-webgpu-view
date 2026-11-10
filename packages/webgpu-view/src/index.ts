/**
 * メインスレッド用の入口（`@xrift/webgpu-view`）
 *
 * Worker 側は `@xrift/webgpu-view/worker` から読み込む（React を巻き込まないため）。
 * 深度合成はここには含めない（`@xrift/webgpu-view/experimental`）。
 */

export { GpuBackdrop } from './GpuBackdrop'
export type { GpuBackdropProps } from './GpuBackdrop'
export { useGpuWorker } from './useGpuWorker'
export type {
  GpuWorkerReadyInfo,
  UseGpuWorkerOptions,
  UseGpuWorkerResult,
  WorkerConstructor,
} from './useGpuWorker'
export type { FrameRequest, Mat4, ViewMatrices, WorkerResponse } from './protocol'

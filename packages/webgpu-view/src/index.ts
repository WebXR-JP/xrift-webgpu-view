/**
 * メインスレッド用の入口（`@xrift/webgpu-view`）
 *
 * Worker 側は `@xrift/webgpu-view/worker` から読み込む（React を巻き込まないため）。
 * 深度合成はここには含めない（`@xrift/webgpu-view/experimental`）。
 */

export { GpuWorkerView } from './GpuWorkerView'
export type { GpuWorkerViewProps } from './GpuWorkerView'
export { useGpuWorker } from './useGpuWorker'
export type {
  GpuWorkerReadyInfo,
  UseGpuWorkerOptions,
  UseGpuWorkerResult,
  WorkerConstructor,
} from './useGpuWorker'
export { getFrustumRect } from './frustum'
export type { FrustumRect, ViewAnchor, ViewRectOptions } from './frustum'
export type { FrameRequest, Mat4, ViewMatrices, WorkerResponse } from './protocol'

/**
 * Worker 側の入口（`@webxr-jp/webgpu-view/worker`）
 *
 * メインスレッド用の React / three.js（WebGL）を読み込まないよう、入口を分けている。
 */

export type { GpuWorkerRenderMode } from '../protocol'
export { defineGpuWorker } from './defineGpuWorker'
export type {
  GpuWorkerInit,
  GpuWorkerRenderContext,
  GpuWorkerScene,
  GpuWorkerSceneFactory,
  GpuWorkerUpdateContext,
} from './types'

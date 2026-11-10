import { defineGpuWorker } from '@xrift/webgpu-view/worker'
import { createDemoScene } from './demoScene'

/**
 * デモ用 Worker。
 *
 * トーンマップの有無はメインスレッドから `workerData` で渡す。
 * - GpuWorkerView: { toneMapping: true }  （Worker の見た目をそのまま出す）
 * - DepthComposite: { toneMapping: false }（合成パス側で ACES を掛ける）
 */
defineGpuWorker((init) => {
  const options = (init.data ?? {}) as { toneMapping?: boolean }
  return createDemoScene(init, { toneMapping: options.toneMapping !== false })
})

/**
 * 実験的な機能（安定 API ではない）
 *
 * 深度合成は WebGL2 に gl_FragDepth が無いため「深度を比較して色を選ぶ」方式で、
 * XR では動作しない。通常は `GpuWorkerView` を使うこと。
 */

export { DepthComposite } from './DepthComposite'
export type { DepthCompositeProps } from './DepthComposite'

/**
 * Worker 側の解像度（1 視点ぶん）を決める純粋関数。
 *
 * - モニタ時: キャンバスの CSS サイズ × dpr を視点数で割って `maxWidth` で抑える（従来どおり）。
 * - XR 提示中: `size`（r3f が測ったブラウザのウィンドウの CSS サイズ）を使わない。
 *   `size` は XR フレームバッファの解像度ではないため、PICO のようにウィンドウが
 *   小さい環境では Worker の描画幅が 300px 台まで落ち、拡大で極端にぼやける。
 *   代わりに `maxWidth * resolutionScale` をそのまま 1 視点ぶんの幅にする
 *   （ステレオでも視点数で割らない。アトラスは視点数ぶん横に並ぶので、
 *   1 視点ぶんの幅が `maxWidth` という意味は保たれる）。
 */
export interface BackdropResolutionInput {
  /** XR 提示中か（呼び出し側は `gl.xr.isPresenting` に対応する状態を渡す） */
  presenting: boolean
  /** r3f が測ったキャンバスの CSS 幅（モニタ時だけ使う） */
  cssWidth: number
  dpr: number
  resolutionScale: number
  /** 1 視点ぶんの上限（px）。XR 中はこの値を基準にする */
  maxWidth: number
  /** モニタ時の視点数（XR 中は使わない） */
  eyeCount: number
  /** 1 視点ぶんのアスペクト（XR 1 視点モードでは対称射影のもの） */
  aspect: number
}

export function computeBackdropResolution(
  input: BackdropResolutionInput,
): { width: number; height: number } {
  const baseWidth = input.presenting
    ? input.maxWidth * input.resolutionScale
    : (input.cssWidth * input.dpr * input.resolutionScale) / input.eyeCount
  const width = Math.max(64, Math.min(input.maxWidth, Math.round(baseWidth)))
  // アスペクトが 0 / NaN のときに高さが Infinity にならないようにする
  return { width, height: Math.max(1, Math.round(width / input.aspect)) }
}

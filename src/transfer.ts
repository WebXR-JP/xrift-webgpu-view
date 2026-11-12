/**
 * 受け渡し経路（transfer）の既定の選択ロジック
 *
 * - ディスクリート GPU らしい名前（GeForce / RTX / Radeon RX・Pro / Arc A・B など）を
 *   見つけたら `'bitmap'` を優先する。GPU→CPU の読み戻しが PCIe 経由になり、
 *   buffer 経路のコストが無視できなくなるため。
 * - Blink（Chrome / Edge / Opera など）は `'bitmap'` を優先する。ImageBitmap →
 *   テクスチャのアップロードが非同期で安く、読み戻しを挟む利点が小さいため。
 * - どちらでもなければ `'buffer'`。Safari は 1280×833 で ImageBitmap のアップロードに
 *   18ms、Uint8Array なら 0.4ms という実測があり、読み戻し（2.25ms）を挟んでも速い。
 *
 * あくまでレンダラ名と UA の文字列によるヒューリスティック。
 * 外れる環境では `transfer` に自前の関数を渡して上書きする。
 */

import type { TransferMode } from './protocol'

/** 経路選択に渡す情報。マウント時に 1 回だけ評価する。 */
export interface TransferContext {
  /** 1 視点ぶんの初期サイズ（px） */
  width: number
  height: number
  /** メインスレッドの WebGL レンダラ名（取れない環境では空文字） */
  renderer: string
  /** navigator.userAgent */
  userAgent: string
}

/** 環境を見て受け渡し経路を選ぶ関数（マウント時に 1 回だけ呼ばれる） */
export type TransferSelector = (context: TransferContext) => TransferMode

/**
 * ディスクリート GPU らしい名前。
 *
 * `Radeon(TM) Graphics` / `Radeon 780M` / `Arc Graphics` のような iGPU を拾わないよう、
 * Radeon は RX / Pro / VII 系、Arc は型番（A770, B580 など）が続くものだけにする。
 */
const DISCRETE_GPU =
  /\b(geforce|rtx|gtx|quadro)\b|\bradeon\s+(rx|pro|vii)\b|\barc\b[^,;]{0,16}?\b[ab]\d{3}\b/i

/**
 * Blink ベースのブラウザ。
 * iOS の Chrome（CriOS）や Firefox は含まれない（それぞれ WebKit / Gecko）。
 */
const BLINK_BROWSER = /(chrome|chromium|edg|opr|samsungbrowser)\//i

/**
 * 既定の経路選択。
 *
 * 1. ディスクリート GPU → `'bitmap'`
 * 2. Blink の Chromium → `'bitmap'`
 * 3. それ以外 → `'buffer'`
 */
export function selectTransferMode({ renderer, userAgent }: TransferContext): TransferMode {
  if (DISCRETE_GPU.test(renderer)) return 'bitmap'
  if (BLINK_BROWSER.test(userAgent)) return 'bitmap'
  return 'buffer'
}

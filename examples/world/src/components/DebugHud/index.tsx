/**
 * 開発用のオンスクリーン HUD（`?debug=1` のときだけ dev.tsx が描画する）。
 *
 * iPad などコンソールを開きにくい実機で「固まったのか / どこで止まったのか」を
 * 画面だけで切り分けるためのもの。`dev.tsx` 専用なので本番ビルドには含まれない。
 *
 * - 回転インジケータは CSS アニメーション（メインスレッドが詰まっても合成側で回り続ける）
 * - `main` は requestAnimationFrame の実測。**止まったらメインスレッドが固まっている**
 * - `worker` は Worker から描画結果が返ってきた数。main が動いていて worker が 0 なら
 *   Worker / GPU 側が止まっている
 * - `stats` は最後に `webgpu-view:stats` を受けてからの経過秒
 */

import { useEffect, useRef, useState } from 'react'

/** World.tsx が CustomEvent で流す計測値（GpuWorkerStats の必要な項目だけ） */
interface HudStats {
  fps: number
  frames: number
  width: number
  height: number
  roundTripMs: number
  intervalMs: number
  snapshotMs: number
  mainRenderMs: number
  workerTotalMs: number
  gpuRenderMs?: number
  gpuComputeMs?: number
}

interface MainCounters {
  /** 起動からの経過秒 */
  elapsed: number
  /** requestAnimationFrame の回数 */
  frames: number
  /** 直近 500ms の fps */
  fps: number
}

const boxStyle: React.CSSProperties = {
  position: 'fixed',
  top: 12,
  left: 12,
  zIndex: 2000,
  pointerEvents: 'none',
  padding: '8px 10px',
  borderRadius: 6,
  background: 'rgba(0, 0, 0, 0.72)',
  color: '#e5e7eb',
  font: '11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
  whiteSpace: 'pre',
  textShadow: '0 1px 2px rgba(0,0,0,0.8)',
}

const spinnerStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 10,
  height: 10,
  marginRight: 6,
  borderRadius: '50%',
  border: '2px solid rgba(229,231,235,0.35)',
  borderTopColor: '#22c55e',
  animation: 'webgpu-view-hud-spin 1s linear infinite',
  verticalAlign: '-1px',
}

const frames = (n: number) => n.toFixed(1)

export const DebugHud: React.FC = () => {
  const [main, setMain] = useState<MainCounters>({ elapsed: 0, frames: 0, fps: 0 })
  const [stats, setStats] = useState<HudStats | null>(null)
  const [statsAge, setStatsAge] = useState<number | null>(null)
  const [transfer, setTransfer] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lastStatsAt = useRef<number>(performance.now())

  useEffect(() => {
    const onStats = (event: Event) => {
      lastStatsAt.current = performance.now()
      setStats((event as CustomEvent<HudStats>).detail)
    }
    const onError = (event: Event) => {
      setError((event as CustomEvent<string>).detail)
    }
    const onReady = (event: Event) => {
      const detail = (event as CustomEvent<{ transfer?: string }>).detail
      if (detail?.transfer) setTransfer(detail.transfer)
    }
    window.addEventListener('webgpu-view:stats', onStats)
    window.addEventListener('webgpu-view:error', onError)
    window.addEventListener('webgpu-view:ready', onReady)
    return () => {
      window.removeEventListener('webgpu-view:stats', onStats)
      window.removeEventListener('webgpu-view:error', onError)
      window.removeEventListener('webgpu-view:ready', onReady)
    }
  }, [])

  useEffect(() => {
    const startedAt = performance.now()
    let total = 0
    let windowFrames = 0
    let windowStart = startedAt
    let lastEmit = 0
    let raf = 0

    const tick = () => {
      const now = performance.now()
      total++
      windowFrames++

      if (now - lastEmit >= 500) {
        lastEmit = now
        const windowMs = now - windowStart
        setMain({
          elapsed: (now - startedAt) / 1000,
          frames: total,
          fps: windowMs > 0 ? (windowFrames * 1000) / windowMs : 0,
        })
        setStatsAge((now - lastStatsAt.current) / 1000)
        windowFrames = 0
        windowStart = now
      }
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const gpu = typeof navigator !== 'undefined' && 'gpu' in navigator
  const secure = typeof window !== 'undefined' ? window.isSecureContext : false

  const workerLine = stats
    ? `worker ${frames(stats.fps)}fps (${stats.frames} frames)  ${stats.width}x${stats.height}`
    : 'worker -- (stats は ?profile=1 で有効)'

  const timingLine = stats
    ? `rt ${frames(stats.roundTripMs)}ms  w ${frames(stats.workerTotalMs)}ms  snap ${frames(
        stats.snapshotMs,
      )}ms  gpu ${stats.gpuRenderMs === undefined ? '--' : frames(stats.gpuRenderMs)}ms  main ${frames(
        stats.mainRenderMs,
      )}ms  send ${frames(stats.intervalMs)}ms`
    : ''

  return (
    <div style={boxStyle}>
      <style>{'@keyframes webgpu-view-hud-spin{to{transform:rotate(360deg)}}'}</style>
      <div>
        <span style={spinnerStyle} />
        {main.elapsed.toFixed(1)}s  main {frames(main.fps)}fps ({main.frames})
      </div>
      <div>{workerLine}</div>
      {timingLine ? <div>{timingLine}</div> : null}
      <div>
        stats {statsAge === null ? '--' : `${statsAge.toFixed(1)}s ago`}  secure{' '}
        {secure ? 'yes' : 'no'}  gpu {gpu ? 'yes' : 'no'}  transfer {transfer ?? '--'}
      </div>
      {error ? <div style={{ color: '#f87171', whiteSpace: 'pre-wrap' }}>error: {error}</div> : null}
    </div>
  )
}

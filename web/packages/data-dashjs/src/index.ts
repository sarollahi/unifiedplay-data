import type { VideoMonitor } from '@unifiedplay/data'

interface Representation { bandwidth?: number; width?: number; height?: number }
interface BitrateInfo { bitrate: number; width: number; height: number }
type QualityEvent = { mediaType?: string; newQuality?: number; newRepresentation?: Representation }
type ErrorEvent = { error?: { code?: number | string; message?: string } | string }
interface DashLike {
  on(type: string, listener: (event: QualityEvent & ErrorEvent) => void): void
  off(type: string, listener: (event: QualityEvent & ErrorEvent) => void): void
  /** dash.js 4. */
  getBitrateInfoListFor?(type: 'video'): BitrateInfo[]
}

/** Bitrates and errors from a dash.js player (4.x or 5.x) playing into a monitored element. Returns a function that stops listening. */
export function trackDashJs(monitor: VideoMonitor, dash: DashLike): () => void {
  const rendered = (event: QualityEvent) => {
    if (event.mediaType !== 'video') return
    // dash.js 5 sends the representation; 4 sends an index into the bitrate list.
    const next = event.newRepresentation
    if (next) { monitor.rendition(next.bandwidth ? next.bandwidth / 1000 : null, next.width ?? null, next.height ?? null); return }
    const info = event.newQuality === undefined ? undefined : dash.getBitrateInfoListFor?.('video')[event.newQuality]
    if (info) monitor.rendition(info.bitrate / 1000, info.width || null, info.height || null)
  }
  const error = (event: ErrorEvent) => {
    const failure = typeof event.error === 'object' ? event.error : { code: event.error, message: '' }
    monitor.error(String(failure?.code ?? 'dashjs'), failure?.message ?? '', true)
  }
  dash.on('qualityChangeRendered', rendered)
  dash.on('error', error)
  return () => { dash.off('qualityChangeRendered', rendered); dash.off('error', error) }
}

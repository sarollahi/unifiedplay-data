import type { VideoMonitor } from '@unifiedplay/data'

interface HlsLevel { bitrate: number; width: number; height: number }
type HlsData = { level?: number; fatal?: boolean; details?: string; type?: string }
interface HlsLike {
  levels: HlsLevel[]
  on(event: string, listener: (event: string, data: HlsData) => void): void
  off(event: string, listener: (event: string, data: HlsData) => void): void
}

/** Bitrates and errors from an hls.js instance playing into a monitored element. Returns a function that stops listening. */
export function trackHlsJs(monitor: VideoMonitor, hls: HlsLike): () => void {
  const switched = (_: string, data: HlsData) => {
    const level = data.level === undefined ? undefined : hls.levels[data.level]
    if (level) monitor.rendition(level.bitrate / 1000, level.width || null, level.height || null)
  }
  const error = (_: string, data: HlsData) => {
    monitor.error(data.details ?? data.type ?? 'hls', data.type ?? '', Boolean(data.fatal))
  }
  hls.on('hlsLevelSwitched', switched)
  hls.on('hlsError', error)
  return () => { hls.off('hlsLevelSwitched', switched); hls.off('hlsError', error) }
}

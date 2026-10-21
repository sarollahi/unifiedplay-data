import type { VideoMonitor } from '@unifiedplay/data'

interface ShakaVariant { active: boolean; bandwidth: number; width: number | null; height: number | null }
type ShakaErrorEvent = Event & { detail?: { code?: number; severity?: number; message?: string } }
interface ShakaLike {
  addEventListener(type: string, listener: (event: ShakaErrorEvent) => void): void
  removeEventListener(type: string, listener: (event: ShakaErrorEvent) => void): void
  getVariantTracks(): ShakaVariant[]
}

/** Bitrates and errors from a Shaka Player instance playing into a monitored element. Returns a function that stops listening. */
export function trackShaka(monitor: VideoMonitor, shaka: ShakaLike): () => void {
  const variant = () => {
    const active = shaka.getVariantTracks().find(track => track.active)
    if (active) monitor.rendition(active.bandwidth / 1000, active.width, active.height)
  }
  const error = (event: ShakaErrorEvent) => {
    const detail = event.detail ?? {}
    // 7000-7003: a load cut short or a player torn down (the viewer moved on), not a failure.
    if (detail.code !== undefined && detail.code >= 7000 && detail.code <= 7003) return
    // Shaka severity 2 is CRITICAL: playback stopped.
    monitor.error(String(detail.code ?? 'shaka'), detail.message ?? '', detail.severity === 2)
  }
  const events = ['adaptation', 'variantchanged', 'trackschanged']
  for (const name of events) shaka.addEventListener(name, variant)
  shaka.addEventListener('error', error)
  return () => {
    for (const name of events) shaka.removeEventListener(name, variant)
    shaka.removeEventListener('error', error)
  }
}

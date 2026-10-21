import type { VideoMonitor } from '@unifiedplay/data'

type AdEvent = { type: string }
type AdErrorEvent = { getError?(): { getErrorCode?(): number; getMessage?(): string } }
interface Emitter {
  addEventListener(type: string, listener: (event: AdEvent & AdErrorEvent) => void, useCapture?: boolean): void
  removeEventListener(type: string, listener: (event: AdEvent & AdErrorEvent) => void, useCapture?: boolean): void
}
/** The parts of google.ima this needs: its event type names. */
interface ImaLike {
  AdEvent: { Type: Record<string, string> }
  AdErrorEvent: { Type: { AD_ERROR: string } }
}

/**
 * Ads from the IMA HTML5 SDK on a monitored player: ad breaks, ads played, ad watch time and ad
 * errors. Pass the AdsManager (and the AdsLoader, for errors loading the ads). Returns a function
 * that stops listening.
 */
export function trackIma(
  monitor: VideoMonitor,
  adsManager: Emitter,
  adsLoader?: Emitter | null,
  ima: ImaLike = (globalThis as unknown as { google: { ima: ImaLike } }).google.ima,
): () => void {
  const type = ima.AdEvent.Type
  const handlers: Array<[Emitter, string, () => void]> = [
    [adsManager, type.CONTENT_PAUSE_REQUESTED, () => monitor.adBreakStart()],
    [adsManager, type.CONTENT_RESUME_REQUESTED, () => monitor.adBreakEnd()],
    [adsManager, type.ALL_ADS_COMPLETED, () => monitor.adBreakEnd()],
    [adsManager, type.LOADED, () => monitor.adStart()],
    [adsManager, type.STARTED, () => monitor.adPlaying()],
    [adsManager, type.RESUMED, () => monitor.adPlaying()],
    [adsManager, type.PAUSED, () => monitor.adPause()],
    [adsManager, type.COMPLETE, () => monitor.adEnd()],
    [adsManager, type.SKIPPED, () => monitor.adEnd()],
  ]
  const error = (event: AdErrorEvent) => {
    const failure = event.getError?.()
    monitor.adError(String(failure?.getErrorCode?.() ?? 'ima'), failure?.getMessage?.() ?? '')
  }
  const errorTargets = adsLoader ? [adsManager, adsLoader] : [adsManager]
  for (const [target, name, handler] of handlers) if (name) target.addEventListener(name, handler)
  for (const target of errorTargets) target.addEventListener(ima.AdErrorEvent.Type.AD_ERROR, error)
  return () => {
    for (const [target, name, handler] of handlers) if (name) target.removeEventListener(name, handler)
    for (const target of errorTargets) target.removeEventListener(ima.AdErrorEvent.Type.AD_ERROR, error)
  }
}

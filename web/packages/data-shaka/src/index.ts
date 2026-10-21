import { drmTypeOf, hostnameOf, type RequestType, type VideoMonitor } from '@unifiedplay/data'

interface ShakaVariant { active: boolean; bandwidth: number; width: number | null; height: number | null }
type ShakaErrorEvent = Event & { detail?: { code?: number; category?: number; severity?: number; message?: string; data?: unknown[] } }
interface ShakaResponse { uri: string; data?: ArrayBuffer | ArrayBufferView; headers?: Record<string, string>; timeMs?: number }
interface ShakaContext { type?: number; stream?: { type?: string } | null }
type ResponseFilter = (type: number, response: ShakaResponse, context?: ShakaContext) => void
interface ShakaLike {
  addEventListener(type: string, listener: (event: ShakaErrorEvent) => void): void
  removeEventListener(type: string, listener: (event: ShakaErrorEvent) => void): void
  getVariantTracks(): ShakaVariant[]
  getNetworkingEngine?(): { registerResponseFilter(filter: ResponseFilter): void; unregisterResponseFilter(filter: ResponseFilter): void } | null
  drmInfo?(): { keySystem?: string } | null
  isLive?(): boolean
  getStats?(): { liveLatency?: number }
}

// shaka.net.NetworkingEngine.RequestType and AdvancedRequestType.
const MANIFEST = 0, SEGMENT = 1, LICENSE = 2, SERVER_CERTIFICATE = 5, KEY = 6
const INIT_SEGMENT = 0
// Network errors (category 1): BAD_HTTP_STATUS, HTTP_ERROR, TIMEOUT, and where their request type sits in data.
const NETWORK_ERRORS: Record<number, number> = { 1001: 4, 1002: 2, 1003: 1 }

function requestType(type: number, context?: ShakaContext): RequestType | null {
  if (type === MANIFEST) return 'manifest'
  if (type === LICENSE || type === KEY || type === SERVER_CERTIFICATE) return 'encryption'
  if (type !== SEGMENT) return null
  const stream = context?.stream?.type
  if (stream === 'text') return 'subtitle'
  if (context?.type === INIT_SEGMENT) return stream === 'audio' ? 'audio_init' : 'video_init'
  return stream === 'audio' ? 'audio' : stream === 'video' ? 'video' : 'media'
}

/**
 * Bitrates, errors, network requests (manifests, segments, licenses: throughput, failures, the CDN
 * from X-CDN; Shaka does not report time to first byte) and the DRM from a Shaka Player instance
 * playing into a monitored element. Returns a function that stops listening.
 */
export function trackShaka(monitor: VideoMonitor, shaka: ShakaLike): () => void {
  const variant = () => {
    const active = shaka.getVariantTracks().find(track => track.active)
    if (active) monitor.rendition(active.bandwidth / 1000, active.width, active.height)
    const latency = shaka.isLive?.() ? shaka.getStats?.().liveLatency : undefined
    if (latency && latency > 0) monitor.liveLatency(latency * 1000)
    const drm = drmTypeOf(shaka.drmInfo?.()?.keySystem)
    if (drm) monitor.setDrmType(drm)
  }
  const error = (event: ShakaErrorEvent) => {
    const detail = event.detail ?? {}
    const slot = detail.category === 1 ? NETWORK_ERRORS[detail.code ?? 0] : undefined
    if (slot !== undefined) {
      const data = detail.data ?? []
      monitor.requestFailed({
        type: requestType(Number(data[slot])) ?? undefined, hostname: hostnameOf(String(data[0] ?? '')),
        error: String(detail.code), errorCode: detail.code === 1001 ? Number(data[1]) : undefined,
      })
    }
    // 7000-7003: a load cut short or a player torn down (the viewer moved on), not a failure.
    if (detail.code !== undefined && detail.code >= 7000 && detail.code <= 7003) return
    // Shaka severity 2 is CRITICAL: playback stopped.
    monitor.error(String(detail.code ?? 'shaka'), detail.message ?? '', detail.severity === 2)
  }
  const responses: ResponseFilter = (type, response, context) => {
    const kind = requestType(type, context)
    if (!kind) return
    monitor.requestCompleted({
      type: kind, hostname: hostnameOf(response.uri), headers: response.headers, bytes: response.data?.byteLength,
      start: response.timeMs === undefined ? undefined : 0, responseEnd: response.timeMs,
    })
  }
  const events = ['adaptation', 'variantchanged', 'trackschanged']
  for (const name of events) shaka.addEventListener(name, variant)
  shaka.addEventListener('error', error)
  const engine = shaka.getNetworkingEngine?.()
  engine?.registerResponseFilter(responses)
  return () => {
    for (const name of events) shaka.removeEventListener(name, variant)
    shaka.removeEventListener('error', error)
    engine?.unregisterResponseFilter(responses)
  }
}

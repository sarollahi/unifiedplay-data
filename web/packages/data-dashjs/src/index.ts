import { drmTypeOf, hostnameOf, type RequestType, type VideoMonitor } from '@unifiedplay/data'

interface Representation { bandwidth?: number; width?: number; height?: number }
interface BitrateInfo { bitrate: number; width: number; height: number }
/** dash.js's own request object (FragmentRequest and friends). */
interface DashRequest {
  type?: string | null; mediaType?: string; url?: string | null
  startDate?: Date; firstByteDate?: Date; requestEndDate?: Date | null; bytesLoaded?: number
}
type DashEvent = {
  mediaType?: string; newQuality?: number; newRepresentation?: Representation
  error?: { code?: number | string; message?: string; data?: { request?: DashRequest; url?: string } } | string
  request?: DashRequest; data?: { keySystem?: { systemString?: string } } | null
}
/** dash.js 5: every response passes through response interceptors. */
interface DashResponse {
  request: { url: string; customData?: { request?: DashRequest } }
  status?: number; statusText?: string; headers?: Record<string, string>
  resourceTiming?: { startTime: number; responseStart?: number; duration: number; encodedBodySize: number }
}
interface DashLike {
  on(type: string, listener: (event: DashEvent) => void): void
  off(type: string, listener: (event: DashEvent) => void): void
  /** dash.js 4. */
  getBitrateInfoListFor?(type: 'video'): BitrateInfo[]
  addResponseInterceptor?(interceptor: (response: DashResponse) => Promise<DashResponse>): void
  removeResponseInterceptor?(interceptor: (response: DashResponse) => Promise<DashResponse>): void
}

// dash.js errors that are a failed download, and what it was (spec: Requests).
const DOWNLOAD_ERRORS: Record<number, RequestType> = { 11: 'manifest', 25: 'manifest', 26: 'video', 27: 'video', 28: 'video_init', 17: 'video' }

function requestType(request: DashRequest | undefined): RequestType | null {
  const media = request?.mediaType
  switch (request?.type) {
    case 'MPD': return 'manifest'
    case 'InitializationSegment': return media === 'audio' ? 'audio_init' : 'video_init'
    case 'MediaSegment': return media === 'audio' ? 'audio' : media === 'text' ? 'subtitle' : 'video'
    case 'license': case 'LicenseRequest': return 'encryption'
    default: return null // xlink, clock sync, index…: not the content
  }
}

/**
 * Bitrates, errors, network requests (manifests and segments: throughput, time to first byte,
 * failures, the CDN from X-CDN) and the DRM from a dash.js player (4.x or 5.x) playing into a
 * monitored element. Returns a function that stops listening.
 */
export function trackDashJs(monitor: VideoMonitor, dash: DashLike): () => void {
  const rendered = (event: DashEvent) => {
    if (event.mediaType !== 'video') return
    // dash.js 5 sends the representation; 4 sends an index into the bitrate list.
    const next = event.newRepresentation
    if (next) { monitor.rendition(next.bandwidth ? next.bandwidth / 1000 : null, next.width ?? null, next.height ?? null); return }
    const info = event.newQuality === undefined ? undefined : dash.getBitrateInfoListFor?.('video')[event.newQuality]
    if (info) monitor.rendition(info.bitrate / 1000, info.width || null, info.height || null)
  }
  const error = (event: DashEvent) => {
    const failure = typeof event.error === 'object' ? event.error : { code: event.error, message: '', data: undefined }
    // dash.js 4 has no interceptors: its download errors are the failed requests.
    const type = interceptor ? null : DOWNLOAD_ERRORS[Number(failure?.code)]
    if (type) monitor.requestFailed({ type, hostname: hostnameOf(failure?.data?.request?.url ?? failure?.data?.url), error: String(failure?.code), errorText: failure?.message })
    monitor.error(String(failure?.code ?? 'dashjs'), failure?.message ?? '', true)
  }
  const keySystem = (event: DashEvent) => {
    const drm = drmTypeOf(event.data?.keySystem?.systemString)
    if (drm) monitor.setDrmType(drm)
  }
  // dash.js 5: timings and headers of every response.
  const interceptor = dash.addResponseInterceptor ? async (response: DashResponse) => {
    const type = requestType(response.request.customData?.request)
    if (type) {
      const hostname = hostnameOf(response.request.url)
      if ((response.status ?? 200) >= 400) {
        monitor.requestFailed({ type, hostname, error: 'HTTP', errorCode: response.status, errorText: response.statusText })
      } else {
        const timing = response.resourceTiming
        monitor.requestCompleted({
          type, hostname, headers: response.headers, bytes: timing?.encodedBodySize,
          start: timing?.startTime, responseStart: timing?.responseStart, responseEnd: timing ? timing.startTime + timing.duration : undefined,
        })
      }
    }
    return response
  } : null
  // dash.js 4: segment timings from its own events.
  const fragmentLoaded = (event: DashEvent) => {
    const request = event.request
    const type = requestType(request ?? undefined)
    if (!type || !request) return
    monitor.requestCompleted({
      type, hostname: hostnameOf(request.url), bytes: request.bytesLoaded,
      start: request.startDate?.getTime(), responseStart: request.firstByteDate?.getTime(), responseEnd: request.requestEndDate?.getTime(),
    })
  }
  const manifestLoaded = () => monitor.requestCompleted({ type: 'manifest' })
  const abandoned = (event: DashEvent) => monitor.requestCanceled({ type: event.mediaType === 'audio' ? 'audio' : 'video', hostname: hostnameOf(event.request?.url) })

  dash.on('qualityChangeRendered', rendered)
  dash.on('error', error)
  dash.on('public_keySystemSelected', keySystem)
  dash.on('fragmentLoadingAbandoned', abandoned)
  if (interceptor) dash.addResponseInterceptor!(interceptor)
  else { dash.on('fragmentLoadingCompleted', fragmentLoaded); dash.on('manifestLoaded', manifestLoaded) }
  return () => {
    dash.off('qualityChangeRendered', rendered)
    dash.off('error', error)
    dash.off('public_keySystemSelected', keySystem)
    dash.off('fragmentLoadingAbandoned', abandoned)
    if (interceptor) dash.removeResponseInterceptor?.(interceptor)
    else { dash.off('fragmentLoadingCompleted', fragmentLoaded); dash.off('manifestLoaded', manifestLoaded) }
  }
}

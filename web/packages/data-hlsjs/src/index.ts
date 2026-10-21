import { drmTypeOf, hostnameOf, type RequestInfo, type RequestType, type VideoMonitor } from '@unifiedplay/data'

interface HlsLevel { bitrate: number; width: number; height: number }
interface HlsStats { loaded: number; loading: { start: number; first: number; end: number } }
interface HlsFragment { type?: string; sn?: number | 'initSegment'; url?: string | null; stats?: HlsStats; decryptdata?: { keyFormat?: string } | null }
/** An XMLHttpRequest (xhr loader) or a fetch Response (fetch loader). */
type NetworkDetails = { getResponseHeader?(name: string): string | null; headers?: { get(name: string): string | null } } | null
type HlsData = {
  level?: number; fatal?: boolean; details?: string; type?: string; url?: string
  frag?: HlsFragment; part?: { stats?: HlsStats } | null; stats?: HlsStats; networkDetails?: NetworkDetails
  response?: { code?: number; text?: string }; context?: { url?: string }
  keyInfo?: { decryptdata?: { keyFormat?: string; uri?: string } }
}
interface HlsLike {
  levels: HlsLevel[]
  on(event: string, listener: (event: string, data: HlsData) => void): void
  off(event: string, listener: (event: string, data: HlsData) => void): void
}

// hls.js load errors and what they were loading (spec: Requests).
const LOAD_ERRORS: Record<string, 'manifest' | 'fragment' | 'encryption'> = {
  manifestLoadError: 'manifest', manifestLoadTimeOut: 'manifest', levelLoadError: 'manifest', levelLoadTimeOut: 'manifest',
  audioTrackLoadError: 'manifest', audioTrackLoadTimeOut: 'manifest', subtitleTrackLoadError: 'manifest', subtitleTrackLoadTimeOut: 'manifest',
  fragLoadError: 'fragment', fragLoadTimeOut: 'fragment', keyLoadError: 'encryption', keyLoadTimeOut: 'encryption',
}

function fragmentType(frag: HlsFragment | undefined): RequestType {
  const init = frag?.sn === 'initSegment'
  if (frag?.type === 'audio') return init ? 'audio_init' : 'audio'
  if (frag?.type === 'subtitle') return 'subtitle'
  return init ? 'video_init' : 'video'
}

function headers(details: NetworkDetails | undefined): RequestInfo['headers'] {
  if (!details) return undefined
  return name => details.getResponseHeader?.(name) ?? details.headers?.get(name) ?? null
}

function loaded(type: RequestType, url: string | null | undefined, stats: HlsStats | undefined, details: NetworkDetails | undefined): RequestInfo {
  const timing = stats?.loading
  return {
    type, hostname: hostnameOf(url), bytes: stats?.loaded,
    start: timing?.start, responseStart: timing?.first || undefined, responseEnd: timing?.end || undefined, headers: headers(details),
  }
}

/**
 * Bitrates, errors, network requests (manifests, segments, keys: throughput, time to first byte,
 * failures, the CDN from X-CDN) and the DRM from an hls.js instance playing into a monitored
 * element. Returns a function that stops listening.
 */
export function trackHlsJs(monitor: VideoMonitor, hls: HlsLike): () => void {
  const listeners: Record<string, (event: string, data: HlsData) => void> = {
    hlsLevelSwitched: (_, data) => {
      const level = data.level === undefined ? undefined : hls.levels[data.level]
      if (level) monitor.rendition(level.bitrate / 1000, level.width || null, level.height || null)
    },
    hlsManifestLoaded: (_, data) => monitor.requestCompleted(loaded('manifest', data.url, data.stats, data.networkDetails)),
    hlsLevelLoaded: (_, data) => monitor.requestCompleted(loaded('manifest', data.context?.url, data.stats, data.networkDetails)),
    hlsAudioTrackLoaded: (_, data) => monitor.requestCompleted(loaded('manifest', data.context?.url, data.stats, data.networkDetails)),
    hlsSubtitleTrackLoaded: (_, data) => monitor.requestCompleted(loaded('manifest', data.context?.url, data.stats, data.networkDetails)),
    hlsFragLoaded: (_, data) => monitor.requestCompleted(loaded(fragmentType(data.frag), data.frag?.url, data.part?.stats ?? data.frag?.stats, data.networkDetails)),
    hlsFragLoadEmergencyAborted: (_, data) => monitor.requestCanceled({ type: fragmentType(data.frag), hostname: hostnameOf(data.frag?.url) }),
    hlsKeyLoaded: (_, data) => {
      const key = data.keyInfo?.decryptdata ?? data.frag?.decryptdata
      const drm = drmTypeOf(key?.keyFormat)
      if (drm) monitor.setDrmType(drm)
      monitor.requestCompleted({ type: 'encryption', hostname: hostnameOf((key as { uri?: string } | undefined)?.uri) })
    },
    hlsError: (_, data) => {
      const loading = LOAD_ERRORS[data.details ?? '']
      if (loading) {
        monitor.requestFailed({
          type: loading === 'fragment' ? fragmentType(data.frag) : loading,
          hostname: hostnameOf(data.frag?.url ?? data.url ?? data.context?.url),
          error: data.details, errorCode: data.response?.code, errorText: data.response?.text,
        })
      }
      monitor.error(data.details ?? data.type ?? 'hls', data.type ?? '', Boolean(data.fatal))
    },
  }
  for (const [name, listener] of Object.entries(listeners)) hls.on(name, listener)
  return () => { for (const [name, listener] of Object.entries(listeners)) hls.off(name, listener) }
}

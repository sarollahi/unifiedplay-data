import { hostnameOf, monitorVideo, type DataClient, type RequestType, type VideoInfo, type VideoMonitor } from '@unifiedplay/data'

interface VhsPlaylist { attributes?: { BANDWIDTH?: number; RESOLUTION?: { width: number; height: number }; CODECS?: string; 'FRAME-RATE'?: number | string } }
/** The XMLHttpRequest Video.js's streaming engine (VHS) made, with what VHS adds to it. */
interface VhsRequest { uri?: string; requestType?: string; requestTime?: number; aborted?: boolean; response?: ArrayBuffer | string | null; responseText?: string }
type ResponseHook = (request: VhsRequest, error: unknown, response: { statusCode?: number; headers?: Record<string, string> } | undefined) => void
interface VhsLike {
  playlists?: { media(): VhsPlaylist | undefined; on(type: string, listener: () => void): void }
  xhr?: { onResponse?(hook: ResponseHook): void; offResponse?(hook: ResponseHook): void }
}
interface VideoJsPlayer {
  el(): Element
  on(type: string, listener: () => void): void
  off(type: string, listener: () => void): void
  error(): { code: number; message: string } | null
  tech(options?: { IWillNotUseThisInPlugins: boolean }): { vhs?: VhsLike } | undefined
}

// VHS's requestType for each request, and what it is (spec: Requests). VHS does not say audio or video.
const REQUEST_TYPES: Record<string, RequestType> = {
  'hls-playlist': 'manifest', 'dash-manifest': 'manifest', 'content-steering-manifest': 'manifest',
  segment: 'media', 'segment-media-initialization': 'video_init', 'segment-key': 'encryption',
}

/**
 * Watches a Video.js player (Brightcove's player too): its <video> element through monitorVideo,
 * plus HLS/DASH bitrates, network requests (throughput, failures, the CDN from X-CDN) from
 * Video.js's own streaming engine (VHS) and the player's errors.
 */
export function monitorVideoJs(client: DataClient, player: VideoJsPlayer, video: VideoInfo, version?: string, name = 'videojs'): VideoMonitor & { stop(): void } {
  const element = player.el().querySelector('video')
  if (!element) throw new Error('This Video.js player has no <video> element (the html5 tech is needed)')
  // name: 'brightcove' for a Brightcove Player (it is Video.js), so the Console tells them apart.
  const monitor = monitorVideo(client, element, video, { name, version, software: name === 'brightcove' ? 'Brightcove Player' : 'Video.js', softwareVersion: version })
  const vhs = () => player.tech({ IWillNotUseThisInPlugins: true })?.vhs
  const media = () => {
    const attributes = vhs()?.playlists?.media()?.attributes
    if (attributes) monitor.rendition(attributes.BANDWIDTH ? attributes.BANDWIDTH / 1000 : null, attributes.RESOLUTION?.width ?? null, attributes.RESOLUTION?.height ?? null,
      { videoCodec: attributes.CODECS?.split(',')[0], framerate: Number(attributes['FRAME-RATE']) || undefined })
  }
  // VHS exists once a source is loaded; it reports each rendition change on its playlists.
  const loaded = () => vhs()?.playlists?.on('mediachange', media)
  const error = () => {
    const failure = player.error()
    if (failure) monitor.error(String(failure.code), failure.message ?? '', true)
  }
  const responded: ResponseHook = (request, failure, response) => {
    const type = REQUEST_TYPES[request.requestType ?? '']
    if (!type) return
    const hostname = hostnameOf(request.uri)
    if (request.aborted) { monitor.requestCanceled({ type, hostname }); return }
    const status = response?.statusCode ?? 0
    if (failure || status >= 400) {
      monitor.requestFailed({ type, hostname, error: failure ? String((failure as { message?: string }).message ?? failure) : 'HTTP', errorCode: status || undefined })
      return
    }
    const body = request.response ?? request.responseText
    monitor.requestCompleted({
      type, hostname, headers: response?.headers, start: request.requestTime, responseEnd: Date.now(),
      bytes: typeof body === 'string' ? body.length : body?.byteLength,
    })
  }
  // A new VHS (each source) says when its request hooks can be added.
  let hooked: VhsLike['xhr'] | undefined
  const hook = () => {
    hooked?.offResponse?.(responded)
    hooked = vhs()?.xhr
    hooked?.onResponse?.(responded)
  }
  player.on('loadedmetadata', loaded)
  player.on('error', error)
  player.on('xhr-hooks-ready', hook)
  hook()
  return {
    ...monitor,
    stop() {
      player.off('loadedmetadata', loaded)
      player.off('error', error)
      player.off('xhr-hooks-ready', hook)
      hooked?.offResponse?.(responded)
      monitor.destroy()
    },
  }
}

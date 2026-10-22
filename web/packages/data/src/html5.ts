import { ViewTracker, type PageInfo, type PlayerInfo, type RenditionDetails, type RequestInfo, type VideoInfo } from './tracker.js'
import type { DataClient } from './client.js'

export interface VideoMonitor {
  /** What the next view plays: call before giving the player a new source. */
  setVideo(video: VideoInfo): void
  /** Which player plays the next view (e.g. once a streaming library takes over the element). */
  setPlayer(player: PlayerInfo): void
  /** The player library and its version (the -hlsjs, -shaka… packages tell); your own player name stays. */
  playerSoftware?(name: string, version?: string): void
  /** The rendition playing now, from the streaming library (see @unifiedplay/data-hlsjs, -shaka…), with its codecs where known. */
  rendition(kbps: number | null, width: number | null, height: number | null, details?: RenditionDetails): void
  /** A playback error. businessException: your own rule stopped playback (geo-block, paywall…), no failure. */
  error(code: string, message: string, fatal: boolean, businessException?: boolean): void
  /** Live streams: the distance to the live edge (the -hlsjs, -dashjs, -shaka packages report it). */
  liveLatency(ms: number): void
  /** Captions on or off (HTML5 text tracks are seen by themselves). */
  captions(on: boolean): void
  /** An ad request went out / its response was read: pre-roll request time (spec: Startup). */
  adRequest(): void
  adResponse(): void
  /** Network requests for the content, from the streaming library (the -hlsjs, -shaka… packages call these). */
  requestCompleted(request: RequestInfo): void
  requestFailed(request: RequestInfo): void
  requestCanceled(request: RequestInfo): void
  /** The DRM in use (widevine, playready, fairplay, clearkey), from the streaming library or the app. */
  setDrmType(type: string): void
  /** standard, fullscreen, pip, or your own name. Fullscreen and picture-in-picture of the element itself are seen by themselves. */
  playbackMode(mode: string): void
  /** Ads: an ad library (see @unifiedplay/data-ima) or your own ad player calls these. */
  adBreakStart(): void
  adStart(): void
  adPlaying(): void
  adPause(): void
  adEnd(): void
  adError(code: string, message?: string): void
  adBreakEnd(): void
  /** Stop monitoring: ends the open view and sends it. */
  destroy(): void
}

/**
 * What monitorVideo needs from a player: an HTML5 <video>, or a player object that fires the same
 * events and has the same properties.
 */
export interface MediaLike {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
  readonly currentTime: number
  readonly paused: boolean
  readonly ended: boolean
  readonly autoplay?: boolean
  readonly poster?: string
  readonly preload?: string
  readonly currentSrc?: string
  readonly src?: string
  readonly videoWidth?: number
  readonly videoHeight?: number
  readonly error?: { code: number | string; message?: string } | null
  getVideoPlaybackQuality?(): { droppedVideoFrames: number }
}

export interface MonitorOptions {
  /** The event that means a new source; default 'loadstart'. */
  sourceEvent?: string
  /** The element whose size on screen the video fills; default the media itself when it is an element. */
  sizeOf?: Element | null
}

// Requests before a view exists (the manifest, a preload) go into it when it starts; a few are enough.
const MAX_EARLY_REQUESTS = 50
type EarlyRequest = ['requestCompleted' | 'requestFailed' | 'requestCanceled', RequestInfo]

export function newInstanceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
}

// Page load time goes with the first view on the page only.
let pageLoadTaken = false
export function takePageLoad(): number | null {
  if (pageLoadTaken || typeof performance === 'undefined') return null
  pageLoadTaken = true
  return performance.now() // since the page was asked for, to the player's start
}

function pageInfo(): PageInfo | null {
  if (typeof location === 'undefined') return null
  let framed = false
  try { framed = window.self !== window.top } catch { framed = true } // a cross-origin parent
  // The query and fragment may carry tokens or personal data: never sent.
  return { type: framed ? 'iframe' : 'watchpage', url: `${location.origin}${location.pathname}` }
}

const ERROR_NAMES: Record<number, string> = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' }

/**
 * Watches an HTML5 video element. A view starts when playback of a source is asked for, so a
 * preloaded video nobody plays is no view; a new source (loadstart) ends the view, unless play
 * was asked for before the element had any source and that source is only now arriving. Pair it with
 * a streaming library's package (@unifiedplay/data-hlsjs, -shaka, -dashjs…) for bitrates.
 */
export function monitorVideo(
  client: DataClient,
  element: MediaLike,
  video: VideoInfo,
  playerInfo: PlayerInfo = { name: 'html5' },
  options: MonitorOptions = {},
): VideoMonitor {
  const sizeOf = options.sizeOf ?? (typeof Element !== 'undefined' && element instanceof Element ? element : null)
  let info = video
  let player = playerInfo
  let view: ViewTracker | null = null
  let rendition: [number | null, number | null, number | null, RenditionDetails?] | null = null
  const instanceId = newInstanceId()
  let early: EarlyRequest[] = []
  let drmType = ''
  let mode = 'standard'
  const pageLoad = takePageLoad()
  // Player startup: from the source to the metadata, measured even before anyone presses play.
  let sourceAt: number | null = performance.now()
  let readyAt: number | null = null
  // play() came before any source (players that attach their MediaSource after asking to play).
  let sourceless = false

  const size = () => {
    const ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1
    if (sizeOf) view?.playerSize(Math.round(sizeOf.clientWidth * ratio), Math.round(sizeOf.clientHeight * ratio))
  }
  const current = (): ViewTracker => {
    if (!view || view.ended) {
      view = new ViewTracker(info, {
        language: typeof navigator === 'undefined' ? undefined : navigator.language, instanceId, ...player, autoplay: Boolean(element.autoplay),
        poster: player.poster ?? (element.poster ? element.poster.split(/[?#]/)[0] : undefined), preload: player.preload ?? element.preload === 'auto',
      })
      client.add(view)
      size()
      const page = pageInfo()
      if (page) view.setPage(page)
      if (pageLoad !== null) view.pageLoad(pageLoad)
      if (captionsShowing()) view.captions(true)
      if (drmType) view.setDrmType(drmType)
      if (mode !== 'standard') view.playbackMode(mode)
      for (const [kind, request] of early) view[kind](request)
      early = []
      if (rendition) view.rendition(...rendition)
      if (sourceAt !== null && readyAt !== null) view.playerStartup(readyAt - sourceAt)
    }
    return view
  }
  const send = () => void client.flush()
  const quality = () => {
    const stats = element.getVideoPlaybackQuality?.() ?? null
    if (stats && view) view.droppedFrames(stats.droppedVideoFrames)
  }

  const handlers: Array<[string, () => void]> = [
    [options.sourceEvent ?? 'loadstart', () => {
      const awaited = sourceless && view !== null && !view.ended && view.metrics.video_startup_ms === null
      sourceless = false
      sourceAt = performance.now()
      readyAt = null
      // The source the open view was waiting for: same view, its startup still running.
      if (awaited) return
      // A new source: the previous view is over.
      if (view && !view.ended) { view.end(); send() }
      view = null
      rendition = null
      early = []
      drmType = ''
    }],
    ['emptied', () => { if (view && !view.ended) { view.end(); send() } }],
    ['loadedmetadata', () => {
      readyAt = performance.now()
      if (view && sourceAt !== null) view.playerStartup(readyAt - sourceAt)
    }],
    ['play', () => {
      if (!(element.currentSrc || element.src)) sourceless = true
      current().play()
    }],
    ['playing', () => {
      const first = view?.metrics.video_startup_ms === null
      current().playing()
      if (first) send()
    }],
    ['pause', () => { if (!element.ended) { view?.pause(); quality(); send() } }],
    ['waiting', () => view?.bufferingStart()],
    ['seeking', () => view?.seeking()],
    ['seeked', () => view?.seeked(element.paused)],
    ['timeupdate', () => view?.playhead(element.currentTime * 1000)],
    ['resize', () => {
      // Without a streaming library this is the only rendition news: the size, not the bitrate.
      if (!rendition && element.videoWidth) view?.rendition(null, element.videoWidth, element.videoHeight ?? null)
    }],
    ['ended', () => { quality(); view?.completed(); send() }],
    ['error', () => {
      const failure = element.error
      if (!failure || !view) return
      view.failed(ERROR_NAMES[Number(failure.code)] ?? String(failure.code), failure.message ?? '', true)
      send()
    }],
  ]
  for (const [name, handler] of handlers) element.addEventListener(name, handler)
  // Fullscreen and picture-in-picture of this element (and Safari's presentation modes).
  const modeNow = () => {
    const doc = typeof document === 'undefined' ? null : document as Document & { webkitFullscreenElement?: Element | null }
    const full = doc?.fullscreenElement ?? doc?.webkitFullscreenElement ?? null
    const presentation = (element as MediaLike & { webkitPresentationMode?: string }).webkitPresentationMode
    const node = element as unknown as Element
    const next = doc?.pictureInPictureElement === node || presentation === 'picture-in-picture' ? 'pip'
      : (full && typeof Node !== 'undefined' && node instanceof Node && (full === node || full.contains(node))) || presentation === 'fullscreen' ? 'fullscreen'
        : 'standard'
    if (next === mode) return
    mode = next
    view?.playbackMode(next)
  }
  const docEvents = ['fullscreenchange', 'webkitfullscreenchange']
  const elementEvents = ['enterpictureinpicture', 'leavepictureinpicture', 'webkitpresentationmodechanged']
  if (typeof document !== 'undefined') for (const name of docEvents) document.addEventListener(name, modeNow)
  for (const name of elementEvents) element.addEventListener(name, modeNow)
  const tracks = (element as MediaLike & { textTracks?: TextTrackList }).textTracks
  const captionsShowing = () => Array.from(tracks ?? []).some(track => track.mode === 'showing' && (track.kind === 'captions' || track.kind === 'subtitles'))
  const captionsChanged = () => { if (captionsShowing()) view?.captions(true) }
  tracks?.addEventListener?.('change', captionsChanged)
  const request = (kind: EarlyRequest[0]) => (info: RequestInfo) => {
    if (view && !view.ended) view[kind](info)
    else if (early.length < MAX_EARLY_REQUESTS) early.push([kind, info])
  }
  // AirPlay and the Remote Playback API (Chromecast from Chrome): the view played on another screen.
  const remote = (element as MediaLike & { remote?: { state?: string; addEventListener?(type: string, listener: () => void): void; removeEventListener?(type: string, listener: () => void): void } }).remote
  const remoteChanged = () => { if (remote?.state === 'connected') { mode = 'remote'; view?.playbackMode('remote') } }
  remote?.addEventListener?.('connect', remoteChanged)
  const airplay = () => { if ((element as MediaLike & { webkitCurrentPlaybackTargetIsWireless?: boolean }).webkitCurrentPlaybackTargetIsWireless) { mode = 'remote'; view?.playbackMode('remote') } }
  element.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', airplay)
  const resizeObserver = sizeOf && typeof ResizeObserver === 'function' ? new ResizeObserver(size) : null
  if (sizeOf) resizeObserver?.observe(sizeOf)
  if ((element.currentSrc || element.src) && !element.paused) current().play()

  return {
    setVideo(next) { info = next },
    setPlayer(next) { player = next },
    playerSoftware(name, version) { player = { ...player, software: name, softwareVersion: version ?? player.softwareVersion } },
    rendition(kbps, width, height, details) {
      rendition = [kbps, width, height, details]
      view?.rendition(kbps, width, height, details)
    },
    error(code, message, fatal, businessException = false) {
      if (!view || view.ended) return
      view.failed(code, message, fatal, businessException)
      if (fatal) send()
    },
    liveLatency(ms) { view?.liveLatency(ms) },
    captions(on) { view?.captions(on) },
    adRequest() { current().adRequest() },
    adResponse() { view?.adResponse() },
    requestCompleted: request('requestCompleted'),
    requestFailed: request('requestFailed'),
    requestCanceled: request('requestCanceled'),
    setDrmType(type) {
      drmType = type
      view?.setDrmType(type)
    },
    playbackMode(next) {
      mode = next
      view?.playbackMode(next)
    },
    // An ad break means playback was asked for, so it may start the view; the rest only feed one.
    adBreakStart() { current().adBreakStart(); send() },
    adStart() { current().adStart() },
    adPlaying() { view?.adPlaying() },
    adPause() { view?.adPause() },
    adEnd() { view?.adEnd() },
    adError(code, message = '') { current().adError(code, message); send() },
    adBreakEnd() { view?.adBreakEnd(); send() },
    destroy() {
      for (const [name, handler] of handlers) element.removeEventListener(name, handler)
      if (typeof document !== 'undefined') for (const name of docEvents) document.removeEventListener(name, modeNow)
      for (const name of elementEvents) element.removeEventListener(name, modeNow)
      tracks?.removeEventListener?.('change', captionsChanged)
      remote?.removeEventListener?.('connect', remoteChanged)
      element.removeEventListener('webkitcurrentplaybacktargetiswirelesschanged', airplay)
      resizeObserver?.disconnect()
      quality()
      if (view && !view.ended) view.end()
      send()
    },
  }
}

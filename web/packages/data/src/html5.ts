import { ViewTracker, type PlayerInfo, type VideoInfo } from './tracker.js'
import type { DataClient } from './client.js'

export interface VideoMonitor {
  /** What the next view plays: call before giving the player a new source. */
  setVideo(video: VideoInfo): void
  /** Which player plays the next view (e.g. once a streaming library takes over the element). */
  setPlayer(player: PlayerInfo): void
  /** The rendition playing now, from the streaming library (see @unifiedplay/data-hlsjs, -shaka…). */
  rendition(kbps: number | null, width: number | null, height: number | null): void
  /** A playback error the streaming library reported. */
  error(code: string, message: string, fatal: boolean): void
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

const ERROR_NAMES: Record<number, string> = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' }

/**
 * Watches an HTML5 video element. A view starts when playback of a source is asked for, so a
 * preloaded video nobody plays is no view; a new source (loadstart) ends the view. Pair it with
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
  let rendition: [number | null, number | null, number | null] | null = null
  // Player startup: from the source to the metadata, measured even before anyone presses play.
  let sourceAt: number | null = performance.now()
  let readyAt: number | null = null

  const size = () => {
    const ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1
    if (sizeOf) view?.playerSize(Math.round(sizeOf.clientWidth * ratio), Math.round(sizeOf.clientHeight * ratio))
  }
  const current = (): ViewTracker => {
    if (!view || view.ended) {
      view = new ViewTracker(info, { ...player, autoplay: Boolean(element.autoplay) })
      client.add(view)
      size()
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
      // A new source: the previous view is over.
      if (view && !view.ended) { view.end(); send() }
      view = null
      rendition = null
      sourceAt = performance.now()
      readyAt = null
    }],
    ['emptied', () => { if (view && !view.ended) { view.end(); send() } }],
    ['loadedmetadata', () => {
      readyAt = performance.now()
      if (view && sourceAt !== null) view.playerStartup(readyAt - sourceAt)
    }],
    ['play', () => current().play()],
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
  const resizeObserver = sizeOf && typeof ResizeObserver === 'function' ? new ResizeObserver(size) : null
  if (sizeOf) resizeObserver?.observe(sizeOf)
  if ((element.currentSrc || element.src) && !element.paused) current().play()

  return {
    setVideo(next) { info = next },
    setPlayer(next) { player = next },
    rendition(kbps, width, height) {
      rendition = [kbps, width, height]
      view?.rendition(kbps, width, height)
    },
    error(code, message, fatal) {
      if (!view || view.ended) return
      view.failed(code, message, fatal)
      if (fatal) send()
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
      resizeObserver?.disconnect()
      quality()
      if (view && !view.ended) view.end()
      send()
    },
  }
}

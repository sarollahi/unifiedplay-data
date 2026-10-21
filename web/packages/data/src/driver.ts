import type { DataClient } from './client.js'
import { takePageLoad, type VideoMonitor } from './html5.js'
import { ViewTracker, type PageInfo, type PlayerInfo, type RequestInfo, type VideoInfo } from './tracker.js'

/**
 * A monitor for players that are no HTML5 element (JW Player, the Cast receiver, Tizen's AVPlay,
 * React Native…): their package turns the player's events into these calls. Same rules as the
 * Android and iOS monitors: a view starts when playback of a source is asked for, so a preloaded
 * video nobody plays is no view; a new source ends it; player startup runs from the source to
 * ready even before anyone plays.
 */
export interface PlayerDriver extends VideoMonitor {
  /** The player got a new source (null: none): the open view is over. */
  source(video: VideoInfo | null): void
  /** The player could start: player startup is done. */
  ready(): void
  /** Playback was asked for (play pressed, autoplay). */
  play(): void
  /** Frames are moving: the first one, after a stall, a seek or a pause. */
  playing(): void
  pause(): void
  bufferingStart(): void
  bufferingEnd(): void
  seeking(): void
  seeked(paused: boolean): void
  playhead(ms: number): void
  liveLatency(ms: number): void
  droppedFrames(total: number): void
  /** The player's size on screen in device pixels. */
  size(width: number, height: number): void
  /** The video played to its end. */
  completed(): void
  /** The open view, if any. */
  readonly view: ViewTracker | null
}

type RequestKind = 'requestCompleted' | 'requestFailed' | 'requestCanceled'

export function playerDriver(client: DataClient, playerInfo: PlayerInfo, page: PageInfo | null = null): PlayerDriver {
  let player = playerInfo
  let video: VideoInfo | null = null
  let view: ViewTracker | null = null
  let sourceAt: number | null = null
  let readyAt: number | null = null
  let rendition: [number | null, number | null, number | null] | null = null
  let size: [number, number] | null = null
  let early: Array<[RequestKind, RequestInfo]> = []
  let drmType = ''
  let mode = 'standard'
  // Web players (JW Player): the page's load time goes with the first view on the page.
  const pageLoad = page ? takePageLoad() : null
  let captionsOn = false
  const send = () => void client.flush()

  const current = (): ViewTracker | null => {
    if (view && !view.ended) return view
    if (!video) return null
    view = new ViewTracker(video, player)
    client.add(view)
    if (page) view.setPage(page)
    if (pageLoad !== null) view.pageLoad(pageLoad)
    if (captionsOn) view.captions(true)
    if (size) view.playerSize(...size)
    if (rendition) view.rendition(...rendition)
    if (sourceAt !== null && readyAt !== null) view.playerStartup(readyAt - sourceAt)
    if (drmType) view.setDrmType(drmType)
    if (mode !== 'standard') view.playbackMode(mode)
    for (const [kind, request] of early) view[kind](request)
    early = []
    send()
    return view
  }
  const request = (kind: RequestKind) => (info: RequestInfo) => {
    if (view && !view.ended) view[kind](info)
    else if (early.length < 50) early.push([kind, info])
  }

  return {
    get view() { return view },
    source(next) {
      if (view && !view.ended) { view.end(); send() }
      view = null
      video = next
      sourceAt = next ? performance.now() : null
      readyAt = null
      rendition = null
      early = []
      drmType = ''
    },
    ready() {
      if (readyAt !== null) return
      readyAt = performance.now()
      if (view && sourceAt !== null) view.playerStartup(readyAt - sourceAt)
    },
    play() { current()?.play() },
    playing() {
      const first = view?.metrics.video_startup_ms === null
      view?.playing()
      if (first) send()
    },
    pause() { if (view && !view.ended) { view.pause(); send() } },
    bufferingStart() { view?.bufferingStart() },
    bufferingEnd() { view?.bufferingEnd() },
    seeking() { view?.seeking() },
    seeked(paused) { view?.seeked(paused) },
    playhead(ms) { view?.playhead(ms) },
    liveLatency(ms) { view?.liveLatency(ms) },
    droppedFrames(total) { view?.droppedFrames(total) },
    size(width, height) {
      size = [width, height]
      view?.playerSize(width, height)
    },
    completed() { if (view && !view.ended) { view.completed(); send() } },
    setVideo(next) { video = next },
    setPlayer(next) { player = next },
    rendition(kbps, width, height) {
      rendition = [kbps, width, height]
      view?.rendition(kbps, width, height)
    },
    error(code, message, fatal, businessException = false) {
      // A source that fails while someone wants it played is a failed view; a preloaded one is nobody's.
      const failing = fatal ? (view && !view.ended ? view : null) : view
      if (!failing || failing.ended) return
      failing.failed(code, message, fatal, businessException)
      if (fatal) send()
    },
    captions(on) {
      captionsOn = captionsOn || on
      view?.captions(on)
    },
    adRequest() { current()?.adRequest() },
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
    adBreakStart() { current()?.adBreakStart(); send() },
    adStart() { current()?.adStart() },
    adPlaying() { view?.adPlaying() },
    adPause() { view?.adPause() },
    adEnd() { view?.adEnd() },
    adError(code, message = '') { current()?.adError(code, message); send() },
    adBreakEnd() { view?.adBreakEnd(); send() },
    destroy() {
      if (view && !view.ended) view.end()
      send()
    },
  }
}

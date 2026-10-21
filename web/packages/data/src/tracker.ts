// One view: what happened since playback of one video was asked for, and the totals the beacon
// carries (spec/beacon.md). Android (ViewTracker.kt) and iOS (ViewTracker.swift) do the same.

export interface VideoInfo {
  id?: string
  title?: string
  seriesId?: string
  seriesTitle?: string
  durationMs?: number
  streamType?: 'on-demand' | 'live'
  sourceType?: string
  sourceHost?: string
  /** The CDN serving the video, when you know it; otherwise the X-CDN response header names it. */
  cdn?: string
  /** widevine, playready, fairplay or clearkey, when the player cannot tell. */
  drmType?: string
  /** Your own id for this view, to join it with CDN logs: give your player's CMCD session id (sid) the same value. */
  viewSessionId?: string
  /** episode, movie, trailer, clip, live… */
  contentType?: string
  /** The audio language, e.g. en, sv. */
  languageCode?: string
  /** Which variant of the video (a cut, a dub). */
  variantName?: string
  /** Which encoding ladder or settings, for comparing encodings. */
  encodingVariant?: string
  /** An A/B test this view is in. */
  experimentName?: string
  /** A part of your service (a site, a customer, a channel). */
  subPropertyId?: string
  /** Up to ten of your own dimensions; the Console breaks views down by them. */
  custom?: Partial<Record<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10, string>>
}

/** What a network request for the content was for (spec: Requests). */
export type RequestType = 'manifest' | 'video' | 'audio' | 'video_init' | 'audio_init' | 'media' | 'subtitle' | 'encryption'

/** One network request for the content, as the player reports it. Times are milliseconds on any one clock. */
export interface RequestInfo {
  type?: RequestType
  hostname?: string
  start?: number
  /** When the first byte arrived, if the player tells. */
  responseStart?: number
  responseEnd?: number
  bytes?: number
  /** Response headers: X-CDN names the CDN. */
  headers?: Record<string, string> | ((name: string) => string | null | undefined)
  /** Failures: the error's name, the HTTP status, its text. */
  error?: string
  errorCode?: number | string
  errorText?: string
}

export interface PageInfo { type: 'watchpage' | 'iframe'; url: string }

const MEDIA_REQUESTS: ReadonlySet<string> = new Set(['video', 'audio', 'media'])
const FAILED_BY_TYPE: Record<string, 'request_failed_manifest' | 'request_failed_media' | 'request_failed_encryption'> = {
  manifest: 'request_failed_manifest', encryption: 'request_failed_encryption',
  video: 'request_failed_media', audio: 'request_failed_media', media: 'request_failed_media', video_init: 'request_failed_media', audio_init: 'request_failed_media',
}

function header(headers: RequestInfo['headers'], name: string): string {
  if (!headers) return ''
  if (typeof headers === 'function') return headers(name) ?? ''
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return value
  return ''
}

export interface PlayerInfo {
  name: string
  version?: string
  autoplay?: boolean
}

export interface BeaconEvent { t: number; type: string; data?: Record<string, unknown> }

export interface ViewSnapshot {
  view_id: string
  seq: number
  started_at: string
  ended: boolean
  video: Record<string, unknown>
  player: Record<string, unknown>
  page?: PageInfo
  view_session_id?: string
  metrics: Record<string, number | null>
  custom: Record<string, string>
  error: { code: string; message: string; fatal: boolean; business_exception: boolean } | null
  events: BeaconEvent[]
  experiment_name?: string
  sub_property_id?: string
}

type State = 'idle' | 'starting' | 'playing' | 'paused' | 'rebuffering' | 'seeking' | 'ad' | 'ended'

/** States where the viewer is waiting for or watching the video itself: they count as watch time. */
const WATCHING: ReadonlySet<State> = new Set(['starting', 'playing', 'rebuffering', 'seeking'])

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`
}

export class ViewTracker {
  readonly viewId = newId()
  readonly startedAt = new Date().toISOString()
  private readonly t0: number
  private seq = 0
  private state: State = 'idle'
  private since: number
  private playRequestedAt: number | null = null
  private firstFrame = false
  private events: BeaconEvent[] = []
  private error: { code: string; message: string; fatal: boolean; business_exception: boolean } | null = null
  private kbps: number | null = null
  private bitrateMs = 0
  private bitratePlayingMs = 0
  private videoWidth: number | null = null
  private videoHeight: number | null = null
  private playerWidth: number | null = null
  private playerHeight: number | null = null
  // Ads: the state to go back to, when the break began, ad time before the first frame, and the running ad clock.
  private beforeAd: State = 'idle'
  private adBreakAt = 0
  private startupAdMs = 0
  private adPlayingSince: number | null = null
  private cdn: string
  private drmType: string
  private fullscreen = false
  private pip = false
  private mode = 'standard'
  private page: PageInfo | null = null
  private captionsOn = false
  // Pre-roll (spec: Startup): when it was asked to play, the open ad request, the last ad response.
  private prerollAt: number | null = null
  private adRequestAt: number | null = null
  private adResponseAt: number | null = null
  ended = false

  readonly metrics = {
    player_startup_ms: null as number | null,
    video_startup_ms: null as number | null,
    watch_ms: 0,
    playing_ms: 0,
    rebuffer_count: 0,
    rebuffer_ms: 0,
    seek_count: 0,
    seek_ms: 0,
    playhead_ms: 0,
    avg_bitrate_kbps: null as number | null,
    max_bitrate_kbps: null as number | null,
    rendition_changes: 0,
    video_width: null as number | null,
    video_height: null as number | null,
    upscale_ms: 0,
    downscale_ms: 0,
    max_upscale_pct: 0,
    dropped_frames: 0,
    live_latency_ms: null as number | null,
    ad_break_count: 0,
    ad_count: 0,
    ad_watch_ms: 0,
    ad_error_count: 0,
    request_completed: 0,
    request_failed: 0,
    request_canceled: 0,
    request_failed_manifest: 0,
    request_failed_media: 0,
    request_failed_encryption: 0,
    request_media_completed: 0,
    request_media_bytes: 0,
    request_media_ms: 0,
    request_media_ttfb_ms: 0,
    request_media_ttfb_count: 0,
    request_media_max_ttfb_ms: 0,
    content_startup_ms: null as number | null,
    ad_startup_ms: null as number | null,
    preroll_request_ms: null as number | null,
    preroll_load_ms: null as number | null,
    preroll_requests: 0,
    page_load_ms: null as number | null,
    upscale_pct_ms: 0,
    downscale_pct_ms: 0,
    max_downscale_pct: 0,
  }

  constructor(
    readonly video: VideoInfo,
    readonly player: PlayerInfo,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.t0 = now()
    this.since = this.t0
    this.cdn = video.cdn ?? ''
    this.drmType = video.drmType ?? ''
    this.event('viewstart')
  }

  // Requests, CDN, DRM, playback mode, page ------------------------------------------------------

  /** A content request came back. Media segments add to the throughput and latency totals. */
  requestCompleted(request: RequestInfo): void {
    if (this.ended) return
    this.metrics.request_completed += 1
    this.cdnFrom(request)
    if (!MEDIA_REQUESTS.has(request.type ?? 'media')) return
    const m = this.metrics
    m.request_media_completed += 1
    m.request_media_bytes += Math.max(0, request.bytes ?? 0)
    if (request.start !== undefined && request.responseEnd !== undefined) m.request_media_ms += Math.max(0, request.responseEnd - request.start)
    if (request.start !== undefined && request.responseStart !== undefined) {
      const ttfb = Math.max(0, request.responseStart - request.start)
      m.request_media_ttfb_ms += ttfb
      m.request_media_ttfb_count += 1
      m.request_media_max_ttfb_ms = Math.max(m.request_media_max_ttfb_ms, ttfb)
    }
  }

  requestFailed(request: RequestInfo): void {
    if (this.ended) return
    this.metrics.request_failed += 1
    const bucket = FAILED_BY_TYPE[request.type ?? '']
    if (bucket) this.metrics[bucket] += 1
    this.cdnFrom(request)
    this.event('requestfailed', {
      type: request.type ?? null, hostname: request.hostname ?? null, error: request.error ?? null,
      code: request.errorCode ?? null, text: request.errorText ?? null,
    })
  }

  requestCanceled(request: RequestInfo): void {
    if (this.ended) return
    this.metrics.request_canceled += 1
    this.event('requestcanceled', { type: request.type ?? null, hostname: request.hostname ?? null })
  }

  /** standard, fullscreen, pip, or your own name. */
  playbackMode(mode: string): void {
    if (mode === this.mode) return
    this.mode = mode
    if (mode === 'fullscreen') this.fullscreen = true
    if (mode === 'pip') this.pip = true
    this.event('playbackmodechange', { mode })
  }

  setDrmType(type: string): void {
    if (type) this.drmType = type
  }

  setPage(page: PageInfo): void {
    this.page = page
  }

  /** The first view on a page: from the page's request to the player's start (web). */
  pageLoad(ms: number): void {
    if (this.metrics.page_load_ms === null && Number.isFinite(ms)) this.metrics.page_load_ms = Math.max(0, Math.round(ms))
  }

  /** Captions shown at some point of the view. */
  captions(on: boolean): void {
    if (on && !this.captionsOn) { this.captionsOn = true; this.event('captions', { on }) }
  }

  private cdnFrom(request: RequestInfo): void {
    // An app-set CDN wins; otherwise the latest X-CDN header names it.
    const name = header(request.headers, 'x-cdn').trim().slice(0, 64)
    if (!name || this.video.cdn || name === this.cdn) return
    this.cdn = name
    this.event('cdnchange', { cdn: name })
  }

  /** How long the player took from getting the source to being able to start (the monitor measures it). */
  playerStartup(ms: number): void {
    if (this.metrics.player_startup_ms === null && Number.isFinite(ms)) this.metrics.player_startup_ms = Math.max(0, Math.round(ms))
  }

  /** Playback was asked for (play pressed, autoplay, playWhenReady). */
  play(): void {
    if (this.ended || this.state === 'ad') return
    this.event('play')
    if (!this.firstFrame) {
      this.playRequestedAt ??= this.now()
      this.move('starting')
    }
  }

  /** Frames of the video are moving: first frame, after a stall, after a seek, after a pause. */
  playing(): void {
    if (this.ended || this.state === 'ad') return
    if (!this.firstFrame) {
      this.firstFrame = true
      const since = this.now() - (this.playRequestedAt ?? this.t0)
      // Video startup ends at the first frame of a pre-roll, if one came first; content startup leaves ads out.
      this.metrics.video_startup_ms ??= Math.round(since)
      this.metrics.content_startup_ms = Math.round(since - this.startupAdMs)
    }
    if (this.state === 'rebuffering') this.event('rebufferend')
    if (this.state !== 'playing') this.event('playing')
    this.move('playing')
  }

  pause(): void {
    if (this.ended || this.state === 'paused' || this.state === 'ad') return
    if (this.state === 'rebuffering') this.event('rebufferend')
    this.event('pause')
    this.move('paused')
  }

  /** The player ran out of data. Only a stall after the first frame and outside a seek is rebuffering. */
  bufferingStart(): void {
    if (this.state !== 'playing') return
    this.metrics.rebuffer_count += 1
    this.event('rebufferstart')
    this.move('rebuffering')
  }

  bufferingEnd(): void {
    if (this.state === 'rebuffering') this.playing()
  }

  seeking(): void {
    // A seek before the first frame (to a resume position) is part of startup.
    if (this.ended || !this.firstFrame || this.state === 'seeking' || this.state === 'ad') return
    this.metrics.seek_count += 1
    this.event('seeking')
    this.move('seeking')
  }

  /** The seek landed. While paused the seek is over; otherwise it is over when frames move again. */
  seeked(paused: boolean): void {
    if (this.state !== 'seeking') return
    this.event('seeked')
    if (paused) this.move('paused')
  }

  rendition(kbps: number | null, width: number | null, height: number | null): void {
    if (this.state === 'ad') return // an ad's own rendition, in players that play ads themselves
    if (kbps === this.kbps && width === this.videoWidth && height === this.videoHeight) return
    this.account()
    if (this.firstFrame) this.metrics.rendition_changes += 1
    this.kbps = kbps
    this.videoWidth = width
    this.videoHeight = height
    if (kbps !== null) this.metrics.max_bitrate_kbps = Math.max(this.metrics.max_bitrate_kbps ?? 0, Math.round(kbps))
    this.event('rendition', { kbps: kbps === null ? null : Math.round(kbps), width, height })
  }

  /** The player's size on screen in device pixels. */
  playerSize(width: number, height: number): void {
    if (width === this.playerWidth && height === this.playerHeight) return
    this.account()
    this.playerWidth = width > 0 ? width : null
    this.playerHeight = height > 0 ? height : null
  }

  playhead(ms: number): void {
    if (Number.isFinite(ms) && this.state !== 'ad') this.metrics.playhead_ms = Math.max(this.metrics.playhead_ms, Math.round(ms))
  }

  droppedFrames(total: number): void {
    if (Number.isFinite(total)) this.metrics.dropped_frames = Math.max(this.metrics.dropped_frames, Math.round(total))
  }

  liveLatency(ms: number): void {
    if (Number.isFinite(ms)) this.metrics.live_latency_ms = Math.max(0, Math.round(ms))
  }

  /**
   * An error. fatal: it stopped playback. businessException: your own rule stopped it (geo-block,
   * paywall, too many streams): no playback failure.
   */
  failed(code: string, message: string, fatal = true, businessException = false): void {
    if (this.ended) return
    this.event('error', businessException ? { code, message, fatal, business_exception: true } : { code, message, fatal })
    if (!fatal) return
    this.error = { code, message, fatal, business_exception: businessException }
    this.end()
  }

  /** The video played to its end. */
  completed(): void {
    if (this.ended) return
    this.event('ended')
    this.end()
  }

  /** The viewer left the video: new source, player released, app or page closed. */
  end(): void {
    if (this.ended) return
    this.stopAdClock()
    this.move('ended')
    this.ended = true
    this.event('viewend')
  }

  // Ads ------------------------------------------------------------------------------------------

  /** The video gave way to ads (pre-, mid- or post-roll). Until adBreakEnd nothing counts as video time. */
  adBreakStart(): void {
    if (this.ended || this.state === 'ad') return
    // Ads before anything else (a pre-roll after the play button): playback was asked for.
    if (this.state === 'idle') this.playRequestedAt ??= this.now()
    this.beforeAd = this.state === 'idle' ? 'starting' : this.state
    this.adBreakAt = this.now()
    this.metrics.ad_break_count += 1
    this.event('adbreakstart')
    this.move('ad')
  }

  /** An ad request went out (VAST/VMAP). Before the first pre-roll plays, its time is pre-roll request time. */
  adRequest(): void {
    if (this.ended) return
    if (!this.firstFrame && this.metrics.ad_startup_ms === null) {
      this.metrics.preroll_requests += 1
      this.adRequestAt ??= this.now()
    }
    this.event('adrequest')
  }

  /** The ad response came back and was read. */
  adResponse(): void {
    if (this.ended) return
    const now = this.now()
    if (this.adRequestAt !== null && this.playRequestedAt !== null && this.metrics.ad_startup_ms === null) {
      // Only time after playback was asked for counts.
      this.metrics.preroll_request_ms = Math.round((this.metrics.preroll_request_ms ?? 0) + now - Math.max(this.adRequestAt, this.playRequestedAt))
    }
    this.adRequestAt = null
    this.adResponseAt = now
    this.event('adresponse')
  }

  /** An ad was asked to play. */
  adStart(): void {
    if (this.ended) return
    if (this.state !== 'ad') this.adBreakStart()
    if (!this.firstFrame && this.prerollAt === null) this.prerollAt = this.now()
    this.metrics.ad_count += 1
    this.event('adplay')
  }

  /** The ad's frames are moving. */
  adPlaying(): void {
    if (this.state !== 'ad' || this.adPlayingSince !== null) return
    const now = this.now()
    this.adPlayingSince = now
    if (!this.firstFrame && this.metrics.ad_startup_ms === null) {
      const asked = this.prerollAt ?? this.adBreakAt
      this.metrics.ad_startup_ms = Math.round(now - asked)
      // Loading the ad: from the last ad response (or the ad's start), never before playback was asked for.
      this.metrics.preroll_load_ms = Math.round(now - Math.max(this.adResponseAt ?? asked, this.playRequestedAt ?? -Infinity))
      this.metrics.video_startup_ms = Math.round(now - (this.playRequestedAt ?? this.t0))
    }
    this.event('adplaying')
  }

  adPause(): void {
    if (this.state !== 'ad') return
    this.stopAdClock()
    this.event('adpause')
  }

  adEnd(): void {
    if (this.state !== 'ad') return
    this.stopAdClock()
    this.event('adended')
  }

  /** An ad failed. It does not fail the view: the video plays on without it. */
  adError(code: string, message = ''): void {
    if (this.ended) return
    this.stopAdClock()
    this.metrics.ad_error_count += 1
    this.event('aderror', { code, message })
  }

  /** The ads gave the video back. */
  adBreakEnd(): void {
    if (this.state !== 'ad') return
    this.stopAdClock()
    // A pre-roll is not the video's startup.
    if (!this.firstFrame) this.startupAdMs += this.now() - this.adBreakAt
    this.event('adbreakend')
    // After a mid-roll the video is paused until its frames move again.
    this.move(this.beforeAd === 'playing' || this.beforeAd === 'rebuffering' || this.beforeAd === 'seeking' ? 'paused' : this.beforeAd)
  }

  /** The view as the next beacon sends it, with its oldest unsent events. Events stay until sent(count) says the backend has them. */
  snapshot(maxEvents = Infinity): ViewSnapshot {
    this.account()
    if (this.adPlayingSince !== null) {
      const now = this.now()
      this.metrics.ad_watch_ms += now - this.adPlayingSince
      this.adPlayingSince = now
    }
    this.seq += 1
    this.metrics.avg_bitrate_kbps = this.bitratePlayingMs ? Math.round(this.bitrateMs / this.bitratePlayingMs) : null
    this.metrics.video_width = this.videoWidth
    this.metrics.video_height = this.videoHeight
    return {
      view_id: this.viewId,
      seq: this.seq,
      started_at: this.startedAt,
      ended: this.ended,
      video: {
        id: this.video.id, title: this.video.title, series_id: this.video.seriesId, series_title: this.video.seriesTitle,
        duration_ms: this.video.durationMs, stream_type: this.video.streamType ?? 'on-demand',
        source_type: this.video.sourceType, source_host: this.video.sourceHost,
        cdn: this.cdn || undefined, drm_type: this.drmType || undefined,
        content_type: this.video.contentType, language_code: this.video.languageCode,
        variant_name: this.video.variantName, encoding_variant: this.video.encodingVariant,
      },
      player: {
        name: this.player.name, version: this.player.version, autoplay: Boolean(this.player.autoplay),
        width: this.playerWidth, height: this.playerHeight, fullscreen: this.fullscreen, pip: this.pip, captions: this.captionsOn,
      },
      ...(this.video.experimentName ? { experiment_name: this.video.experimentName } : {}),
      ...(this.video.subPropertyId ? { sub_property_id: this.video.subPropertyId } : {}),
      ...(this.page ? { page: this.page } : {}),
      ...(this.video.viewSessionId ? { view_session_id: this.video.viewSessionId } : {}),
      // Times add up in fractions of a millisecond; the beacon carries whole ones.
      metrics: Object.fromEntries(Object.entries(this.metrics).map(([key, value]) =>
        [key, typeof value === 'number' && key !== 'max_upscale_pct' && key !== 'max_downscale_pct' ? Math.round(value) : value])),
      custom: Object.fromEntries(Object.entries(this.video.custom ?? {}).filter(([, value]) => value)) as Record<string, string>,
      error: this.error,
      events: this.events.slice(0, maxEvents),
    }
  }

  /** The backend took the first `count` events. */
  sent(count: number): void {
    this.events.splice(0, count)
  }

  private event(type: string, data?: Record<string, unknown>): void {
    this.events.push(data ? { t: Math.round(this.now() - this.t0), type, data } : { t: Math.round(this.now() - this.t0), type })
  }

  private move(next: State): void {
    this.account()
    this.state = next
  }

  private stopAdClock(): void {
    if (this.adPlayingSince === null) return
    this.metrics.ad_watch_ms += this.now() - this.adPlayingSince
    this.adPlayingSince = null
  }

  /** Adds the time since the last change to the totals of the state the view is in. */
  private account(): void {
    const now = this.now()
    const ms = Math.max(0, now - this.since)
    this.since = now
    if (this.ended || !ms) return
    const m = this.metrics
    if (WATCHING.has(this.state)) m.watch_ms += ms
    if (this.state === 'rebuffering') m.rebuffer_ms += ms
    if (this.state === 'seeking') m.seek_ms += ms
    if (this.state !== 'playing') return
    m.playing_ms += ms
    if (this.kbps !== null) {
      this.bitrateMs += this.kbps * ms
      this.bitratePlayingMs += ms
    }
    if (this.videoWidth && this.videoHeight && this.playerWidth && this.playerHeight) {
      // How much the dimension that fills the player first is stretched (320 → 640: 100 %) or shrunk.
      const scale = Math.min(this.playerWidth / this.videoWidth, this.playerHeight / this.videoHeight)
      if (scale > 1) {
        const pct = Math.round((scale - 1) * 1000) / 10
        m.upscale_ms += ms
        m.upscale_pct_ms += pct * ms
        m.max_upscale_pct = Math.max(m.max_upscale_pct, pct)
      } else if (scale < 1) {
        const pct = Math.round((1 / scale - 1) * 1000) / 10
        m.downscale_ms += ms
        m.downscale_pct_ms += pct * ms
        m.max_downscale_pct = Math.max(m.max_downscale_pct, pct)
      }
    }
  }
}

/** widevine, playready, fairplay or clearkey from a key system name or HLS key format ('' when unknown). */
export function drmTypeOf(keySystem: string | null | undefined): string {
  const name = (keySystem ?? '').toLowerCase()
  if (name.includes('widevine') || name.includes('edef8ba9')) return 'widevine'
  if (name.includes('playready') || name.includes('9a04f079')) return 'playready'
  if (name.includes('fairplay') || name.includes('apple.fps') || name.includes('streamingkeydelivery') || name.includes('94ce86fb')) return 'fairplay'
  if (name.includes('clearkey') || name.includes('e2719d58') || name.includes('1077efec')) return 'clearkey'
  return ''
}

/** The host part of a URL ('' when it is not one). */
export function hostnameOf(url: string | null | undefined): string {
  try { return url ? new URL(url, typeof location === 'undefined' ? undefined : location.href).hostname : '' } catch { return '' }
}

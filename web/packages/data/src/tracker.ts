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
  /** Up to five of your own dimensions (an experiment, a page type…); the Console breaks views down by them. */
  custom?: Partial<Record<1 | 2 | 3 | 4 | 5, string>>
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
  metrics: Record<string, number | null>
  custom: Record<string, string>
  error: { code: string; message: string; fatal: boolean } | null
  events: BeaconEvent[]
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
  private error: { code: string; message: string; fatal: boolean } | null = null
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
  }

  constructor(
    readonly video: VideoInfo,
    readonly player: PlayerInfo,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.t0 = now()
    this.since = this.t0
    this.event('viewstart')
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
      this.metrics.video_startup_ms = Math.round(this.now() - (this.playRequestedAt ?? this.t0) - this.startupAdMs)
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

  failed(code: string, message: string, fatal = true): void {
    if (this.ended) return
    this.event('error', { code, message, fatal })
    if (!fatal) return
    this.error = { code, message, fatal }
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

  /** An ad was asked to play. */
  adStart(): void {
    if (this.ended) return
    if (this.state !== 'ad') this.adBreakStart()
    this.metrics.ad_count += 1
    this.event('adplay')
  }

  /** The ad's frames are moving. */
  adPlaying(): void {
    if (this.state !== 'ad' || this.adPlayingSince !== null) return
    this.adPlayingSince = this.now()
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
      },
      player: {
        name: this.player.name, version: this.player.version, autoplay: Boolean(this.player.autoplay),
        width: this.playerWidth, height: this.playerHeight,
      },
      // Times add up in fractions of a millisecond; the beacon carries whole ones.
      metrics: Object.fromEntries(Object.entries(this.metrics).map(([key, value]) =>
        [key, typeof value === 'number' && key !== 'max_upscale_pct' ? Math.round(value) : value])),
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
      const scale = Math.min(this.playerWidth / this.videoWidth, this.playerHeight / this.videoHeight)
      if (scale > 1) {
        m.upscale_ms += ms
        m.max_upscale_pct = Math.max(m.max_upscale_pct, Math.round((scale - 1) * 1000) / 10)
      } else if (scale < 1) m.downscale_ms += ms
    }
  }
}

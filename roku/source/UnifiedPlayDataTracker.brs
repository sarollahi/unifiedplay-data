' UnifiedPlay Data for Roku: one view, what happened since playback of one video was asked for,
' and the totals the beacon carries (spec/beacon.md). The web (tracker.ts), Android
' (ViewTracker.kt) and iOS (ViewTracker.swift) SDKs do the same; change them together.
'
' tracker = UPD_NewTracker(video, player, clock)
'   video:  { id, title, series_id, series_title, duration_ms, stream_type, source_type, source_host, cdn, drm_type, view_session_id,
'             content_type, language_code, variant_name, encoding_variant, experiment_name, sub_property_id, custom ("1".."10") }
'   player: { name, version, autoplay }
'   clock:  invalid (a real clock) or { ms: 0 } (tests move clock.ms)

function UPD_NewTracker(video as object, player as object, clock = invalid as dynamic) as object
    tracker = {
        video: video, player: player, clock: clock, timer: CreateObject("roTimespan"),
        viewId: UPD_NewId(), seq: 0, state: "idle", ended: false, firstFrame: false,
        playRequestedAt: invalid, events: [], error: invalid,
        kbps: invalid, bitrateMs: 0#, bitratePlayingMs: 0#, videoWidth: invalid, videoHeight: invalid,
        playerWidth: invalid, playerHeight: invalid,
        beforeAd: "idle", adBreakAt: 0#, startupAdMs: 0#, adPlayingSince: invalid,
        cdn: UPD_Text(video.cdn), drmType: UPD_Text(video.drm_type), fullscreen: false, pip: false, mode: "standard", captionsOn: false,
        prerollAt: invalid, adRequestAt: invalid, adResponseAt: invalid,
        metrics: {
            player_startup_ms: invalid, video_startup_ms: invalid, watch_ms: 0#, playing_ms: 0#,
            rebuffer_count: 0, rebuffer_ms: 0#, seek_count: 0, seek_ms: 0#, playhead_ms: 0#,
            avg_bitrate_kbps: invalid, max_bitrate_kbps: invalid, rendition_changes: 0,
            video_width: invalid, video_height: invalid, upscale_ms: 0#, downscale_ms: 0#, max_upscale_pct: 0#,
            dropped_frames: 0, live_latency_ms: invalid,
            ad_break_count: 0, ad_count: 0, ad_watch_ms: 0#, ad_error_count: 0,
            request_completed: 0, request_failed: 0, request_canceled: 0,
            request_failed_manifest: 0, request_failed_media: 0, request_failed_encryption: 0,
            request_media_completed: 0, request_media_bytes: 0#, request_media_ms: 0#,
            request_media_ttfb_ms: 0#, request_media_ttfb_count: 0, request_media_max_ttfb_ms: 0#,
            content_startup_ms: invalid, ad_startup_ms: invalid, preroll_request_ms: invalid, preroll_load_ms: invalid,
            preroll_requests: 0, upscale_pct_ms: 0#, downscale_pct_ms: 0#, max_downscale_pct: 0#
        },
        now: UPD_Now, event: UPD_Event, move: UPD_Move, account: UPD_Account, stopAdClock: UPD_StopAdClock,
        playerStartup: UPD_PlayerStartup, play: UPD_Play, playing: UPD_Playing, pause: UPD_Pause,
        bufferingStart: UPD_BufferingStart, bufferingEnd: UPD_BufferingEnd, seeking: UPD_Seeking, seeked: UPD_Seeked,
        rendition: UPD_Rendition, playerSize: UPD_PlayerSize, playhead: UPD_Playhead, liveLatency: UPD_LiveLatency,
        failed: UPD_Failed, completed: UPD_Completed, end: UPD_End,
        adBreakStart: UPD_AdBreakStart, adStart: UPD_AdStart, adPlaying: UPD_AdPlaying, adPause: UPD_AdPause,
        adEnd: UPD_AdEnd, adError: UPD_AdError, adBreakEnd: UPD_AdBreakEnd,
        requestCompleted: UPD_RequestCompleted, requestFailed: UPD_RequestFailed, requestCanceled: UPD_RequestCanceled,
        playbackMode: UPD_PlaybackMode, setDrmType: UPD_SetDrmType, captions: UPD_Captions,
        adRequest: UPD_AdRequest, adResponse: UPD_AdResponse,
        snapshot: UPD_Snapshot, sent: UPD_Sent
    }
    tracker.startedAt = CreateObject("roDateTime").ToISOString()
    tracker.t0 = tracker.now()
    tracker.since = tracker.t0
    tracker.event("viewstart", invalid)
    return tracker
end function

function UPD_Now() as double
    if m.clock <> invalid then return m.clock.ms
    return m.timer.TotalMilliseconds()
end function

function UPD_NewId() as string
    return CreateObject("roDeviceInfo").GetRandomUUID()
end function

function UPD_Text(value as dynamic) as string
    if value = invalid then return ""
    return value
end function

function UPD_Max(a as dynamic, b as dynamic) as dynamic
    if a > b then return a
    return b
end function

sub UPD_Event(eventType as string, data as dynamic)
    entry = { t: Int(m.now() - m.t0 + 0.5), type: eventType }
    if data <> invalid then entry.data = data
    m.events.Push(entry)
end sub

' Adds the time since the last change to the totals of the state the view is in.
sub UPD_Account()
    now = m.now()
    ms = UPD_Max(0#, now - m.since)
    m.since = now
    if m.ended or ms = 0 then return
    s = m.state
    if s = "starting" or s = "playing" or s = "rebuffering" or s = "seeking" then m.metrics.watch_ms = m.metrics.watch_ms + ms
    if s = "rebuffering" then m.metrics.rebuffer_ms = m.metrics.rebuffer_ms + ms
    if s = "seeking" then m.metrics.seek_ms = m.metrics.seek_ms + ms
    if s <> "playing" then return
    m.metrics.playing_ms = m.metrics.playing_ms + ms
    if m.kbps <> invalid then
        m.bitrateMs = m.bitrateMs + m.kbps * ms
        m.bitratePlayingMs = m.bitratePlayingMs + ms
    end if
    if m.videoWidth <> invalid and m.videoHeight <> invalid and m.playerWidth <> invalid and m.playerHeight <> invalid and m.videoWidth > 0 and m.videoHeight > 0 then
        scaleW = m.playerWidth / m.videoWidth
        scaleH = m.playerHeight / m.videoHeight
        scale = scaleW
        if scaleH < scale then scale = scaleH
        ' How much the dimension that fills the player first is stretched (320 to 640: 100 %) or shrunk.
        if scale > 1 then
            pct = Int((scale - 1) * 1000 + 0.5) / 10
            m.metrics.upscale_ms = m.metrics.upscale_ms + ms
            m.metrics.upscale_pct_ms = m.metrics.upscale_pct_ms + pct * ms
            m.metrics.max_upscale_pct = UPD_Max(m.metrics.max_upscale_pct, pct)
        else if scale < 1 then
            pct = Int((1 / scale - 1) * 1000 + 0.5) / 10
            m.metrics.downscale_ms = m.metrics.downscale_ms + ms
            m.metrics.downscale_pct_ms = m.metrics.downscale_pct_ms + pct * ms
            m.metrics.max_downscale_pct = UPD_Max(m.metrics.max_downscale_pct, pct)
        end if
    end if
end sub

sub UPD_Move(nextState as string)
    m.account()
    m.state = nextState
end sub

sub UPD_StopAdClock()
    if m.adPlayingSince = invalid then return
    m.metrics.ad_watch_ms = m.metrics.ad_watch_ms + m.now() - m.adPlayingSince
    m.adPlayingSince = invalid
end sub

sub UPD_PlayerStartup(ms as dynamic)
    if m.metrics.player_startup_ms = invalid then m.metrics.player_startup_ms = UPD_Max(0#, ms)
end sub

' Playback was asked for (control "play", autoplay).
sub UPD_Play()
    if m.ended or m.state = "ad" then return
    m.event("play", invalid)
    if not m.firstFrame then
        if m.playRequestedAt = invalid then m.playRequestedAt = m.now()
        m.move("starting")
    end if
end sub

' Frames are moving: the first one, after a stall, a seek or a pause.
sub UPD_Playing()
    if m.ended or m.state = "ad" then return
    if not m.firstFrame then
        m.firstFrame = true
        startedAt = m.t0
        if m.playRequestedAt <> invalid then startedAt = m.playRequestedAt
        since = m.now() - startedAt
        ' Video startup ends at the first frame of a pre-roll, if one came first; content startup leaves ads out.
        if m.metrics.video_startup_ms = invalid then m.metrics.video_startup_ms = since
        m.metrics.content_startup_ms = since - m.startupAdMs
    end if
    if m.state = "rebuffering" then m.event("rebufferend", invalid)
    if m.state <> "playing" then m.event("playing", invalid)
    m.move("playing")
end sub

sub UPD_Pause()
    if m.ended or m.state = "paused" or m.state = "ad" then return
    if m.state = "rebuffering" then m.event("rebufferend", invalid)
    m.event("pause", invalid)
    m.move("paused")
end sub

' Only a stall after the first frame and outside a seek is rebuffering.
sub UPD_BufferingStart()
    if m.state <> "playing" then return
    m.metrics.rebuffer_count = m.metrics.rebuffer_count + 1
    m.event("rebufferstart", invalid)
    m.move("rebuffering")
end sub

sub UPD_BufferingEnd()
    if m.state = "rebuffering" then m.playing()
end sub

sub UPD_Seeking()
    if m.ended or not m.firstFrame or m.state = "seeking" or m.state = "ad" then return
    m.metrics.seek_count = m.metrics.seek_count + 1
    m.event("seeking", invalid)
    m.move("seeking")
end sub

sub UPD_Seeked(paused as boolean)
    if m.state <> "seeking" then return
    m.event("seeked", invalid)
    if paused then m.move("paused")
end sub

sub UPD_Rendition(kbps as dynamic, width as dynamic, height as dynamic)
    if m.state = "ad" then return
    if kbps = m.kbps and width = m.videoWidth and height = m.videoHeight then return
    m.account()
    if m.firstFrame then m.metrics.rendition_changes = m.metrics.rendition_changes + 1
    m.kbps = kbps
    m.videoWidth = width
    m.videoHeight = height
    if kbps <> invalid then
        if m.metrics.max_bitrate_kbps = invalid then m.metrics.max_bitrate_kbps = 0
        m.metrics.max_bitrate_kbps = UPD_Max(m.metrics.max_bitrate_kbps, Int(kbps + 0.5))
    end if
    m.event("rendition", { kbps: kbps, width: width, height: height })
end sub

sub UPD_PlayerSize(width as integer, height as integer)
    if width = m.playerWidth and height = m.playerHeight then return
    m.account()
    m.playerWidth = invalid
    m.playerHeight = invalid
    if width > 0 then m.playerWidth = width
    if height > 0 then m.playerHeight = height
end sub

sub UPD_Playhead(ms as dynamic)
    if m.state <> "ad" then m.metrics.playhead_ms = UPD_Max(m.metrics.playhead_ms, ms)
end sub

sub UPD_LiveLatency(ms as dynamic)
    m.metrics.live_latency_ms = UPD_Max(0#, ms)
end sub

' fatal: it stopped playback. businessException: your own rule stopped it (geo-block, paywall): no failure.
sub UPD_Failed(code as string, message as string, fatal = true as boolean, businessException = false as boolean)
    if m.ended then return
    data = { code: code, message: message, fatal: fatal }
    if businessException then data.business_exception = true
    m.event("error", data)
    if not fatal then return
    m.error = { code: code, message: message, fatal: fatal, business_exception: businessException }
    m.end()
end sub

sub UPD_Captions(isOn as boolean)
    if not isOn or m.captionsOn then return
    m.captionsOn = true
    m.event("captions", { on: true })
end sub

' An ad request went out (VAST/VMAP): before the first pre-roll plays, its time is pre-roll request time.
sub UPD_AdRequest()
    if m.ended then return
    if not m.firstFrame and m.metrics.ad_startup_ms = invalid then
        m.metrics.preroll_requests = m.metrics.preroll_requests + 1
        if m.adRequestAt = invalid then m.adRequestAt = m.now()
    end if
    m.event("adrequest", invalid)
end sub

sub UPD_AdResponse()
    if m.ended then return
    now = m.now()
    if m.adRequestAt <> invalid and m.playRequestedAt <> invalid and m.metrics.ad_startup_ms = invalid then
        ' Only time after playback was asked for counts.
        before = 0#
        if m.metrics.preroll_request_ms <> invalid then before = m.metrics.preroll_request_ms
        m.metrics.preroll_request_ms = before + now - UPD_Max(m.adRequestAt, m.playRequestedAt)
    end if
    m.adRequestAt = invalid
    m.adResponseAt = now
    m.event("adresponse", invalid)
end sub

sub UPD_Completed()
    if m.ended then return
    m.event("ended", invalid)
    m.end()
end sub

sub UPD_End()
    if m.ended then return
    m.stopAdClock()
    m.move("ended")
    m.ended = true
    m.event("viewend", invalid)
end sub

' Ads: an ad break is no video time, and a pre-roll is no part of video startup.
sub UPD_AdBreakStart()
    if m.ended or m.state = "ad" then return
    if m.state = "idle" and m.playRequestedAt = invalid then m.playRequestedAt = m.now()
    m.beforeAd = m.state
    if m.state = "idle" then m.beforeAd = "starting"
    m.adBreakAt = m.now()
    m.metrics.ad_break_count = m.metrics.ad_break_count + 1
    m.event("adbreakstart", invalid)
    m.move("ad")
end sub

sub UPD_AdStart()
    if m.ended then return
    if m.state <> "ad" then m.adBreakStart()
    if not m.firstFrame and m.prerollAt = invalid then m.prerollAt = m.now()
    m.metrics.ad_count = m.metrics.ad_count + 1
    m.event("adplay", invalid)
end sub

sub UPD_AdPlaying()
    if m.state <> "ad" or m.adPlayingSince <> invalid then return
    now = m.now()
    m.adPlayingSince = now
    if not m.firstFrame and m.metrics.ad_startup_ms = invalid then
        asked = m.adBreakAt
        if m.prerollAt <> invalid then asked = m.prerollAt
        m.metrics.ad_startup_ms = now - asked
        ' Loading the ad: from the last ad response (or the ad's start), never before playback was asked for.
        loadFrom = asked
        if m.adResponseAt <> invalid then loadFrom = m.adResponseAt
        if m.playRequestedAt <> invalid then loadFrom = UPD_Max(loadFrom, m.playRequestedAt)
        m.metrics.preroll_load_ms = now - loadFrom
        startedAt = m.t0
        if m.playRequestedAt <> invalid then startedAt = m.playRequestedAt
        m.metrics.video_startup_ms = now - startedAt
    end if
    m.event("adplaying", invalid)
end sub

sub UPD_AdPause()
    if m.state <> "ad" then return
    m.stopAdClock()
    m.event("adpause", invalid)
end sub

sub UPD_AdEnd()
    if m.state <> "ad" then return
    m.stopAdClock()
    m.event("adended", invalid)
end sub

sub UPD_AdError(code as string, message = "" as string)
    if m.ended then return
    m.stopAdClock()
    m.metrics.ad_error_count = m.metrics.ad_error_count + 1
    m.event("aderror", { code: code, message: message })
end sub

sub UPD_AdBreakEnd()
    if m.state <> "ad" then return
    m.stopAdClock()
    if not m.firstFrame then m.startupAdMs = m.startupAdMs + m.now() - m.adBreakAt
    m.event("adbreakend", invalid)
    b = m.beforeAd
    if b = "playing" or b = "rebuffering" or b = "seeking" then b = "paused"
    m.move(b)
end sub

' Requests (spec: Requests). request: { type, hostname, start, response_start, response_end, bytes, headers, error, code, text }
function UPD_IsMedia(requestType as dynamic) as boolean
    return requestType = invalid or requestType = "video" or requestType = "audio" or requestType = "media"
end function

sub UPD_CdnFrom(tracker as object, request as object)
    if request.headers = invalid or tracker.video.cdn <> invalid then return
    name = request.headers["x-cdn"]
    if name = invalid or name = "" or name = tracker.cdn then return
    tracker.cdn = Left(name, 64)
    tracker.event("cdnchange", { cdn: tracker.cdn })
end sub

sub UPD_RequestCompleted(request as object)
    if m.ended then return
    m.metrics.request_completed = m.metrics.request_completed + 1
    UPD_CdnFrom(m, request)
    if not UPD_IsMedia(request.type) then return
    m.metrics.request_media_completed = m.metrics.request_media_completed + 1
    if request.bytes <> invalid then m.metrics.request_media_bytes = m.metrics.request_media_bytes + request.bytes
    if request.start = invalid then return
    if request.response_end <> invalid then m.metrics.request_media_ms = m.metrics.request_media_ms + UPD_Max(0#, request.response_end - request.start)
    if request.response_start <> invalid then
        ttfb = UPD_Max(0#, request.response_start - request.start)
        m.metrics.request_media_ttfb_ms = m.metrics.request_media_ttfb_ms + ttfb
        m.metrics.request_media_ttfb_count = m.metrics.request_media_ttfb_count + 1
        m.metrics.request_media_max_ttfb_ms = UPD_Max(m.metrics.request_media_max_ttfb_ms, ttfb)
    end if
end sub

sub UPD_RequestFailed(request as object)
    if m.ended then return
    m.metrics.request_failed = m.metrics.request_failed + 1
    t = request.type
    if t = "manifest" then
        m.metrics.request_failed_manifest = m.metrics.request_failed_manifest + 1
    else if t = "encryption" then
        m.metrics.request_failed_encryption = m.metrics.request_failed_encryption + 1
    else if t = "video" or t = "audio" or t = "media" or t = "video_init" or t = "audio_init" then
        m.metrics.request_failed_media = m.metrics.request_failed_media + 1
    end if
    UPD_CdnFrom(m, request)
    m.event("requestfailed", { type: request.type, hostname: request.hostname, error: request.error, code: request.code, text: request.text })
end sub

sub UPD_RequestCanceled(request as object)
    if m.ended then return
    m.metrics.request_canceled = m.metrics.request_canceled + 1
    m.event("requestcanceled", { type: request.type, hostname: request.hostname })
end sub

sub UPD_PlaybackMode(mode as string)
    if mode = m.mode then return
    m.mode = mode
    if mode = "fullscreen" then m.fullscreen = true
    if mode = "pip" then m.pip = true
    m.event("playbackmodechange", { mode: mode })
end sub

sub UPD_SetDrmType(drmType as string)
    if drmType <> "" then m.drmType = drmType
end sub

function UPD_Whole(value as dynamic) as dynamic
    if value = invalid then return invalid
    return Int(value + 0.5)
end function

' The view as the next beacon sends it, with its oldest unsent events.
function UPD_Snapshot(maxEvents = 25 as integer) as object
    m.account()
    if m.adPlayingSince <> invalid then
        now = m.now()
        m.metrics.ad_watch_ms = m.metrics.ad_watch_ms + now - m.adPlayingSince
        m.adPlayingSince = now
    end if
    m.seq = m.seq + 1
    if m.bitratePlayingMs > 0 then m.metrics.avg_bitrate_kbps = Int(m.bitrateMs / m.bitratePlayingMs + 0.5) else m.metrics.avg_bitrate_kbps = invalid
    m.metrics.video_width = m.videoWidth
    m.metrics.video_height = m.videoHeight
    metrics = {}
    for each key in m.metrics
        value = m.metrics[key]
        if key = "max_upscale_pct" or key = "max_downscale_pct" or value = invalid then metrics[key] = value else metrics[key] = UPD_Whole(value)
    end for
    events = []
    for each entry in m.events
        if events.Count() >= maxEvents then exit for
        events.Push(entry)
    end for
    custom = {}
    if m.video.custom <> invalid then
        for each key in m.video.custom
            if m.video.custom[key] <> "" then custom[key] = m.video.custom[key]
        end for
    end if
    v = m.video
    cdn = invalid
    if m.cdn <> "" then cdn = m.cdn
    drm = invalid
    if m.drmType <> "" then drm = m.drmType
    streamType = v.stream_type
    if streamType = invalid then streamType = "on-demand"
    snapshot = {
        view_id: m.viewId, seq: m.seq, started_at: m.startedAt, ended: m.ended,
        video: { id: v.id, title: v.title, series_id: v.series_id, series_title: v.series_title, duration_ms: v.duration_ms,
                 stream_type: streamType, source_type: v.source_type, source_host: v.source_host, cdn: cdn, drm_type: drm,
                 content_type: v.content_type, language_code: v.language_code, variant_name: v.variant_name, encoding_variant: v.encoding_variant },
        player: { name: m.player.name, version: m.player.version, autoplay: m.player.autoplay = true,
                  width: m.playerWidth, height: m.playerHeight, fullscreen: m.fullscreen, pip: m.pip, captions: m.captionsOn },
        metrics: metrics, custom: custom, error: m.error, events: events
    }
    if v.view_session_id <> invalid then snapshot.view_session_id = v.view_session_id
    if v.experiment_name <> invalid then snapshot.experiment_name = v.experiment_name
    if v.sub_property_id <> invalid then snapshot.sub_property_id = v.sub_property_id
    return snapshot
end function

' The backend took the first count events.
sub UPD_Sent(count as integer)
    for i = 1 to count
        if m.events.Count() = 0 then exit for
        m.events.Shift()
    end for
end sub

' Runs the checks: npx brs-cli roku/source/UnifiedPlayDataTracker.brs roku/components/UnifiedPlayData.brs roku/tests/main.brs
' (brs-node, a BrightScript interpreter). The same cases as the web, Android and iOS tests.
sub main()
    failures = 0
    failures = failures + splitsTimeIntoStartupPlayingRebufferingAndSeeking()
    failures = failures + addsUpRequestsCountsFailuresByTypeAndNamesTheCdn()
    failures = failures + keepsAdsOutOfVideoTime()
    failures = failures + readsTheVideoNodesSegments()
    failures = failures + timesPreRollRequestsAndLoading()
    failures = failures + weighsScalingAndKeepsBusinessExceptionsApart()
    if failures = 0 then print "ALL PASSED" else print "FAILED: "; failures
end sub

function check(name as string, actual as dynamic, expected as dynamic) as integer
    if FormatJson(actual) = FormatJson(expected) then return 0
    print "  x "; name; ": got "; FormatJson(actual); ", expected "; FormatJson(expected)
    return 1
end function

function splitsTimeIntoStartupPlayingRebufferingAndSeeking() as integer
    clock = { ms: 0# }
    view = UPD_NewTracker({ id: "ep_1" }, { name: "test" }, clock)
    view.playerStartup(100)
    view.play() : clock.ms = clock.ms + 800 : view.playing()
    clock.ms = clock.ms + 5000 : view.bufferingStart() : clock.ms = clock.ms + 1200 : view.bufferingEnd()
    clock.ms = clock.ms + 3000 : view.seeking() : clock.ms = clock.ms + 400 : view.seeked(false) : clock.ms = clock.ms + 100 : view.playing()
    clock.ms = clock.ms + 2000 : view.pause() : clock.ms = clock.ms + 10000
    s = view.snapshot(100)
    f = 0
    f = f + check("player_startup_ms", s.metrics.player_startup_ms, 100)
    f = f + check("video_startup_ms", s.metrics.video_startup_ms, 800)
    f = f + check("rebuffer_count", s.metrics.rebuffer_count, 1)
    f = f + check("rebuffer_ms", s.metrics.rebuffer_ms, 1200)
    f = f + check("seek_count", s.metrics.seek_count, 1)
    f = f + check("seek_ms", s.metrics.seek_ms, 500)
    f = f + check("playing_ms", s.metrics.playing_ms, 10000)
    f = f + check("watch_ms", s.metrics.watch_ms, 12500)
    types = []
    for each e in s.events
        types.Push(e.type)
    end for
    f = f + check("events", types, ["viewstart", "play", "playing", "rebufferstart", "rebufferend", "playing", "seeking", "seeked", "playing", "pause"])
    if f = 0 then print "ok - splits time into startup, playing, rebuffering and seeking"
    return f
end function

function addsUpRequestsCountsFailuresByTypeAndNamesTheCdn() as integer
    clock = { ms: 0# }
    view = UPD_NewTracker({ id: "ep_1", view_session_id: "cmcd-1" }, { name: "test" }, clock)
    view.requestCompleted({ type: "manifest", start: 0, response_start: 50, response_end: 80, bytes: 2000, headers: { "x-cdn": "fastly" } })
    view.requestCompleted({ type: "video", start: 100, response_start: 140, response_end: 1100, bytes: 1250000 })
    view.requestCompleted({ type: "audio", start: 100, response_start: 160, response_end: 600, bytes: 125000, headers: { "X-CDN": "cloudflare" } })
    view.requestCompleted({ type: "video_init", start: 0, response_end: 10, bytes: 900 })
    view.requestFailed({ type: "video", hostname: "cdn.example.com", error: "http", code: 503 })
    view.requestFailed({ type: "encryption", code: 403 })
    view.requestCanceled({ type: "audio" })
    view.playbackMode("pip") : view.playbackMode("pip") : view.playbackMode("standard")
    view.setDrmType("playready")
    s = view.snapshot(100)
    f = 0
    f = f + check("request_completed", s.metrics.request_completed, 4)
    f = f + check("request_failed", s.metrics.request_failed, 2)
    f = f + check("request_canceled", s.metrics.request_canceled, 1)
    f = f + check("request_failed_media", s.metrics.request_failed_media, 1)
    f = f + check("request_failed_encryption", s.metrics.request_failed_encryption, 1)
    f = f + check("request_media_completed", s.metrics.request_media_completed, 2)
    f = f + check("request_media_bytes", s.metrics.request_media_bytes, 1375000)
    f = f + check("request_media_ms", s.metrics.request_media_ms, 1500)
    f = f + check("request_media_ttfb_ms", s.metrics.request_media_ttfb_ms, 100)
    f = f + check("request_media_ttfb_count", s.metrics.request_media_ttfb_count, 2)
    f = f + check("request_media_max_ttfb_ms", s.metrics.request_media_max_ttfb_ms, 60)
    f = f + check("cdn", s.video.cdn, "cloudflare")
    f = f + check("drm_type", s.video.drm_type, "playready")
    f = f + check("pip", s.player.pip, true)
    f = f + check("fullscreen", s.player.fullscreen, false)
    f = f + check("view_session_id", s.view_session_id, "cmcd-1")
    cdnChanges = 0
    modeChanges = 0
    for each e in s.events
        if e.type = "cdnchange" then cdnChanges = cdnChanges + 1
        if e.type = "playbackmodechange" then modeChanges = modeChanges + 1
    end for
    f = f + check("cdnchange events", cdnChanges, 2)
    f = f + check("playbackmodechange events", modeChanges, 2)
    if f = 0 then print "ok - adds up requests, counts failures by type and names the CDN"
    return f
end function

function keepsAdsOutOfVideoTime() as integer
    clock = { ms: 0# }
    view = UPD_NewTracker({ id: "ep_1" }, { name: "test" }, clock)
    view.play() : view.adBreakStart() : view.adStart() : view.adPlaying()
    clock.ms = clock.ms + 15000 : view.adEnd() : view.adBreakEnd()
    clock.ms = clock.ms + 700 : view.playing() : clock.ms = clock.ms + 1000
    s = view.snapshot(100)
    f = 0
    f = f + check("video_startup_ms", s.metrics.video_startup_ms, 0)
    f = f + check("content_startup_ms", s.metrics.content_startup_ms, 700)
    f = f + check("ad_watch_ms", s.metrics.ad_watch_ms, 15000)
    f = f + check("ad_count", s.metrics.ad_count, 1)
    f = f + check("watch_ms", s.metrics.watch_ms, 1700)
    if f = 0 then print "ok - keeps ads out of video time"
    return f
end function

function readsTheVideoNodesSegments() as integer
    clock = { ms: 0# }
    view = UPD_NewTracker({ id: "ep_1" }, { name: "roku" }, clock)
    UPD_Downloaded(view, { SegType: 2, SegUrl: "https://cdn.example.com/v/1.ts", DownloadDuration: 400, SegSize: 500000, Status: 200 })
    UPD_Downloaded(view, { SegType: 1, SegUrl: "https://cdn.example.com/a/1.aac", DownloadDuration: 100, SegSize: 50000 })
    UPD_Downloaded(view, { SegType: 2, SegUrl: "https://cdn.example.com/v/2.ts", DownloadDuration: 30, SegSize: 0, Status: 404 })
    s = view.snapshot(100)
    f = 0
    f = f + check("host", UPD_Host("https://cdn.example.com:8443/v/1.ts?x=1"), "cdn.example.com:8443")
    f = f + check("request_media_completed", s.metrics.request_media_completed, 2)
    f = f + check("request_media_bytes", s.metrics.request_media_bytes, 550000)
    f = f + check("request_media_ms", s.metrics.request_media_ms, 500)
    f = f + check("request_failed_media", s.metrics.request_failed_media, 1)
    if f = 0 then print "ok - reads the Video node's segments"
    return f
end function

function timesPreRollRequestsAndLoading() as integer
    clock = { ms: 0# }
    view = UPD_NewTracker({ id: "v", experiment_name: "ladder-b", content_type: "episode" }, { name: "test" }, clock)
    view.adRequest()
    clock.ms = clock.ms + 300 : view.play()
    clock.ms = clock.ms + 200 : view.adResponse()
    clock.ms = clock.ms + 100 : view.adRequest() : clock.ms = clock.ms + 150 : view.adResponse()
    clock.ms = clock.ms + 50 : view.adBreakStart() : view.adStart()
    clock.ms = clock.ms + 400 : view.adPlaying()
    clock.ms = clock.ms + 10000 : view.adEnd() : view.adBreakEnd()
    clock.ms = clock.ms + 700 : view.playing()
    s = view.snapshot(100)
    f = 0
    f = f + check("preroll_requests", s.metrics.preroll_requests, 2)
    f = f + check("preroll_request_ms", s.metrics.preroll_request_ms, 350)
    f = f + check("ad_startup_ms", s.metrics.ad_startup_ms, 400)
    f = f + check("preroll_load_ms", s.metrics.preroll_load_ms, 450)
    f = f + check("video_startup_ms", s.metrics.video_startup_ms, 900)
    f = f + check("content_startup_ms", s.metrics.content_startup_ms, 1200)
    f = f + check("experiment_name", s.experiment_name, "ladder-b")
    f = f + check("content_type", s.video.content_type, "episode")
    if f = 0 then print "ok - times pre-roll requests, loading and startup"
    return f
end function

function weighsScalingAndKeepsBusinessExceptionsApart() as integer
    clock = { ms: 0# }
    view = UPD_NewTracker({ id: "v" }, { name: "test" }, clock)
    view.playerSize(1280, 720)
    view.rendition(800, 640, 360)
    view.play() : view.playing()
    clock.ms = clock.ms + 1000
    view.rendition(4000, 2560, 1440)
    clock.ms = clock.ms + 3000
    view.captions(true)
    view.failed("geo", "Not in your country", true, true)
    s = view.snapshot(100)
    f = 0
    f = f + check("upscale_pct_ms", s.metrics.upscale_pct_ms, 100000)
    f = f + check("downscale_pct_ms", s.metrics.downscale_pct_ms, 300000)
    f = f + check("max_downscale_pct", s.metrics.max_downscale_pct, 100)
    f = f + check("business_exception", s.error.business_exception, true)
    f = f + check("captions", s.player.captions, true)
    if f = 0 then print "ok - weighs scaling amounts and keeps business exceptions apart"
    return f
end function

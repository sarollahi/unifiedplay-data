' The UnifiedPlayData task: watches the Video node and sends beacons (spec/beacon.md) every 10 s
' and right away on key moments. Runs on its own thread; the tracker is UnifiedPlayDataTracker.brs.

sub init()
    m.top.functionName = "UPD_Run"
end sub

function UPD_SdkVersion() as string
    return "1.1.1"
end function

sub UPD_Run()
    port = CreateObject("roMessagePort")
    config = m.top.config
    if config = invalid or config.key = invalid then
        print "UnifiedPlayData: set config.key before running"
        return
    end if
    video = m.top.video
    m.port = port
    m.config = config
    m.view = invalid
    m.views = []
    m.instanceId = UPD_NewId()
    m.transfers = {}
    m.disabled = false
    m.session = CreateObject("roDeviceInfo").GetRandomUUID()
    m.sourceAt = invalid
    m.readyAt = invalid
    m.clock = CreateObject("roTimespan")
    for each field in ["control", "state", "content", "position", "streamingSegment", "downloadedSegment", "errorCode", "timeToStartStreaming", "seek", "globalCaptionMode"]
        video.ObserveField(field, port)
    end for
    m.top.ObserveField("adEvent", port)
    m.top.ObserveField("exit", port)
    m.video = video
    UPD_NewSource(video.content)
    nextBeacon = m.clock.TotalMilliseconds() + 10000
    while true
        msg = Wait(1000, port)
        if type(msg) = "roSGNodeEvent" then
            if UPD_OnField(msg.GetField(), msg.GetData()) then exit while
        else if type(msg) = "roUrlEvent" then
            UPD_OnResponse(msg)
        end if
        if m.clock.TotalMilliseconds() >= nextBeacon then
            UPD_Send()
            nextBeacon = m.clock.TotalMilliseconds() + 10000
        end if
    end while
    if m.view <> invalid then m.view.end()
    UPD_Send()
end sub

function UPD_Host(url as dynamic) as dynamic
    if url = invalid or url = "" then return invalid
    rest = url
    at = Instr(1, rest, "://")
    if at > 0 then rest = Mid(rest, at + 3)
    slash = Instr(1, rest, "/")
    if slash > 0 then rest = Left(rest, slash - 1)
    return rest
end function

' The next view's video: the app's info when set, else what the content node says.
function UPD_Describe(content as dynamic) as dynamic
    if content = invalid then return invalid
    info = m.top.info
    streamType = "on-demand"
    if content.Live = true then streamType = "live"
    video = { id: content.id, title: content.title, stream_type: streamType, source_type: content.streamFormat, source_host: UPD_Host(content.url) }
    if content.id = invalid or content.id = "" then video.id = content.url
    if info <> invalid then
        for each key in info
            video[key] = info[key]
        end for
    end if
    return video
end function

sub UPD_NewSource(content as dynamic)
    if m.view <> invalid and not m.view.ended then
        m.view.end()
        UPD_Send()
    end if
    m.view = invalid
    m.nextVideo = UPD_Describe(content)
    m.sourceAt = invalid
    if content <> invalid then m.sourceAt = m.clock.TotalMilliseconds()
    m.readyAt = invalid
end sub

' The view for the current content; a new one when there is none or the last one ended.
function UPD_Current() as dynamic
    if m.view <> invalid and not m.view.ended then return m.view
    if m.nextVideo = invalid then return invalid
    app = CreateObject("roAppInfo")
    info = CreateObject("roDeviceInfo")
    m.view = UPD_NewTracker(m.nextVideo, { name: "roku", version: UPD_OsVersion(), autoplay: false, software: "Roku Video", software_version: UPD_OsVersion(),
                                           instance_id: m.instanceId, language: info.GetCurrentLocale().Replace("_", "-") })
    if m.video.width > 0 and m.video.height > 0 then m.view.playerSize(m.video.width, m.video.height)
    if m.sourceAt <> invalid and m.readyAt <> invalid then m.view.playerStartup(m.readyAt - m.sourceAt)
    m.views.Push(m.view)
    UPD_Send()
    return m.view
end function

function UPD_OsVersion() as string
    version = CreateObject("roDeviceInfo").GetOSVersion()
    if type(version) = "roAssociativeArray" then return version.major + "." + version.minor + "." + version.revision
    return ""
end function

' Returns true when the task should stop.
function UPD_OnField(field as string, data as dynamic) as boolean
    view = m.view
    if field = "exit" then return data = true
    if field = "adEvent" then
        UPD_Ad(data)
        return false
    end if
    if field = "content" then
        UPD_NewSource(data)
    else if field = "control" then
        if data = "play" or data = "resume" then
            current = UPD_Current()
            if current <> invalid then current.play()
        else if data = "stop" then
            if view <> invalid then view.end()
            UPD_Send()
        end if
    else if field = "timeToStartStreaming" then
        if data <> invalid and data > 0 then
            m.readyAt = m.sourceAt
            if m.sourceAt <> invalid then m.readyAt = m.sourceAt + data * 1000
            if view <> invalid then view.playerStartup(data * 1000)
        end if
    else if view = invalid then
        return false
    else if field = "state" then
        if data = "playing" then
            first = view.metrics.video_startup_ms = invalid
            view.playing()
            if first then UPD_Send()
        else if data = "buffering" then
            view.bufferingStart()
        else if data = "paused" then
            view.pause()
            UPD_Send()
        else if data = "finished" then
            view.completed()
            UPD_Send()
        else if data = "error" then
            view.failed(StrI(m.video.errorCode).Trim(), UPD_Text(m.video.errorMsg), true)
            UPD_Send()
        else if data = "stopped" then
            view.end()
            UPD_Send()
        end if
    else if field = "seek" then
        view.seeking()
    else if field = "globalCaptionMode" then
        view.captions(data = "On" or data = "Instant replay")
    else if field = "position" then
        view.playhead(data * 1000)
    else if field = "streamingSegment" then
        if data <> invalid and (data.segType = 0 or data.segType = 2) then
            kbps = invalid
            if data.segBitrateBps <> invalid and data.segBitrateBps > 0 then kbps = data.segBitrateBps / 1000
            width = invalid
            height = invalid
            if data.width <> invalid and data.width > 0 then width = data.width
            if data.height <> invalid and data.height > 0 then height = data.height
            view.rendition(kbps, width, height, UPD_Formats(m.video))
        end if
    else if field = "downloadedSegment" then
        UPD_Downloaded(view, data)
    end if
    return false
end function

' A segment the player downloaded (spec: Requests): bytes and download time; Roku shows no headers.
sub UPD_Downloaded(view as object, data as dynamic)
    if data = invalid then return
    requestType = "media"
    if data.SegType = 1 then requestType = "audio"
    if data.SegType = 2 then requestType = "video"
    if data.SegType = 3 then requestType = "subtitle"
    request = { type: requestType, hostname: UPD_Host(data.SegUrl), start: 0, response_end: data.DownloadDuration, bytes: data.SegSize }
    if data.Status <> invalid and data.Status >= 400 then
        request.code = data.Status
        request.error = "http"
        view.requestFailed(request)
    else
        view.requestCompleted(request)
    end if
end sub

sub UPD_Ad(event as dynamic)
    if event = invalid or event.type = invalid then return
    t = event.type
    if t = "adbreakstart" or t = "adstart" or t = "aderror" or t = "adrequest" then
        view = UPD_Current()
    else
        view = m.view
    end if
    if view = invalid then return
    if t = "adbreakstart" then
        view.adBreakStart()
        UPD_Send()
    else if t = "adstart" then
        view.adStart()
    else if t = "adrequest" then
        view.adRequest()
    else if t = "adresponse" then
        view.adResponse()
    else if t = "adplaying" then
        view.adPlaying()
    else if t = "adpause" then
        view.adPause()
    else if t = "adend" then
        view.adEnd()
    else if t = "aderror" then
        view.adError(UPD_Text(event.code), UPD_Text(event.message))
        UPD_Send()
    else if t = "adbreakend" then
        view.adBreakEnd()
        UPD_Send()
    end if
end sub

function UPD_Device() as object
    info = CreateObject("roDeviceInfo")
    app = CreateObject("roAppInfo")
    connection = "other"
    if info.GetConnectionType() = "WiFiConnection" then connection = "wifi"
    if info.GetConnectionType() = "WiredConnection" then connection = "wired"
    appVersion = UPD_Text(m.config.appVersion)
    if appVersion = "" then appVersion = app.GetVersion()
    return { os: "Roku OS", os_version: UPD_OsVersion(), manufacturer: "Roku", model: info.GetModel(), app_id: app.GetID(), app_version: appVersion,
             connection: connection, category: "tv", name: info.GetModelDisplayName() }
end function

' Sends every open view in one beacon; one beacon at a time.
sub UPD_Send()
    if m.disabled or m.views.Count() = 0 or m.transfers.Count() > 0 then return
    views = []
    snapshots = []
    for each view in m.views
        if views.Count() >= 10 then exit for
        views.Push(view)
        snapshots.Push(view.snapshot(25))
    end for
    userId = UPD_Text(m.config.userId)
    body = FormatJson({
        sdk: { name: "unifiedplay-data-roku", version: UPD_SdkVersion() }, session_id: m.session,
        viewer: { device_id: CreateObject("roDeviceInfo").GetChannelClientId(), user_id: userId, plan: UPD_Text(m.config.viewerPlan),
                  plan_status: UPD_Text(m.config.viewerPlanStatus), plan_category: UPD_Text(m.config.viewerPlanCategory) },
        device: UPD_Device(), views: snapshots
    })
    base = "https://backend.unifiedplay.com"
    if m.config.apiBase <> invalid then base = m.config.apiBase
    if m.config.beaconDomain <> invalid and m.config.beaconDomain <> "" then base = "https://" + m.config.beaconDomain
    transfer = CreateObject("roUrlTransfer")
    transfer.SetUrl(base + "/api/v1/data/beacons")
    transfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    transfer.InitClientCertificates()
    transfer.AddHeader("Content-Type", "application/json")
    transfer.AddHeader("X-Tenant-Key", m.config.key)
    transfer.AddHeader("X-Platform", "roku")
    transfer.SetMessagePort(m.port)
    if transfer.AsyncPostFromString(body) then
        m.transfers[StrI(transfer.GetIdentity()).Trim()] = { transfer: transfer, views: views, snapshots: snapshots }
    end if
end sub

sub UPD_OnResponse(msg as object)
    key = StrI(msg.GetSourceIdentity()).Trim()
    sent = m.transfers[key]
    if sent = invalid then return
    m.transfers.Delete(key)
    code = msg.GetResponseCode()
    enabled = true
    reply = ParseJson(msg.GetString())
    if reply <> invalid and reply.enabled = false then enabled = false
    if (code >= 200 and code < 300 and enabled) or code = 413 then
        ' 413: too big to ever go through; its events are dropped (the totals go next time).
        for i = 0 to sent.views.Count() - 1
            sent.views[i].sent(sent.snapshots[i].events.Count())
        end for
        kept = []
        for i = 0 to m.views.Count() - 1
            view = m.views[i]
            index = -1
            for j = 0 to sent.views.Count() - 1
                if sent.views[j].viewId = view.viewId then index = j
            end for
            ' Only once the backend has the view's end: it may have ended while this beacon was out.
            if index < 0 or not sent.snapshots[index].ended then kept.Push(view)
        end for
        m.views = kept
    else if (code >= 200 and code < 300) or code = 400 or code = 401 or code = 403 or code = 404 or code = 422 then
        m.disabled = true
        m.views = []
    end if
    ' 429, 5xx, offline: the events stay and go with the next beacon.
end sub

' The Video node's codecs ("mpeg4 avc" → avc, "hevc", "vp9"; audio "aac", "ac3"…) and dynamic range, where it tells.
function UPD_Formats(video as object) as object
    details = {}
    videoFormat = UPD_Text(video.videoFormat)
    if videoFormat <> "" then details.video_codec = videoFormat.Replace("mpeg4 ", "")
    audioFormat = UPD_Text(video.audioFormat)
    if audioFormat <> "" then details.audio_codec = audioFormat
    return details
end function

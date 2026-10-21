import Foundation

/// What one view plays.
public struct VideoInfo: Sendable {
    public var id: String?
    public var title: String?
    public var seriesID: String?
    public var seriesTitle: String?
    public var durationMs: Int?
    public var streamType: String
    public var sourceType: String?
    public var sourceHost: String?
    /// Up to five of your own dimensions (1...5: an experiment, a page type…); the Console breaks views down by them.
    public var custom: [Int: String]

    public init(id: String? = nil, title: String? = nil, seriesID: String? = nil, seriesTitle: String? = nil,
                durationMs: Int? = nil, streamType: String = "on-demand", sourceType: String? = nil, sourceHost: String? = nil,
                custom: [Int: String] = [:]) {
        self.id = id
        self.title = title
        self.seriesID = seriesID
        self.seriesTitle = seriesTitle
        self.durationMs = durationMs
        self.streamType = streamType
        self.sourceType = sourceType
        self.sourceHost = sourceHost
        self.custom = custom
    }
}

public struct PlayerInfo: Sendable {
    public var name: String
    public var version: String?
    public var autoplay: Bool

    public init(name: String, version: String? = nil, autoplay: Bool = false) {
        self.name = name
        self.version = version
        self.autoplay = autoplay
    }
}

/// One view: what happened since playback of one video was asked for, and the totals the beacon
/// carries (spec/beacon.md). The web (tracker.ts) and Android (ViewTracker.kt) SDKs do the same.
/// The SDK uses it on the main thread only.
public final class ViewTracker {
    private enum State { case idle, starting, playing, paused, rebuffering, seeking, ad, ended }

    public let viewID = UUID().uuidString.lowercased()
    public let video: VideoInfo
    public let player: PlayerInfo
    private let now: () -> Double
    private let startedAt = ISO8601DateFormatter.withFractionalSeconds.string(from: Date())
    private let t0: Double
    private var since: Double
    private var seq = 0
    private var state = State.idle
    private var playRequestedAt: Double?
    private var firstFrame = false
    private var events: [[String: Any]] = []
    private var error: [String: Any]?
    private var kbps: Double?
    private var bitrateMs = 0.0
    private var bitratePlayingMs = 0.0
    private var videoWidth: Int?
    private var videoHeight: Int?
    private var playerWidth: Int?
    private var playerHeight: Int?
    // Ads: the state to go back to, when the break began, ad time before the first frame, and the running ad clock.
    private var beforeAd = State.idle
    private var adBreakAt = 0.0
    private var startupAdMs = 0.0
    private var adPlayingSince: Double?
    public private(set) var ended = false

    private var playerStartupMs: Double?
    public private(set) var videoStartupMs: Double?
    private var watchMs = 0.0
    private var playingMs = 0.0
    private var rebufferCount = 0
    private var rebufferMs = 0.0
    private var seekCount = 0
    private var seekMs = 0.0
    private var playheadMs = 0.0
    private var maxBitrateKbps: Double?
    private var renditionChanges = 0
    private var upscaleMs = 0.0
    private var downscaleMs = 0.0
    private var maxUpscalePct = 0.0
    private var droppedFrames = 0
    private var liveLatencyMs: Double?
    private var adBreakCount = 0
    private var adCount = 0
    private var adWatchMs = 0.0
    private var adErrorCount = 0

    /// `now` is in milliseconds; tests pass their own clock.
    public init(video: VideoInfo, player: PlayerInfo, now: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime * 1000 }) {
        self.video = video
        self.player = player
        self.now = now
        t0 = now()
        since = t0
        event("viewstart")
    }

    /// How long the player took from getting the source to being able to start (the monitor measures it).
    public func playerStartup(_ ms: Double) {
        if playerStartupMs == nil, ms.isFinite { playerStartupMs = max(0, ms) }
    }

    /// Playback was asked for (play pressed, autoplay, rate set).
    public func play() {
        guard !ended, state != .ad else { return }
        event("play")
        if !firstFrame {
            if playRequestedAt == nil { playRequestedAt = now() }
            move(.starting)
        }
    }

    /// Frames of the video are moving: first frame, after a stall, after a seek, after a pause.
    public func playing() {
        guard !ended, state != .ad else { return }
        if !firstFrame {
            firstFrame = true
            videoStartupMs = now() - (playRequestedAt ?? t0) - startupAdMs
        }
        if state == .rebuffering { event("rebufferend") }
        if state != .playing { event("playing") }
        move(.playing)
    }

    public func pause() {
        guard !ended, state != .paused, state != .ad else { return }
        if state == .rebuffering { event("rebufferend") }
        event("pause")
        move(.paused)
    }

    /// The player ran out of data. Only a stall after the first frame and outside a seek is rebuffering.
    public func bufferingStart() {
        guard state == .playing else { return }
        rebufferCount += 1
        event("rebufferstart")
        move(.rebuffering)
    }

    public func bufferingEnd() {
        if state == .rebuffering { playing() }
    }

    public func seeking() {
        // A seek before the first frame (to a resume position) is part of startup.
        guard !ended, firstFrame, state != .seeking, state != .ad else { return }
        seekCount += 1
        event("seeking")
        move(.seeking)
    }

    /// The seek landed. While paused the seek is over; otherwise it is over when frames move again.
    public func seeked(paused: Bool) {
        guard state == .seeking else { return }
        event("seeked")
        if paused { move(.paused) }
    }

    public func rendition(kbps: Double?, width: Int?, height: Int?) {
        guard state != .ad else { return } // an ad's own rendition, in players that play ads themselves
        guard kbps != self.kbps || width != videoWidth || height != videoHeight else { return }
        account()
        if firstFrame { renditionChanges += 1 }
        self.kbps = kbps
        videoWidth = width
        videoHeight = height
        if let kbps { maxBitrateKbps = max(maxBitrateKbps ?? 0, kbps) }
        event("rendition", ["kbps": json(kbps.map { Int($0.rounded()) }), "width": json(width), "height": json(height)])
    }

    /// The player's size on screen in pixels.
    public func playerSize(width: Int, height: Int) {
        let w = width > 0 ? width : nil
        let h = height > 0 ? height : nil
        guard w != playerWidth || h != playerHeight else { return }
        account()
        playerWidth = w
        playerHeight = h
    }

    public func playhead(_ ms: Double) {
        if ms.isFinite, state != .ad { playheadMs = max(playheadMs, ms) }
    }

    public func droppedFrames(_ total: Int) {
        droppedFrames = max(droppedFrames, total)
    }

    public func liveLatency(_ ms: Double) {
        if ms.isFinite { liveLatencyMs = max(0, ms) }
    }

    public func failed(code: String, message: String, fatal: Bool = true) {
        guard !ended else { return }
        event("error", ["code": code, "message": message, "fatal": fatal])
        guard fatal else { return }
        error = ["code": code, "message": message, "fatal": true]
        end()
    }

    /// The video played to its end.
    public func completed() {
        guard !ended else { return }
        event("ended")
        end()
    }

    /// The viewer left the video: new item, player gone, app closed.
    public func end() {
        guard !ended else { return }
        stopAdClock()
        move(.ended)
        ended = true
        event("viewend")
    }

    // MARK: Ads

    /// The video gave way to ads (pre-, mid- or post-roll). Until adBreakEnd nothing counts as video time.
    public func adBreakStart() {
        guard !ended, state != .ad else { return }
        // Ads before anything else (a pre-roll after the play button): playback was asked for.
        if state == .idle, playRequestedAt == nil { playRequestedAt = now() }
        beforeAd = state == .idle ? .starting : state
        adBreakAt = now()
        adBreakCount += 1
        event("adbreakstart")
        move(.ad)
    }

    /// An ad was asked to play.
    public func adStart() {
        guard !ended else { return }
        if state != .ad { adBreakStart() }
        adCount += 1
        event("adplay")
    }

    /// The ad's frames are moving.
    public func adPlaying() {
        guard state == .ad, adPlayingSince == nil else { return }
        adPlayingSince = now()
        event("adplaying")
    }

    public func adPause() {
        guard state == .ad else { return }
        stopAdClock()
        event("adpause")
    }

    public func adEnd() {
        guard state == .ad else { return }
        stopAdClock()
        event("adended")
    }

    /// An ad failed. It does not fail the view: the video plays on without it.
    public func adError(code: String, message: String = "") {
        guard !ended else { return }
        stopAdClock()
        adErrorCount += 1
        event("aderror", ["code": code, "message": message])
    }

    /// The ads gave the video back.
    public func adBreakEnd() {
        guard state == .ad else { return }
        stopAdClock()
        // A pre-roll is not the video's startup.
        if !firstFrame { startupAdMs += now() - adBreakAt }
        event("adbreakend")
        // After a mid-roll the video is paused until its frames move again.
        move([.playing, .rebuffering, .seeking].contains(beforeAd) ? .paused : beforeAd)
    }

    /// The view as the next beacon sends it, with its oldest unsent events. Events stay until `sent(_:)` says the backend has them.
    public func snapshot(maxEvents: Int = .max) -> [String: Any] {
        account()
        if let started = adPlayingSince {
            let current = now()
            adWatchMs += current - started
            adPlayingSince = current
        }
        seq += 1
        func whole(_ value: Double?) -> Any { json(value.map { Int($0.rounded()) }) }
        let metrics: [String: Any] = [
            "player_startup_ms": whole(playerStartupMs),
            "video_startup_ms": whole(videoStartupMs),
            "watch_ms": Int(watchMs.rounded()),
            "playing_ms": Int(playingMs.rounded()),
            "rebuffer_count": rebufferCount,
            "rebuffer_ms": Int(rebufferMs.rounded()),
            "seek_count": seekCount,
            "seek_ms": Int(seekMs.rounded()),
            "playhead_ms": Int(playheadMs.rounded()),
            "avg_bitrate_kbps": whole(bitratePlayingMs > 0 ? bitrateMs / bitratePlayingMs : nil),
            "max_bitrate_kbps": whole(maxBitrateKbps),
            "rendition_changes": renditionChanges,
            "video_width": json(videoWidth),
            "video_height": json(videoHeight),
            "upscale_ms": Int(upscaleMs.rounded()),
            "downscale_ms": Int(downscaleMs.rounded()),
            "max_upscale_pct": maxUpscalePct,
            "dropped_frames": droppedFrames,
            "live_latency_ms": whole(liveLatencyMs),
            "ad_break_count": adBreakCount,
            "ad_count": adCount,
            "ad_watch_ms": Int(adWatchMs.rounded()),
            "ad_error_count": adErrorCount,
        ]
        return [
            "view_id": viewID,
            "seq": seq,
            "started_at": startedAt,
            "ended": ended,
            "video": [
                "id": json(video.id), "title": json(video.title), "series_id": json(video.seriesID),
                "series_title": json(video.seriesTitle), "duration_ms": json(video.durationMs),
                "stream_type": video.streamType, "source_type": json(video.sourceType), "source_host": json(video.sourceHost),
            ],
            "player": [
                "name": player.name, "version": json(player.version), "autoplay": player.autoplay,
                "width": json(playerWidth), "height": json(playerHeight),
            ],
            "metrics": metrics,
            "custom": Dictionary(uniqueKeysWithValues: video.custom.filter { !$0.value.isEmpty }.map { (String($0.key), $0.value) }),
            "error": json(error),
            "events": Array(events.prefix(maxEvents)),
        ]
    }

    /// The backend took the first `count` events.
    public func sent(_ count: Int) {
        events.removeFirst(min(count, events.count))
    }

    private func event(_ type: String, _ data: [String: Any]? = nil) {
        var entry: [String: Any] = ["t": Int((now() - t0).rounded()), "type": type]
        if let data { entry["data"] = data }
        events.append(entry)
    }

    private func move(_ next: State) {
        account()
        state = next
    }

    private func stopAdClock() {
        guard let started = adPlayingSince else { return }
        adWatchMs += now() - started
        adPlayingSince = nil
    }

    /// Adds the time since the last change to the totals of the state the view is in.
    private func account() {
        let current = now()
        let ms = max(0, current - since)
        since = current
        guard !ended, ms > 0 else { return }
        if [.starting, .playing, .rebuffering, .seeking].contains(state) { watchMs += ms }
        if state == .rebuffering { rebufferMs += ms }
        if state == .seeking { seekMs += ms }
        guard state == .playing else { return }
        playingMs += ms
        if let kbps {
            bitrateMs += kbps * ms
            bitratePlayingMs += ms
        }
        guard let vw = videoWidth, let vh = videoHeight, let pw = playerWidth, let ph = playerHeight, vw > 0, vh > 0 else { return }
        let scale = min(Double(pw) / Double(vw), Double(ph) / Double(vh))
        if scale > 1 {
            upscaleMs += ms
            maxUpscalePct = max(maxUpscalePct, ((scale - 1) * 1000).rounded() / 10)
        } else if scale < 1 {
            downscaleMs += ms
        }
    }
}

/// JSONSerialization takes NSNull, not nil.
func json(_ value: Any?) -> Any { value ?? NSNull() }

extension ISO8601DateFormatter {
    static let withFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

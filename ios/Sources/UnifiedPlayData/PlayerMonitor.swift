import Foundation

/// Takes ad events from an ad library (UnifiedPlayDataIMA) or from your own ad player. Every monitor is one.
@MainActor
public protocol AdTarget: AnyObject {
    /// The video gave way to ads (pre-, mid- or post-roll).
    func adBreakStart()
    /// An ad was asked to play.
    func adStart()
    /// The ad's frames are moving.
    func adPlaying()
    func adPause()
    func adEnd()
    /// An ad failed; the view goes on.
    func adError(code: String, message: String)
    /// The ads gave the video back.
    func adBreakEnd()
    /// An ad request went out (VAST/VMAP): before the first pre-roll, its time is pre-roll request time.
    func adRequest()
    /// The ad response came back and was read.
    func adResponse()
}

public extension AdTarget {
    func adRequest() {}
    func adResponse() {}
}

/// What every player monitor shares: a view starts when playback of a source is asked for (so a
/// preloaded video nobody plays is no view), a new source ends it, and player startup is measured
/// from the source to "ready" even before anyone plays. Player libraries subclass it.
@MainActor
open class PlayerMonitor: AdTarget {
    public let client: DataClient
    private let info: PlayerInfo
    public private(set) var view: ViewTracker?
    private var sourceAt: Double?
    private var readyAt: Double?
    private var width = 0
    private var height = 0
    // Requests before a view exists (the manifest, a preload) go into it when it starts.
    private enum RequestKind { case completed, failed, canceled }
    private var early: [(RequestKind, RequestInfo)] = []
    private var drmType = ""
    private var mode = "standard"
    private var captionsOn = false

    public init(client: DataClient, player: PlayerInfo) {
        self.client = client
        info = player
        client.setBeforeBeacon(self) { [weak self] in
            guard let self, let view = self.view else { return }
            self.beforeBeacon(view)
        }
    }

    /// What the current source is; nil while there is none.
    open func describe() -> VideoInfo? { nil }

    /// Whether the player starts by itself once ready.
    open func autoplay() -> Bool { false }

    /// Read the player's position, live latency… just before each beacon.
    open func beforeBeacon(_ view: ViewTracker) {}

    /// A new view began: give it what the player already knows (its rendition…).
    open func onNewView(_ view: ViewTracker) {}

    public static func now() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }

    /// The player got a new source: the open view is over.
    public func newSource(hasSource: Bool = true) {
        if let view, !view.ended {
            view.end()
            client.flush()
        }
        view = nil
        sourceAt = hasSource ? Self.now() : nil
        readyAt = nil
        early = []
        drmType = ""
    }

    /// The player could start: player startup is done.
    public func ready() {
        guard readyAt == nil else { return }
        let ready = Self.now()
        readyAt = ready
        if let sourceAt { view?.playerStartup(ready - sourceAt) }
    }

    /// The view for the current source; a new one when there is none yet or the last one ended.
    @discardableResult
    public func current() -> ViewTracker? {
        if let view, !view.ended { return view }
        guard let video = describe() else { return nil }
        var player = info
        player.autoplay = autoplay()
        let next = ViewTracker(video: video, player: player)
        view = next
        client.add(next)
        next.playerSize(width: width, height: height)
        if let sourceAt, let readyAt { next.playerStartup(readyAt - sourceAt) }
        if !drmType.isEmpty { next.setDrmType(drmType) }
        if mode != "standard" { next.playbackMode(mode) }
        if captionsOn { next.captions(true) }
        for (kind, request) in early { record(next, kind, request) }
        early = []
        onNewView(next)
        client.flush()
        return next
    }

    /// The player's size on screen in pixels.
    public func size(width: Int, height: Int) {
        self.width = width
        self.height = height
        view?.playerSize(width: width, height: height)
    }

    /// Content requests came back (the monitors report their player's loads by themselves).
    public func requestCompleted(_ request: RequestInfo) { report(.completed, request) }
    public func requestFailed(_ request: RequestInfo) { report(.failed, request) }
    public func requestCanceled(_ request: RequestInfo) { report(.canceled, request) }

    /// The DRM in use (widevine, playready, fairplay, clearkey).
    public func setDrmType(_ type: String) {
        drmType = type
        view?.setDrmType(type)
    }

    /// Captions turned on or off.
    public func captions(_ on: Bool) {
        captionsOn = captionsOn || on
        view?.captions(on)
    }

    /// Your own rule stopped playback (geo-block, paywall, too many streams): the view ends without failing.
    public func businessException(code: String, message: String = "") {
        current()?.failed(code: code, message: message, fatal: true, businessException: true)
        client.flush()
    }

    public func adRequest() { current()?.adRequest() }
    public func adResponse() { view?.adResponse() }

    /// The app's player went fullscreen ("fullscreen"), picture-in-picture ("pip") or back ("standard").
    public func playbackMode(_ next: String) {
        mode = next
        view?.playbackMode(next)
    }

    private func report(_ kind: RequestKind, _ request: RequestInfo) {
        if let view, !view.ended { record(view, kind, request) } else if early.count < 50 { early.append((kind, request)) }
    }

    private func record(_ view: ViewTracker, _ kind: RequestKind, _ request: RequestInfo) {
        switch kind {
        case .completed: view.requestCompleted(request)
        case .failed: view.requestFailed(request)
        case .canceled: view.requestCanceled(request)
        }
    }

    public func adBreakStart() {
        current()?.adBreakStart()
        client.flush()
    }

    public func adStart() { current()?.adStart() }
    public func adPlaying() { view?.adPlaying() }
    public func adPause() { view?.adPause() }
    public func adEnd() { view?.adEnd() }

    public func adError(code: String, message: String = "") {
        current()?.adError(code: code, message: message)
        client.flush()
    }

    public func adBreakEnd() {
        view?.adBreakEnd()
        client.flush()
    }

    /// Stop watching: ends the open view and sends it.
    open func release() {
        if let view { beforeBeacon(view) }
        view?.end()
        client.flush()
        client.setBeforeBeacon(self, nil)
        view = nil
    }
}

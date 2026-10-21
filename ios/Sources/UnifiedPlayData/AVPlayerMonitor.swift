import AVFoundation
import Foundation

/// Watches an AVPlayer. A view starts when playback of an item is asked for, so a preloaded item
/// nobody plays is no view; the next item ends it. The player's events drive it.
///
/// ```
/// AVPlayerMonitor.attach(client: dataClient, player: player) { item in
///     VideoInfo(id: episode.id, title: episode.title)
/// }
/// ```
/// The player keeps its monitor; replacing its item with nil ends the open view.
@MainActor
public final class AVPlayerMonitor: PlayerMonitor {
    private static var key = 0

    /// Watches `player` for as long as it lives (it holds the monitor). A second call replaces the first.
    @discardableResult
    public static func attach(client: DataClient, player: AVPlayer, layer: AVPlayerLayer? = nil,
                              describe: @escaping (AVPlayerItem) -> VideoInfo = { _ in VideoInfo() }) -> AVPlayerMonitor {
        (objc_getAssociatedObject(player, &key) as? AVPlayerMonitor)?.release()
        let monitor = AVPlayerMonitor(client: client, player: player, layer: layer, describe: describe)
        objc_setAssociatedObject(player, &key, monitor, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        return monitor
    }

    /// The monitor `attach` gave this player, e.g. to report its ads (it is an `AdTarget`).
    public static func monitor(for player: AVPlayer) -> AVPlayerMonitor? {
        objc_getAssociatedObject(player, &key) as? AVPlayerMonitor
    }

    private weak var player: AVPlayer?
    private weak var layer: AVPlayerLayer?
    private let describeItem: (AVPlayerItem) -> VideoInfo
    private var kbps: Double?
    private var playerObservations: [NSKeyValueObservation] = []
    private var itemObservations: [NSKeyValueObservation] = []
    private var itemTokens: [NSObjectProtocol] = []
    // The access log's totals already reported, per log entry (AVPlayer reports requests in batches).
    private var reported: [Int: (requests: Int, bytes: Int64, seconds: Double)] = [:]

    public init(client: DataClient, player: AVPlayer, layer: AVPlayerLayer? = nil,
                describe: @escaping (AVPlayerItem) -> VideoInfo = { _ in VideoInfo() }) {
        self.player = player
        self.layer = layer
        describeItem = describe
        super.init(client: client, player: PlayerInfo(name: "avplayer"))
        playerObservations = [
            player.observe(\.currentItem, options: [.initial, .new]) { [weak self] player, _ in
                Self.onMain { self?.itemChanged(player.currentItem) }
            },
            player.observe(\.rate, options: [.old, .new]) { [weak self] _, change in
                let started = (change.oldValue ?? 0) == 0 && (change.newValue ?? 0) != 0
                Self.onMain { if started { self?.current()?.play() } }
            },
            player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
                Self.onMain { self?.statusChanged(player) }
            },
        ]
        if player.rate != 0 { current()?.play() }
    }

    public override func describe() -> VideoInfo? { player?.currentItem.map(describeItem) }

    public override func autoplay() -> Bool { (player?.rate ?? 0) != 0 }

    public override func onNewView(_ view: ViewTracker) {
        guard let size = player?.currentItem?.presentationSize else { return }
        if kbps != nil || size.width > 0 {
            view.rendition(kbps: kbps, width: size.width > 0 ? Int(size.width) : nil, height: size.height > 0 ? Int(size.height) : nil)
        }
    }

    public override func beforeBeacon(_ view: ViewTracker) {
        if let layer { size(width: Int(layer.bounds.width * layer.contentsScale), height: Int(layer.bounds.height * layer.contentsScale)) }
        guard let player else { return }
        let seconds = player.currentTime().seconds
        if seconds.isFinite { view.playhead(seconds * 1000) }
        if let item = player.currentItem, item.duration.isIndefinite, let date = item.currentDate() {
            view.liveLatency(Date().timeIntervalSince(date) * 1000)
        }
    }

    /// Stop watching: ends the open view and sends it.
    public override func release() {
        playerObservations.forEach { $0.invalidate() }
        playerObservations = []
        stopItem()
        super.release()
    }

    /// KVO may call from any thread; the monitor lives on the main one.
    nonisolated private static func onMain(_ block: @escaping @MainActor () -> Void) {
        if Thread.isMainThread { MainActor.assumeIsolated(block) } else { DispatchQueue.main.async { MainActor.assumeIsolated(block) } }
    }

    private func itemChanged(_ item: AVPlayerItem?) {
        stopItem()
        kbps = nil
        reported = [:]
        newSource(hasSource: item != nil)
        guard let item else { return }
        // AVPlayer only plays FairPlay-protected content.
        let asset = item.asset
        Task { @MainActor [weak self] in
            if (try? await asset.load(.hasProtectedContent)) == true { self?.setDrmType("fairplay") }
        }
        if item.status == .readyToPlay { ready() }
        itemObservations = [
            item.observe(\.status, options: [.new]) { [weak self] item, _ in
                Self.onMain { self?.itemStatusChanged(item) }
            },
            item.observe(\.presentationSize, options: [.new]) { [weak self] item, _ in
                Self.onMain { self?.renditionChanged(item) }
            },
            item.observe(\.isPlaybackLikelyToKeepUp, options: [.new]) { [weak self] item, _ in
                Self.onMain { if item.isPlaybackLikelyToKeepUp { self?.view?.bufferingEnd() } }
            },
        ]
        let center = NotificationCenter.default
        func on(_ name: Notification.Name, _ handle: @escaping @MainActor (Notification) -> Void) {
            itemTokens.append(center.addObserver(forName: name, object: item, queue: .main) { note in
                MainActor.assumeIsolated { handle(note) }
            })
        }
        on(.AVPlayerItemPlaybackStalled) { [weak self] _ in self?.view?.bufferingStart() }
        on(.AVPlayerItemDidPlayToEndTime) { [weak self] _ in
            guard let self else { return }
            if let view { beforeBeacon(view) }
            view?.completed()
            client.flush()
        }
        on(.AVPlayerItemFailedToPlayToEndTime) { [weak self] note in
            let error = note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? NSError
            self?.fail(error)
        }
        on(.AVPlayerItemTimeJumped) { [weak self] _ in self?.jumped() }
        on(.AVPlayerItemNewAccessLogEntry) { [weak self] note in
            guard let self, let item = note.object as? AVPlayerItem, let log = item.accessLog() else { return }
            if let last = log.events.last, last.indicatedBitrate > 0 { kbps = last.indicatedBitrate / 1000 }
            renditionChanged(item)
            view?.droppedFrames(log.events.reduce(0) { $0 + max(0, $1.numberOfDroppedVideoFrames) })
            accessLog(log)
        }
        on(.AVPlayerItemNewErrorLogEntry) { [weak self] note in
            guard let event = (note.object as? AVPlayerItem)?.errorLog()?.events.last else { return }
            self?.requestFailed(RequestInfo(type: Self.requestType(event.uri), hostname: event.uri.flatMap { URL(string: $0)?.host },
                                            error: event.errorDomain, errorCode: event.errorStatusCode, errorText: event.errorComment))
            self?.view?.failed(code: String(event.errorStatusCode), message: event.errorComment ?? "", fatal: false)
        }
    }

    /// Network requests (spec: Requests) from the access log: its media requests, bytes and transfer time
    /// since the last entry. AVPlayer reports no response headers and no time to first byte.
    private func accessLog(_ log: AVPlayerItemAccessLog) {
        for (index, event) in log.events.enumerated() {
            let before = reported[index] ?? (0, 0, 0)
            let requests = max(0, event.numberOfMediaRequests - before.requests)
            let bytes = max(0, event.numberOfBytesTransferred - before.bytes)
            let seconds = max(0, event.transferDuration - before.seconds)
            reported[index] = (max(before.requests, event.numberOfMediaRequests), max(before.bytes, event.numberOfBytesTransferred),
                               max(before.seconds, event.transferDuration))
            guard requests > 0 else { continue }
            requestCompleted(RequestInfo(type: "media", hostname: event.uri.flatMap { URL(string: $0)?.host }, start: 0,
                                         responseEnd: seconds * 1000, bytes: Int(bytes), count: requests))
        }
    }

    nonisolated private static func requestType(_ uri: String?) -> String {
        let path = (uri.flatMap { URL(string: $0)?.path } ?? "").lowercased()
        if path.hasSuffix(".m3u8") { return "manifest" }
        if uri?.lowercased().hasPrefix("skd://") == true { return "encryption" }
        return "media"
    }

    private func stopItem() {
        itemObservations.forEach { $0.invalidate() }
        itemObservations = []
        itemTokens.forEach { NotificationCenter.default.removeObserver($0) }
        itemTokens = []
    }

    private func itemStatusChanged(_ item: AVPlayerItem) {
        switch item.status {
        case .readyToPlay: ready()
        case .failed: fail(item.error as NSError?)
        default: break
        }
    }

    private func fail(_ error: NSError?) {
        // An item that fails while someone wants it played is a failed view; a preloaded one is nobody's.
        guard let tracker = view ?? ((player?.rate ?? 0) != 0 ? current() : nil) else { return }
        tracker.failed(code: error.map { "\($0.domain) \($0.code)" } ?? "unknown", message: error?.localizedDescription ?? "")
        client.flush()
    }

    private func statusChanged(_ player: AVPlayer) {
        guard let view else { return }
        switch player.timeControlStatus {
        case .playing:
            let first = view.videoStartupMs == nil
            view.playing()
            if first { client.flush() }
        case .waitingToPlayAtSpecifiedRate:
            if player.reasonForWaitingToPlay == .toMinimizeStalls { view.bufferingStart() }
        case .paused:
            if player.currentItem.map({ $0.currentTime() < $0.duration }) ?? true {
                view.pause()
                client.flush()
            }
        @unknown default:
            break
        }
    }

    private func jumped() {
        guard let view, let player else { return }
        view.seeking()
        // A jump inside the buffer never stops playback: then the seek is over at once.
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                if player.timeControlStatus == .playing { view.playing() } else if player.rate == 0 { view.seeked(paused: true) }
            }
        }
    }

    private func renditionChanged(_ item: AVPlayerItem) {
        let size = item.presentationSize
        view?.rendition(kbps: kbps, width: size.width > 0 ? Int(size.width) : nil, height: size.height > 0 ? Int(size.height) : nil)
    }
}

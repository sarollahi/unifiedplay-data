import AVFoundation
import XCTest
@testable import UnifiedPlayData

final class ViewTrackerTests: XCTestCase {
    private var time = 0.0
    private func tracker() -> ViewTracker { ViewTracker(video: VideoInfo(id: "ep_1"), player: PlayerInfo(name: "test")) { [unowned self] in time } }
    private func metrics(_ snapshot: [String: Any]) -> [String: Any] { snapshot["metrics"] as! [String: Any] }
    private func types(_ snapshot: [String: Any]) -> [String] { (snapshot["events"] as! [[String: Any]]).map { $0["type"] as! String } }

    func testCountsShiftsAndKeepsTheFirstRenditionCodecsEdgeAndRemotePlay() {
        let view = ViewTracker(video: VideoInfo(id: "ep_1", brand: "Drama+", creatorID: "studio-9"),
                               player: PlayerInfo(name: "main", software: "AVPlayer", language: "sv")) { [unowned self] in time }
        view.rendition(kbps: 1500, width: 1280, height: 720, details: RenditionDetails(videoCodec: "hvc1"))
        view.play(); time += 500; view.playing()
        view.rendition(kbps: 3000, width: 1920, height: 1080, details: RenditionDetails(framerate: 25, dynamicRange: "HDR"))
        view.rendition(kbps: 800, width: 960, height: 540)
        view.requestCompleted(RequestInfo(type: "video", headers: ["X-Served-By": "cache-arn1234-ARN"]))
        view.playbackMode("remote")
        let snapshot = view.snapshot()
        XCTAssertEqual(metrics(snapshot)["rendition_upshifts"] as? Int, 1)
        XCTAssertEqual(metrics(snapshot)["rendition_downshifts"] as? Int, 1)
        let rendition = snapshot["rendition"] as! [String: Any]
        XCTAssertEqual(rendition["video_codec"] as? String, "hvc1")
        XCTAssertEqual(rendition["dynamic_range"] as? String, "HDR")
        XCTAssertEqual(rendition["initial_bitrate_kbps"] as? Int, 1500)
        XCTAssertEqual(rendition["initial_height"] as? Int, 720)
        let video = snapshot["video"] as! [String: Any]
        XCTAssertEqual(video["brand"] as? String, "Drama+")
        XCTAssertEqual(video["cdn_edge_pop"] as? String, "ARN")
        let player = snapshot["player"] as! [String: Any]
        XCTAssertEqual(player["software"] as? String, "AVPlayer")
        XCTAssertEqual(player["remote_played"] as? Bool, true)
    }

    func testSplitsTimeIntoStartupPlayingRebufferingAndSeeking() {
        let view = tracker()
        view.playerStartup(100)
        view.play(); time += 800; view.playing()
        time += 5000; view.bufferingStart(); time += 1200; view.bufferingEnd()
        time += 3000; view.seeking(); time += 400; view.seeked(paused: false); time += 100; view.playing()
        time += 2000; view.pause(); time += 10_000
        let snapshot = view.snapshot()
        let m = metrics(snapshot)
        XCTAssertEqual(m["player_startup_ms"] as? Int, 100)
        XCTAssertEqual(m["video_startup_ms"] as? Int, 800)
        XCTAssertEqual(m["rebuffer_count"] as? Int, 1)
        XCTAssertEqual(m["rebuffer_ms"] as? Int, 1200)
        XCTAssertEqual(m["seek_count"] as? Int, 1)
        XCTAssertEqual(m["seek_ms"] as? Int, 500)
        XCTAssertEqual(m["playing_ms"] as? Int, 10_000)
        XCTAssertEqual(m["watch_ms"] as? Int, 800 + 10_000 + 1200 + 500)
        XCTAssertEqual(types(snapshot), ["viewstart", "play", "playing", "rebufferstart", "rebufferend", "playing", "seeking", "seeked", "playing", "pause"])
    }

    func testTimesPreRollRequestsLoadingAndStartupAfterThePlayRequest() {
        let view = ViewTracker(video: VideoInfo(id: "v", contentType: "episode", experimentName: "ladder-b", custom: [10: "tenth"]),
                               player: PlayerInfo(name: "test")) { [unowned self] in time }
        view.adRequest()
        time += 300; view.play()
        time += 200; view.adResponse()
        time += 100; view.adRequest(); time += 150; view.adResponse()
        time += 50; view.adBreakStart(); view.adStart()
        time += 400; view.adPlaying()
        time += 10_000; view.adEnd(); view.adBreakEnd()
        time += 700; view.playing()
        let snapshot = view.snapshot()
        let m = metrics(snapshot)
        XCTAssertEqual(m["preroll_requests"] as? Int, 2)
        XCTAssertEqual(m["preroll_request_ms"] as? Int, 350)
        XCTAssertEqual(m["ad_startup_ms"] as? Int, 400)
        XCTAssertEqual(m["preroll_load_ms"] as? Int, 450)
        XCTAssertEqual(m["video_startup_ms"] as? Int, 900)
        XCTAssertEqual(m["content_startup_ms"] as? Int, 1200)
        XCTAssertEqual(snapshot["experiment_name"] as? String, "ladder-b")
        XCTAssertEqual((snapshot["video"] as! [String: Any])["content_type"] as? String, "episode")
        XCTAssertEqual(snapshot["custom"] as? [String: String], ["10": "tenth"])
    }

    func testWeighsScalingAmountsByTimeAndKeepsBusinessExceptionsApart() {
        let view = tracker()
        view.playerSize(width: 1280, height: 720)
        view.rendition(kbps: 800, width: 640, height: 360)
        view.play(); view.playing()
        time += 1000
        view.rendition(kbps: 4000, width: 2560, height: 1440)
        time += 3000
        view.captions(true)
        view.failed(code: "geo", message: "Not in your country", fatal: true, businessException: true)
        let snapshot = view.snapshot()
        let m = metrics(snapshot)
        XCTAssertEqual(m["upscale_pct_ms"] as? Int, 100_000)
        XCTAssertEqual(m["downscale_pct_ms"] as? Int, 300_000)
        XCTAssertEqual(m["max_downscale_pct"] as? Double, 100)
        XCTAssertEqual((snapshot["error"] as! [String: Any])["business_exception"] as? Bool, true)
        XCTAssertEqual((snapshot["player"] as! [String: Any])["captions"] as? Bool, true)
    }

    func testAddsUpRequestsCountsFailuresByTypeAndNamesTheCDN() {
        let view = ViewTracker(video: VideoInfo(id: "ep_1", viewSessionID: "cmcd-1"), player: PlayerInfo(name: "test")) { [unowned self] in time }
        view.requestCompleted(RequestInfo(type: "manifest", start: 0, responseStart: 50, responseEnd: 80, bytes: 2_000, headers: ["X-CDN": "fastly"]))
        view.requestCompleted(RequestInfo(type: "video", start: 100, responseStart: 140, responseEnd: 1100, bytes: 1_250_000))
        view.requestCompleted(RequestInfo(type: "audio", start: 100, responseStart: 160, responseEnd: 600, bytes: 125_000, headers: ["x-cdn": "cloudflare"]))
        view.requestCompleted(RequestInfo(type: "video_init", start: 0, responseEnd: 10, bytes: 900))
        view.requestCompleted(RequestInfo(type: "media", start: 0, responseEnd: 2000, bytes: 500_000, count: 4)) // an access log batch
        view.requestFailed(RequestInfo(type: "video", hostname: "cdn.example.com", error: "CoreMediaErrorDomain", errorCode: 503))
        view.requestFailed(RequestInfo(type: "encryption", errorCode: 403))
        view.requestCanceled(RequestInfo(type: "audio"))
        view.playbackMode("pip"); view.playbackMode("pip"); view.playbackMode("standard")
        view.setDrmType("fairplay")
        let snapshot = view.snapshot()
        let m = metrics(snapshot)
        XCTAssertEqual(m["request_completed"] as? Int, 8)
        XCTAssertEqual(m["request_failed"] as? Int, 2)
        XCTAssertEqual(m["request_canceled"] as? Int, 1)
        XCTAssertEqual(m["request_failed_media"] as? Int, 1)
        XCTAssertEqual(m["request_failed_encryption"] as? Int, 1)
        XCTAssertEqual(m["request_media_completed"] as? Int, 6)
        XCTAssertEqual(m["request_media_bytes"] as? Int, 1_875_000)
        XCTAssertEqual(m["request_media_ms"] as? Int, 3500)
        XCTAssertEqual(m["request_media_ttfb_ms"] as? Int, 100)
        XCTAssertEqual(m["request_media_ttfb_count"] as? Int, 2)
        XCTAssertEqual(m["request_media_max_ttfb_ms"] as? Int, 60)
        let video = snapshot["video"] as! [String: Any]
        XCTAssertEqual(video["cdn"] as? String, "cloudflare")
        XCTAssertEqual(video["drm_type"] as? String, "fairplay")
        let player = snapshot["player"] as! [String: Any]
        XCTAssertEqual(player["pip"] as? Bool, true)
        XCTAssertEqual(player["fullscreen"] as? Bool, false)
        XCTAssertEqual(snapshot["view_session_id"] as? String, "cmcd-1")
        XCTAssertEqual(types(snapshot).filter { $0 == "cdnchange" }.count, 2)
        XCTAssertEqual(types(snapshot).filter { $0 == "playbackmodechange" }.count, 2)
        XCTAssertEqual(drmTypeOf("com.apple.streamingkeydelivery"), "fairplay")
    }

    @MainActor
    func testSendsToTheBeaconDomain() {
        XCTAssertEqual(DataClient.base(DataConfig(key: "k", beaconDomain: "https://data.example.com/x")).absoluteString, "https://data.example.com")
        XCTAssertEqual(DataClient.base(DataConfig(key: "k")).absoluteString, defaultAPIBase.absoluteString)
    }

    func testCountsAStallBeforeTheFirstFrameAsStartup() {
        let view = tracker()
        view.play(); view.seeking(); view.bufferingStart(); time += 2000; view.playing()
        let m = metrics(view.snapshot())
        XCTAssertEqual(m["video_startup_ms"] as? Int, 2000)
        XCTAssertEqual(m["rebuffer_count"] as? Int, 0)
        XCTAssertEqual(m["seek_count"] as? Int, 0)
    }

    func testWeightsBitrateByPlayingTimeAndMeasuresUpscaling() {
        let view = tracker()
        view.playerSize(width: 1080, height: 1920)
        view.rendition(kbps: 1000, width: 540, height: 960)
        view.play(); view.playing()
        time += 3000; view.rendition(kbps: 4000, width: 1080, height: 1920); time += 1000
        let m = metrics(view.snapshot())
        XCTAssertEqual(m["avg_bitrate_kbps"] as? Int, 1750)
        XCTAssertEqual(m["max_bitrate_kbps"] as? Int, 4000)
        XCTAssertEqual(m["upscale_ms"] as? Int, 3000)
        XCTAssertEqual(m["max_upscale_pct"] as? Double, 100)
        XCTAssertEqual(m["rendition_changes"] as? Int, 1)
    }

    func testKeepsAdTimeOutOfTheVideoAndAPreRollOutOfStartup() throws {
        let view = ViewTracker(video: VideoInfo(custom: [1: "experiment-b"]), player: PlayerInfo(name: "test")) { [unowned self] in time }
        view.adBreakStart(); view.adStart(); view.adPlaying()
        time += 15_000; view.adEnd(); view.adStart(); view.adError(code: "1009", message: "VAST empty"); view.adBreakEnd()
        time += 500; view.playing()
        time += 10_000; view.adBreakStart(); view.playing(); view.bufferingStart(); view.adStart(); view.adPlaying()
        time += 5_000; view.adEnd(); view.adBreakEnd(); time += 100; view.playing(); time += 1_000
        let snapshot = view.snapshot()
        let m = metrics(snapshot)
        XCTAssertEqual(m["video_startup_ms"] as? Int, 0) // ends at the pre-roll's first frame
        XCTAssertEqual(m["content_startup_ms"] as? Int, 500)
        XCTAssertEqual(m["ad_break_count"] as? Int, 2)
        XCTAssertEqual(m["ad_count"] as? Int, 3)
        XCTAssertEqual(m["ad_error_count"] as? Int, 1)
        XCTAssertEqual(m["ad_watch_ms"] as? Int, 20_000)
        XCTAssertEqual(m["playing_ms"] as? Int, 11_000)
        XCTAssertEqual(m["watch_ms"] as? Int, 11_500)
        XCTAssertEqual(m["rebuffer_count"] as? Int, 0)
        XCTAssertEqual(snapshot["custom"] as? [String: String], ["1": "experiment-b"])
        XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: snapshot))
    }

    func testEndsOnAFatalErrorAndKeepsUnsentEvents() throws {
        let view = tracker()
        view.play()
        view.failed(code: "AVFoundationErrorDomain -11800", message: "The operation could not be completed")
        let first = view.snapshot()
        XCTAssertEqual(first["ended"] as? Bool, true)
        XCTAssertEqual((first["error"] as? [String: Any])?["code"] as? String, "AVFoundationErrorDomain -11800")
        XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: first))
        view.sent(2)
        XCTAssertEqual(types(view.snapshot()), ["error", "viewend"])
    }
}

@MainActor
final class DataClientTests: XCTestCase {
    private final class Recorder: @unchecked Sendable {
        var requests: [URLRequest] = []
        var answers: [BeaconResponse] = []
    }

    private func client(_ recorder: Recorder) -> DataClient {
        DataClient(
            config: DataConfig(key: "key-1", apiBase: URL(string: "https://api.example.test")!, userID: "usr_1"),
            device: ["os": "iOS", "connection": "wifi"], deviceID: "device-1",
            send: { request, done in
                recorder.requests.append(request)
                done(recorder.answers.isEmpty ? BeaconResponse(status: 202, enabled: true) : recorder.answers.removeFirst())
            }
        )
    }

    private func body(_ request: URLRequest) -> [String: Any] {
        try! JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
    }

    private func settle() async {
        // Results come back through the main queue.
        await withCheckedContinuation { continuation in DispatchQueue.main.async { continuation.resume() } }
    }

    func testSendsOpenViewsAndDropsSentEvents() async {
        let recorder = Recorder()
        let client = client(recorder)
        client.add(ViewTracker(video: VideoInfo(id: "ep_1"), player: PlayerInfo(name: "test")))
        client.flush()
        await settle()
        let request = recorder.requests[0]
        XCTAssertEqual(request.url?.absoluteString, "https://api.example.test/api/v1/data/beacons")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Tenant-Key"), "key-1")
        let beacon = body(request)
        XCTAssertEqual((beacon["viewer"] as? [String: Any])?["user_id"] as? String, "usr_1")
        XCTAssertEqual(((beacon["views"] as? [[String: Any]])?[0]["events"] as? [Any])?.count, 1)
        client.flush()
        await settle()
        XCTAssertEqual(((body(recorder.requests[1])["views"] as? [[String: Any]])?[0]["events"] as? [Any])?.count, 0)
    }

    func testSends25EventsOfAViewPerBeaconAndDropsABeaconTooBigForTheBackend() async {
        let recorder = Recorder()
        recorder.answers = [BeaconResponse(status: 202, enabled: true), BeaconResponse(status: 202, enabled: true), BeaconResponse(status: 413), BeaconResponse(status: 202, enabled: true)]
        let client = client(recorder)
        let view = ViewTracker(video: VideoInfo(), player: PlayerInfo(name: "test"))
        for _ in 0..<15 { view.play(); view.playing(); view.pause() }
        client.add(view)
        client.flush(); await settle()
        client.flush(); await settle()
        let counts = recorder.requests.map { ((body($0)["views"] as? [[String: Any]])?[0]["events"] as? [Any])?.count ?? -1 }
        XCTAssertEqual(counts, [25, 21])
        view.pause(); view.play()
        client.flush(); await settle()
        client.flush(); await settle()
        XCTAssertEqual(((body(recorder.requests[3])["views"] as? [[String: Any]])?[0]["events"] as? [Any])?.count, 0)
    }

    func testKeepsEventsThroughServerErrorsAndStopsWhenVideoDataIsOff() async {
        let recorder = Recorder()
        recorder.answers = [BeaconResponse(status: 503), BeaconResponse(status: 200, enabled: false)]
        let client = client(recorder)
        client.add(ViewTracker(video: VideoInfo(), player: PlayerInfo(name: "test")))
        client.flush(); await settle()
        client.flush(); await settle()
        XCTAssertEqual(((body(recorder.requests[1])["views"] as? [[String: Any]])?[0]["events"] as? [Any])?.count, 1)
        XCTAssertTrue(client.disabled)
        client.flush(); await settle()
        XCTAssertEqual(recorder.requests.count, 2)
    }
}

@MainActor
final class AVPlayerMonitorTests: XCTestCase {
    /// A 32×32 Motion JPEG movie at 30 fps: no hardware encoder or audio device needed.
    private func movie(frames: Int = 60) async throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).mov")
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.jpeg, AVVideoWidthKey: 32, AVVideoHeightKey: 32])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 32, kCVPixelBufferHeightKey as String: 32,
        ])
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)
        for frame in 0..<frames {
            while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 1_000_000) }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, try XCTUnwrap(adaptor.pixelBufferPool), &buffer)
            adaptor.append(try XCTUnwrap(buffer), withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: 30))
        }
        input.markAsFinished()
        await writer.finishWriting()
        return url
    }

    func testVideoStartupWaitsForTheLayersFirstFrameNotAPrerolledItemsPlaying() async throws {
        let player = AVPlayer(playerItem: AVPlayerItem(url: try await movie()))
        while player.status != .readyToPlay || player.currentItem?.status != .readyToPlay { try await Task.sleep(nanoseconds: 10_000_000) }
        let prerolled = await player.preroll(atRate: 1)
        XCTAssertTrue(prerolled)
        // The reel comes on screen: a new layer with no frame yet, and play on the same tick.
        let layer = AVPlayerLayer(player: player)
        let client = DataClient(config: DataConfig(key: "k"), device: [:], deviceID: "d") { _, done in done(BeaconResponse(status: 202, enabled: true)) }
        let monitor = AVPlayerMonitor(client: client, player: player, layer: layer) { _ in VideoInfo(id: "reel") }
        player.play()
        let asked = Date()
        while monitor.view?.videoStartupMs == nil, Date().timeIntervalSince(asked) < 5 { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertTrue(layer.isReadyForDisplay)
        XCTAssertGreaterThan(try XCTUnwrap(monitor.view?.videoStartupMs), 0)
        monitor.release()
    }

    func testStartsAViewForEachItemAQueuePlayerMovesOnTo() async throws {
        let first = AVPlayerItem(url: try await movie(frames: 9)), second = AVPlayerItem(url: try await movie(frames: 9))
        let player = AVQueuePlayer(items: [first, second])
        let client = DataClient(config: DataConfig(key: "k"), device: [:], deviceID: "d") { _, done in done(BeaconResponse(status: 202, enabled: true)) }
        let monitor = AVPlayerMonitor(client: client, player: player) { item in VideoInfo(id: item === first ? "first" : "second") }
        player.play()
        let asked = Date()
        while monitor.view?.video.id != "second" || monitor.view?.videoStartupMs == nil, Date().timeIntervalSince(asked) < 5 {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertEqual(monitor.view?.video.id, "second")
        XCTAssertNotNil(monitor.view?.videoStartupMs)
        monitor.release()
    }

    func testPairsTheBitrateWithTheVariantOnScreenNotTheOneDownloading() {
        let ladder = [(width: 480, height: 270, kbps: 800.0), (1280, 720, 3000), (1280, 720, 4500), (1920, 1080, 8178)]
        // Switching up: the access log already names 8178 while 270p is still shown.
        XCTAssertEqual(AVPlayerMonitor.declaredKbps(ladder, width: 480, height: 270, indicated: 8178), 800)
        XCTAssertEqual(AVPlayerMonitor.declaredKbps(ladder, width: 1920, height: 1080, indicated: nil), 8178)
        XCTAssertEqual(AVPlayerMonitor.declaredKbps(ladder, width: 1280, height: 720, indicated: 4500), 4500)
        XCTAssertNil(AVPlayerMonitor.declaredKbps(ladder, width: 1280, height: 720, indicated: 8178))
        XCTAssertNil(AVPlayerMonitor.declaredKbps([], width: 640, height: 360, indicated: 1200))
    }
}

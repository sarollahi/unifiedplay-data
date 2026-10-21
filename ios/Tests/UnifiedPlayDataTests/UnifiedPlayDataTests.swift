import XCTest
@testable import UnifiedPlayData

final class ViewTrackerTests: XCTestCase {
    private var time = 0.0
    private func tracker() -> ViewTracker { ViewTracker(video: VideoInfo(id: "ep_1"), player: PlayerInfo(name: "test")) { [unowned self] in time } }
    private func metrics(_ snapshot: [String: Any]) -> [String: Any] { snapshot["metrics"] as! [String: Any] }
    private func types(_ snapshot: [String: Any]) -> [String] { (snapshot["events"] as! [[String: Any]]).map { $0["type"] as! String } }

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
        XCTAssertEqual(m["video_startup_ms"] as? Int, 500)
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

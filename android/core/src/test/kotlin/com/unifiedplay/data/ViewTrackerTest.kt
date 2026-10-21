package com.unifiedplay.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.Executor

class ViewTrackerTest {
    private var time = 0L
    private fun advance(ms: Long) { time += ms }
    private fun tracker() = ViewTracker(VideoInfo(id = "ep_1"), PlayerInfo("test")) { time }

    @Suppress("UNCHECKED_CAST")
    private fun Map<String, Any?>.metrics() = this["metrics"] as Map<String, Any?>

    @Suppress("UNCHECKED_CAST")
    private fun Map<String, Any?>.eventTypes() = (this["events"] as List<Map<String, Any?>>).map { it["type"] }

    @Test
    fun splitsTimeIntoStartupPlayingRebufferingAndSeeking() {
        val view = tracker()
        view.playerStartup(100)
        view.play(); advance(800); view.playing()
        advance(5000); view.bufferingStart(); advance(1200); view.bufferingEnd()
        advance(3000); view.seeking(); advance(400); view.seeked(false); advance(100); view.playing()
        advance(2000); view.pause(); advance(10_000)
        val snapshot = view.snapshot()
        val metrics = snapshot.metrics()
        assertEquals(100L, metrics["player_startup_ms"])
        assertEquals(800L, metrics["video_startup_ms"])
        assertEquals(1, metrics["rebuffer_count"])
        assertEquals(1200L, metrics["rebuffer_ms"])
        assertEquals(1, metrics["seek_count"])
        assertEquals(500L, metrics["seek_ms"])
        assertEquals(10_000L, metrics["playing_ms"])
        assertEquals(800L + 10_000 + 1200 + 500, metrics["watch_ms"])
        assertEquals(
            listOf("viewstart", "play", "playing", "rebufferstart", "rebufferend", "playing", "seeking", "seeked", "playing", "pause"),
            snapshot.eventTypes(),
        )
    }

    @Test
    fun countsAStallBeforeTheFirstFrameAsStartup() {
        val view = tracker()
        view.play(); view.seeking(); view.bufferingStart(); advance(2000); view.playing()
        val metrics = view.snapshot().metrics()
        assertEquals(2000L, metrics["video_startup_ms"])
        assertEquals(0, metrics["rebuffer_count"])
        assertEquals(0, metrics["seek_count"])
    }

    @Test
    fun weightsBitrateByPlayingTimeAndMeasuresUpscaling() {
        val view = tracker()
        view.playerSize(1080, 1920)
        view.rendition(1000.0, 540, 960)
        view.play(); view.playing()
        advance(3000); view.rendition(4000.0, 1080, 1920); advance(1000)
        val metrics = view.snapshot().metrics()
        assertEquals(1750L, metrics["avg_bitrate_kbps"])
        assertEquals(4000L, metrics["max_bitrate_kbps"])
        assertEquals(3000L, metrics["upscale_ms"])
        assertEquals(100.0, metrics["max_upscale_pct"])
        assertEquals(1, metrics["rendition_changes"])
    }

    @Test
    fun keepsAdTimeOutOfTheVideoAndAPreRollOutOfStartup() {
        val view = ViewTracker(VideoInfo(custom = mapOf(1 to "experiment-b")), PlayerInfo("test")) { time }
        view.adBreakStart(); view.adStart(); view.adPlaying()
        advance(15_000); view.adEnd(); view.adStart(); view.adError("1009", "VAST empty"); view.adBreakEnd()
        advance(500); view.playing()
        advance(10_000); view.adBreakStart(); view.playing(); view.bufferingStart(); view.adStart(); view.adPlaying()
        advance(5_000); view.adEnd(); view.adBreakEnd(); advance(100); view.playing(); advance(1_000)
        val snapshot = view.snapshot()
        val metrics = snapshot.metrics()
        assertEquals(500L, metrics["video_startup_ms"])
        assertEquals(2, metrics["ad_break_count"])
        assertEquals(3, metrics["ad_count"])
        assertEquals(1, metrics["ad_error_count"])
        assertEquals(20_000L, metrics["ad_watch_ms"])
        assertEquals(11_000L, metrics["playing_ms"])
        assertEquals(11_500L, metrics["watch_ms"])
        assertEquals(0, metrics["rebuffer_count"])
        assertEquals(mapOf("1" to "experiment-b"), snapshot["custom"])
    }

    @Test
    fun endsOnAFatalErrorAndKeepsUnsentEvents() {
        val view = tracker()
        view.play()
        view.failed("ERROR_CODE_IO_BAD_HTTP_STATUS", "404")
        val first = view.snapshot()
        assertEquals(true, first["ended"])
        assertEquals("ERROR_CODE_IO_BAD_HTTP_STATUS", (first["error"] as Map<*, *>)["code"])
        view.sent(2)
        assertEquals(listOf("error", "viewend"), view.snapshot().eventTypes())
    }
}

class DataClientTest {
    private val inline = Executor { it.run() }
    private val bodies = mutableListOf<String>()
    private val scheduled = mutableListOf<() -> Unit>()

    private fun client(vararg answers: BeaconResponse): DataClient {
        val queue = ArrayDeque(answers.toList())
        return DataClient(
            DataConfig(key = "key-1", apiBase = "https://api.example.test/", userId = "usr_1"),
            mapOf("os" to "Android"), "device-1",
            { url, key, body ->
                assertEquals("https://api.example.test/api/v1/data/beacons", url)
                assertEquals("key-1", key)
                bodies += body
                queue.removeFirstOrNull() ?: BeaconResponse(202, true)
            },
            { delay, block -> if (delay == 0L) block() else scheduled += block },
            inline,
        )
    }

    @Test
    fun sendsOpenViewsAndDropsSentEvents() {
        val client = client()
        val view = ViewTracker(VideoInfo(id = "ep_1"), PlayerInfo("test"))
        client.add(view)
        client.flush()
        val beacon = org.json.JSONObject(bodies[0])
        assertEquals("usr_1", beacon.getJSONObject("viewer").getString("user_id"))
        assertEquals("ep_1", beacon.getJSONArray("views").getJSONObject(0).getJSONObject("video").getString("id"))
        assertEquals(1, beacon.getJSONArray("views").getJSONObject(0).getJSONArray("events").length())
        client.flush()
        assertEquals(0, org.json.JSONObject(bodies[1]).getJSONArray("views").getJSONObject(0).getJSONArray("events").length())
        assertEquals(1, scheduled.size) // the 10 s tick
    }

    @Test
    fun sends25EventsOfAViewPerBeaconAndDropsABeaconTooBigForTheBackend() {
        val client = client(BeaconResponse(202, true), BeaconResponse(202, true), BeaconResponse(413), BeaconResponse(202, true))
        val view = ViewTracker(VideoInfo(), PlayerInfo("test"))
        repeat(15) { view.play(); view.playing(); view.pause() }
        client.add(view)
        client.flush(); client.flush()
        val counts = bodies.map { org.json.JSONObject(it).getJSONArray("views").getJSONObject(0).getJSONArray("events").length() }
        assertEquals(listOf(25, 21), counts)
        view.pause(); view.play()
        client.flush(); client.flush()
        assertEquals(0, org.json.JSONObject(bodies[3]).getJSONArray("views").getJSONObject(0).getJSONArray("events").length())
    }

    @Test
    fun keepsEventsThroughServerErrorsAndStopsWhenVideoDataIsOff() {
        val client = client(BeaconResponse(503), BeaconResponse(200, enabled = false))
        client.add(ViewTracker(VideoInfo(), PlayerInfo("test")))
        client.flush()
        client.flush()
        assertEquals(1, org.json.JSONObject(bodies[1]).getJSONArray("views").getJSONObject(0).getJSONArray("events").length())
        assertTrue(client.disabled)
        client.flush()
        assertEquals(2, bodies.size)
    }
}

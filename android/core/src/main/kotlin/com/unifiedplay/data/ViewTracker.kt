package com.unifiedplay.data

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

/** What one view plays. */
data class VideoInfo(
    val id: String? = null,
    val title: String? = null,
    val seriesId: String? = null,
    val seriesTitle: String? = null,
    val durationMs: Long? = null,
    val streamType: String = "on-demand",
    val sourceType: String? = null,
    val sourceHost: String? = null,
    /** Up to five of your own dimensions (1..5: an experiment, a page type…); the Console breaks views down by them. */
    val custom: Map<Int, String> = emptyMap(),
)

data class PlayerInfo(val name: String, val version: String? = null, val autoplay: Boolean = false)

/**
 * One view: what happened since playback of one video was asked for, and the totals the beacon
 * carries (spec/beacon.md). The web (tracker.ts) and iOS (ViewTracker.swift) SDKs do the same.
 * Not thread-safe: the SDK calls it on the main thread only.
 */
class ViewTracker(
    val video: VideoInfo,
    val player: PlayerInfo,
    private val now: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    private enum class State { IDLE, STARTING, PLAYING, PAUSED, REBUFFERING, SEEKING, AD, ENDED }

    val viewId: String = UUID.randomUUID().toString()
    // java.time needs API 26; the SDK runs from 24.
    private val startedAt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
    private val t0 = now()
    private var since = t0
    private var seq = 0
    private var state = State.IDLE
    private var playRequestedAt: Long? = null
    private var firstFrame = false
    private val events = mutableListOf<Map<String, Any?>>()
    private var error: Map<String, Any?>? = null
    private var kbps: Double? = null
    private var bitrateMs = 0.0
    private var bitratePlayingMs = 0L
    private var videoWidth: Int? = null
    private var videoHeight: Int? = null
    private var playerWidth: Int? = null
    private var playerHeight: Int? = null
    // Ads: the state to go back to, when the break began, ad time before the first frame, and the running ad clock.
    private var beforeAd = State.IDLE
    private var adBreakAt = 0L
    private var startupAdMs = 0L
    private var adPlayingSince: Long? = null
    var ended = false
        private set

    private var playerStartupMs: Long? = null
    var videoStartupMs: Long? = null
        private set
    private var watchMs = 0L
    private var playingMs = 0L
    private var rebufferCount = 0
    private var rebufferMs = 0L
    private var seekCount = 0
    private var seekMs = 0L
    private var playheadMs = 0L
    private var maxBitrateKbps: Long? = null
    private var renditionChanges = 0
    private var upscaleMs = 0L
    private var downscaleMs = 0L
    private var maxUpscalePct = 0.0
    private var droppedFrames = 0L
    private var liveLatencyMs: Long? = null
    private var adBreakCount = 0
    private var adCount = 0
    private var adWatchMs = 0L
    private var adErrorCount = 0

    init {
        event("viewstart")
    }

    /** How long the player took from getting the source to being able to start (the monitor measures it). */
    fun playerStartup(ms: Long) {
        if (playerStartupMs == null) playerStartupMs = max(0, ms)
    }

    /** Playback was asked for (play pressed, autoplay, playWhenReady). */
    fun play() {
        if (ended || state == State.AD) return
        event("play")
        if (!firstFrame) {
            if (playRequestedAt == null) playRequestedAt = now()
            move(State.STARTING)
        }
    }

    /** Frames of the video are moving: first frame, after a stall, after a seek, after a pause. */
    fun playing() {
        if (ended || state == State.AD) return
        if (!firstFrame) {
            firstFrame = true
            videoStartupMs = now() - (playRequestedAt ?: t0) - startupAdMs
        }
        if (state == State.REBUFFERING) event("rebufferend")
        if (state != State.PLAYING) event("playing")
        move(State.PLAYING)
    }

    fun pause() {
        if (ended || state == State.PAUSED || state == State.AD) return
        if (state == State.REBUFFERING) event("rebufferend")
        event("pause")
        move(State.PAUSED)
    }

    /** The player ran out of data. Only a stall after the first frame and outside a seek is rebuffering. */
    fun bufferingStart() {
        if (state != State.PLAYING) return
        rebufferCount += 1
        event("rebufferstart")
        move(State.REBUFFERING)
    }

    fun bufferingEnd() {
        if (state == State.REBUFFERING) playing()
    }

    fun seeking() {
        // A seek before the first frame (to a resume position) is part of startup.
        if (ended || !firstFrame || state == State.SEEKING || state == State.AD) return
        seekCount += 1
        event("seeking")
        move(State.SEEKING)
    }

    /** The seek landed. While paused the seek is over; otherwise it is over when frames move again. */
    fun seeked(paused: Boolean) {
        if (state != State.SEEKING) return
        event("seeked")
        if (paused) move(State.PAUSED)
    }

    fun rendition(kbps: Double?, width: Int?, height: Int?) {
        if (state == State.AD) return // an ad's own rendition, in players that play ads themselves
        if (kbps == this.kbps && width == videoWidth && height == videoHeight) return
        account()
        if (firstFrame) renditionChanges += 1
        this.kbps = kbps
        videoWidth = width
        videoHeight = height
        if (kbps != null) maxBitrateKbps = max(maxBitrateKbps ?: 0, kbps.roundToLong())
        event("rendition", mapOf("kbps" to kbps?.roundToLong(), "width" to width, "height" to height))
    }

    /** The player's size on screen in pixels. */
    fun playerSize(width: Int, height: Int) {
        val w = width.takeIf { it > 0 }
        val h = height.takeIf { it > 0 }
        if (w == playerWidth && h == playerHeight) return
        account()
        playerWidth = w
        playerHeight = h
    }

    fun playhead(ms: Long) {
        if (state != State.AD) playheadMs = max(playheadMs, ms)
    }

    fun droppedFrames(total: Long) {
        droppedFrames = max(droppedFrames, total)
    }

    fun liveLatency(ms: Long) {
        liveLatencyMs = max(0, ms)
    }

    fun failed(code: String, message: String, fatal: Boolean = true) {
        if (ended) return
        event("error", mapOf("code" to code, "message" to message, "fatal" to fatal))
        if (!fatal) return
        error = mapOf("code" to code, "message" to message, "fatal" to true)
        end()
    }

    /** The video played to its end. */
    fun completed() {
        if (ended) return
        event("ended")
        end()
    }

    /** The viewer left the video: new source, player released, app closed. */
    fun end() {
        if (ended) return
        stopAdClock()
        move(State.ENDED)
        ended = true
        event("viewend")
    }

    // Ads ------------------------------------------------------------------------------------------

    /** The video gave way to ads (pre-, mid- or post-roll). Until adBreakEnd nothing counts as video time. */
    fun adBreakStart() {
        if (ended || state == State.AD) return
        // Ads before anything else (a pre-roll after the play button): playback was asked for.
        if (state == State.IDLE && playRequestedAt == null) playRequestedAt = now()
        beforeAd = if (state == State.IDLE) State.STARTING else state
        adBreakAt = now()
        adBreakCount += 1
        event("adbreakstart")
        move(State.AD)
    }

    /** An ad was asked to play. */
    fun adStart() {
        if (ended) return
        if (state != State.AD) adBreakStart()
        adCount += 1
        event("adplay")
    }

    /** The ad's frames are moving. */
    fun adPlaying() {
        if (state != State.AD || adPlayingSince != null) return
        adPlayingSince = now()
        event("adplaying")
    }

    fun adPause() {
        if (state != State.AD) return
        stopAdClock()
        event("adpause")
    }

    fun adEnd() {
        if (state != State.AD) return
        stopAdClock()
        event("adended")
    }

    /** An ad failed. It does not fail the view: the video plays on without it. */
    fun adError(code: String, message: String = "") {
        if (ended) return
        stopAdClock()
        adErrorCount += 1
        event("aderror", mapOf("code" to code, "message" to message))
    }

    /** The ads gave the video back. */
    fun adBreakEnd() {
        if (state != State.AD) return
        stopAdClock()
        // A pre-roll is not the video's startup.
        if (!firstFrame) startupAdMs += now() - adBreakAt
        event("adbreakend")
        // After a mid-roll the video is paused until its frames move again.
        move(if (beforeAd == State.PLAYING || beforeAd == State.REBUFFERING || beforeAd == State.SEEKING) State.PAUSED else beforeAd)
    }

    /** The view as the next beacon sends it, with its oldest unsent events. Events stay until sent(count) says the backend has them. */
    fun snapshot(maxEvents: Int = Int.MAX_VALUE): Map<String, Any?> {
        account()
        adPlayingSince?.let {
            val current = now()
            adWatchMs += current - it
            adPlayingSince = current
        }
        seq += 1
        return mapOf(
            "view_id" to viewId,
            "seq" to seq,
            "started_at" to startedAt,
            "ended" to ended,
            "video" to mapOf(
                "id" to video.id, "title" to video.title, "series_id" to video.seriesId, "series_title" to video.seriesTitle,
                "duration_ms" to video.durationMs, "stream_type" to video.streamType,
                "source_type" to video.sourceType, "source_host" to video.sourceHost,
            ),
            "player" to mapOf(
                "name" to player.name, "version" to player.version, "autoplay" to player.autoplay,
                "width" to playerWidth, "height" to playerHeight,
            ),
            "metrics" to mapOf(
                "player_startup_ms" to playerStartupMs,
                "video_startup_ms" to videoStartupMs,
                "watch_ms" to watchMs,
                "playing_ms" to playingMs,
                "rebuffer_count" to rebufferCount,
                "rebuffer_ms" to rebufferMs,
                "seek_count" to seekCount,
                "seek_ms" to seekMs,
                "playhead_ms" to playheadMs,
                "avg_bitrate_kbps" to if (bitratePlayingMs > 0) (bitrateMs / bitratePlayingMs).roundToLong() else null,
                "max_bitrate_kbps" to maxBitrateKbps,
                "rendition_changes" to renditionChanges,
                "video_width" to videoWidth,
                "video_height" to videoHeight,
                "upscale_ms" to upscaleMs,
                "downscale_ms" to downscaleMs,
                "max_upscale_pct" to maxUpscalePct,
                "dropped_frames" to droppedFrames,
                "live_latency_ms" to liveLatencyMs,
                "ad_break_count" to adBreakCount,
                "ad_count" to adCount,
                "ad_watch_ms" to adWatchMs,
                "ad_error_count" to adErrorCount,
            ),
            "custom" to video.custom.filterValues { it.isNotEmpty() }.mapKeys { it.key.toString() },
            "error" to error,
            "events" to events.take(maxEvents),
        )
    }

    /** The backend took the first [count] events. */
    fun sent(count: Int) {
        repeat(min(count, events.size)) { events.removeAt(0) }
    }

    private fun event(type: String, data: Map<String, Any?>? = null) {
        val t = now() - t0
        events += if (data == null) mapOf("t" to t, "type" to type) else mapOf("t" to t, "type" to type, "data" to data)
    }

    private fun move(next: State) {
        account()
        state = next
    }

    private fun stopAdClock() {
        val started = adPlayingSince ?: return
        adWatchMs += now() - started
        adPlayingSince = null
    }

    /** Adds the time since the last change to the totals of the state the view is in. */
    private fun account() {
        val current = now()
        val ms = max(0, current - since)
        since = current
        if (ended || ms == 0L) return
        if (state == State.STARTING || state == State.PLAYING || state == State.REBUFFERING || state == State.SEEKING) watchMs += ms
        if (state == State.REBUFFERING) rebufferMs += ms
        if (state == State.SEEKING) seekMs += ms
        if (state != State.PLAYING) return
        playingMs += ms
        kbps?.let {
            bitrateMs += it * ms
            bitratePlayingMs += ms
        }
        val vw = videoWidth ?: return
        val vh = videoHeight ?: return
        val pw = playerWidth ?: return
        val ph = playerHeight ?: return
        if (vw == 0 || vh == 0) return
        val scale = min(pw.toDouble() / vw, ph.toDouble() / vh)
        if (scale > 1) {
            upscaleMs += ms
            maxUpscalePct = max(maxUpscalePct, Math.round((scale - 1) * 1000) / 10.0)
        } else if (scale < 1) {
            downscaleMs += ms
        }
    }
}

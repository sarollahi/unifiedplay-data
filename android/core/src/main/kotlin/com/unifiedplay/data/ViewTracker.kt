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
    /** The CDN serving the video, when you know it; otherwise the X-CDN response header names it. */
    val cdn: String? = null,
    /** widevine, playready, fairplay or clearkey, when the player cannot tell. */
    val drmType: String? = null,
    /** Your own id for this view, to join it with CDN logs: give your player's CMCD session id the same value. */
    val viewSessionId: String? = null,
    /** episode, movie, trailer, clip, live… */
    val contentType: String? = null,
    /** The audio language, e.g. en, sv. */
    val languageCode: String? = null,
    /** Which variant of the video (a cut, a dub). */
    val variantName: String? = null,
    /** Which encoding ladder or settings, for comparing encodings. */
    val encodingVariant: String? = null,
    /** An A/B test this view is in. */
    val experimentName: String? = null,
    /** A part of your service (a site, a customer, a channel). */
    val subPropertyId: String? = null,
    /** Up to ten of your own dimensions (1..10); the Console breaks views down by them. */
    val custom: Map<Int, String> = emptyMap(),
)

/**
 * One network request for the content (spec: Requests). type: manifest, video, audio, video_init,
 * audio_init, media, subtitle or encryption. Times are milliseconds on any one clock.
 */
data class RequestInfo(
    val type: String? = null,
    val hostname: String? = null,
    val start: Long? = null,
    /** When the first byte arrived, if the player tells. */
    val responseStart: Long? = null,
    val responseEnd: Long? = null,
    val bytes: Long? = null,
    /** Response headers: X-CDN names the CDN. */
    val headers: Map<String, List<String>> = emptyMap(),
    val error: String? = null,
    val errorCode: Int? = null,
    val errorText: String? = null,
)

private val MEDIA_REQUESTS = setOf("video", "audio", "media")
private val FAILED_MEDIA = setOf("video", "audio", "media", "video_init", "audio_init")

/** widevine, playready, fairplay or clearkey from a key system name or scheme UUID ("" when unknown). */
fun drmTypeOf(keySystem: String?): String {
    val name = keySystem.orEmpty().lowercase()
    return when {
        "widevine" in name || "edef8ba9" in name -> "widevine"
        "playready" in name || "9a04f079" in name -> "playready"
        "fairplay" in name || "apple.fps" in name || "streamingkeydelivery" in name || "94ce86fb" in name -> "fairplay"
        "clearkey" in name || "e2719d58" in name || "1077efec" in name -> "clearkey"
        else -> ""
    }
}

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
    private var cdn: String = video.cdn.orEmpty()
    private var drmType: String = video.drmType.orEmpty()
    private var fullscreen = false
    private var pip = false
    private var mode = "standard"
    private var captionsOn = false
    // Pre-roll (spec: Startup): when it was asked to play, the open ad request, the last ad response.
    private var prerollAt: Long? = null
    private var adRequestAt: Long? = null
    private var adResponseAt: Long? = null
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
    private var requestCompleted = 0
    private var requestFailed = 0
    private var requestCanceled = 0
    private var requestFailedManifest = 0
    private var requestFailedMedia = 0
    private var requestFailedEncryption = 0
    private var requestMediaCompleted = 0
    private var requestMediaBytes = 0L
    private var requestMediaMs = 0L
    private var requestMediaTtfbMs = 0L
    private var requestMediaTtfbCount = 0
    private var requestMediaMaxTtfbMs = 0L
    private var contentStartupMs: Long? = null
    private var adStartupMs: Long? = null
    private var prerollRequestMs: Long? = null
    private var prerollLoadMs: Long? = null
    private var prerollRequests = 0
    private var upscalePctMs = 0.0
    private var downscalePctMs = 0.0
    private var maxDownscalePct = 0.0

    init {
        event("viewstart")
    }

    /** A content request came back. Media segments add to the throughput and latency totals. */
    fun requestCompleted(request: RequestInfo) {
        if (ended) return
        requestCompleted += 1
        cdnFrom(request)
        if ((request.type ?: "media") !in MEDIA_REQUESTS) return
        requestMediaCompleted += 1
        requestMediaBytes += max(0, request.bytes ?: 0)
        val start = request.start ?: return
        request.responseEnd?.let { requestMediaMs += max(0, it - start) }
        request.responseStart?.let {
            val ttfb = max(0, it - start)
            requestMediaTtfbMs += ttfb
            requestMediaTtfbCount += 1
            requestMediaMaxTtfbMs = max(requestMediaMaxTtfbMs, ttfb)
        }
    }

    fun requestFailed(request: RequestInfo) {
        if (ended) return
        requestFailed += 1
        when (request.type) {
            "manifest" -> requestFailedManifest += 1
            "encryption" -> requestFailedEncryption += 1
            in FAILED_MEDIA -> requestFailedMedia += 1
        }
        cdnFrom(request)
        event("requestfailed", mapOf("type" to request.type, "hostname" to request.hostname, "error" to request.error,
            "code" to request.errorCode, "text" to request.errorText))
    }

    fun requestCanceled(request: RequestInfo) {
        if (ended) return
        requestCanceled += 1
        event("requestcanceled", mapOf("type" to request.type, "hostname" to request.hostname))
    }

    /** Captions shown at some point of the view. */
    fun captions(on: Boolean) {
        if (on && !captionsOn) {
            captionsOn = true
            event("captions", mapOf("on" to true))
        }
    }

    /** An ad request went out (VAST/VMAP). Before the first pre-roll plays, its time is pre-roll request time. */
    fun adRequest() {
        if (ended) return
        if (!firstFrame && adStartupMs == null) {
            prerollRequests += 1
            if (adRequestAt == null) adRequestAt = now()
        }
        event("adrequest")
    }

    /** The ad response came back and was read. */
    fun adResponse() {
        if (ended) return
        val current = now()
        val requested = adRequestAt
        val played = playRequestedAt
        if (requested != null && played != null && adStartupMs == null) {
            // Only time after playback was asked for counts.
            prerollRequestMs = (prerollRequestMs ?: 0) + current - max(requested, played)
        }
        adRequestAt = null
        adResponseAt = current
        event("adresponse")
    }

    /** standard, fullscreen, pip, or your own name. */
    fun playbackMode(next: String) {
        if (next == mode) return
        mode = next
        if (next == "fullscreen") fullscreen = true
        if (next == "pip") pip = true
        event("playbackmodechange", mapOf("mode" to next))
    }

    fun setDrmType(type: String) {
        if (type.isNotEmpty()) drmType = type
    }

    private fun cdnFrom(request: RequestInfo) {
        // An app-set CDN wins; otherwise the latest X-CDN header names it.
        val name = request.headers.entries.firstOrNull { it.key.equals("x-cdn", ignoreCase = true) }?.value?.firstOrNull()?.trim()?.take(64)
        if (name.isNullOrEmpty() || video.cdn != null || name == cdn) return
        cdn = name
        event("cdnchange", mapOf("cdn" to name))
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
            val since = now() - (playRequestedAt ?: t0)
            // Video startup ends at the first frame of a pre-roll, if one came first; content startup leaves ads out.
            if (videoStartupMs == null) videoStartupMs = since
            contentStartupMs = since - startupAdMs
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

    /**
     * An error. fatal: it stopped playback. businessException: your own rule stopped it (geo-block,
     * paywall, too many streams): no playback failure.
     */
    fun failed(code: String, message: String, fatal: Boolean = true, businessException: Boolean = false) {
        if (ended) return
        event("error", if (businessException) mapOf("code" to code, "message" to message, "fatal" to fatal, "business_exception" to true)
            else mapOf("code" to code, "message" to message, "fatal" to fatal))
        if (!fatal) return
        error = mapOf("code" to code, "message" to message, "fatal" to fatal, "business_exception" to businessException)
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
        if (!firstFrame && prerollAt == null) prerollAt = now()
        adCount += 1
        event("adplay")
    }

    /** The ad's frames are moving. */
    fun adPlaying() {
        if (state != State.AD || adPlayingSince != null) return
        val current = now()
        adPlayingSince = current
        if (!firstFrame && adStartupMs == null) {
            val asked = prerollAt ?: adBreakAt
            adStartupMs = current - asked
            // Loading the ad: from the last ad response (or the ad's start), never before playback was asked for.
            prerollLoadMs = current - max(adResponseAt ?: asked, playRequestedAt ?: Long.MIN_VALUE)
            videoStartupMs = current - (playRequestedAt ?: t0)
        }
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
                "cdn" to cdn.ifEmpty { null }, "drm_type" to drmType.ifEmpty { null },
                "content_type" to video.contentType, "language_code" to video.languageCode,
                "variant_name" to video.variantName, "encoding_variant" to video.encodingVariant,
            ),
            "player" to mapOf(
                "name" to player.name, "version" to player.version, "autoplay" to player.autoplay,
                "width" to playerWidth, "height" to playerHeight, "fullscreen" to fullscreen, "pip" to pip, "captions" to captionsOn,
            ),
            "view_session_id" to video.viewSessionId,
            "experiment_name" to video.experimentName,
            "sub_property_id" to video.subPropertyId,
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
                "request_completed" to requestCompleted,
                "request_failed" to requestFailed,
                "request_canceled" to requestCanceled,
                "request_failed_manifest" to requestFailedManifest,
                "request_failed_media" to requestFailedMedia,
                "request_failed_encryption" to requestFailedEncryption,
                "request_media_completed" to requestMediaCompleted,
                "request_media_bytes" to requestMediaBytes,
                "request_media_ms" to requestMediaMs,
                "request_media_ttfb_ms" to requestMediaTtfbMs,
                "request_media_ttfb_count" to requestMediaTtfbCount,
                "request_media_max_ttfb_ms" to requestMediaMaxTtfbMs,
                "content_startup_ms" to contentStartupMs,
                "ad_startup_ms" to adStartupMs,
                "preroll_request_ms" to prerollRequestMs,
                "preroll_load_ms" to prerollLoadMs,
                "preroll_requests" to prerollRequests,
                "upscale_pct_ms" to upscalePctMs.roundToLong(),
                "downscale_pct_ms" to downscalePctMs.roundToLong(),
                "max_downscale_pct" to maxDownscalePct,
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
        // How much the dimension that fills the player first is stretched (320 → 640: 100 %) or shrunk.
        if (scale > 1) {
            val pct = Math.round((scale - 1) * 1000) / 10.0
            upscaleMs += ms
            upscalePctMs += pct * ms
            maxUpscalePct = max(maxUpscalePct, pct)
        } else if (scale < 1) {
            val pct = Math.round((1 / scale - 1) * 1000) / 10.0
            downscaleMs += ms
            downscalePctMs += pct * ms
            maxDownscalePct = max(maxDownscalePct, pct)
        }
    }
}

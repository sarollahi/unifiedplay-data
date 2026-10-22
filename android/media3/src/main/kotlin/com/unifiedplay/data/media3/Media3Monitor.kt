package com.unifiedplay.data.media3

import androidx.media3.common.C
import androidx.media3.common.DrmInitData
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaLibraryInfo
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DecoderReuseEvaluation
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.source.LoadEventInfo
import androidx.media3.exoplayer.source.MediaLoadData
import com.unifiedplay.data.DataClient
import com.unifiedplay.data.PlayerInfo
import com.unifiedplay.data.PlayerMonitor
import com.unifiedplay.data.RenditionDetails
import com.unifiedplay.data.RequestInfo
import com.unifiedplay.data.VideoInfo
import com.unifiedplay.data.ViewTracker
import androidx.media3.datasource.HttpDataSource
import java.io.IOException

/**
 * Watches a Media3 ExoPlayer (any Media3 1.x). A view starts when playback of a media item is
 * asked for; the next item ends it. It lets go by itself when the player is released.
 *
 * ```
 * Media3Monitor(dataClient, player) { item -> VideoInfo(id = item.mediaId, title = …) }
 * ```
 */
@UnstableApi
class Media3Monitor(
    client: DataClient,
    private val player: ExoPlayer,
    private val describeItem: (MediaItem) -> VideoInfo = { VideoInfo(id = it.mediaId.ifEmpty { null }) },
) : PlayerMonitor(client, PlayerInfo(name = "media3", version = MediaLibraryInfo.VERSION, software = "Media3", softwareVersion = MediaLibraryInfo.VERSION)), AnalyticsListener {
    private var dropped = 0L

    init {
        player.addAnalyticsListener(this)
        if (player.currentMediaItem != null) {
            newSource()
            if (player.playbackState == Player.STATE_READY) ready()
            if (player.playWhenReady) current()?.play()
        }
    }

    override fun describe(): VideoInfo? = player.currentMediaItem?.let(describeItem)

    override fun autoplay(): Boolean = player.playWhenReady

    override fun onNewView(view: ViewTracker) {
        dropped = 0
        player.videoFormat?.let { rendition(view, it) }
    }

    override fun beforeBeacon(view: ViewTracker) {
        view.playhead(player.currentPosition)
        if (player.isCurrentMediaItemLive) {
            val offset = player.currentLiveOffset
            if (offset != C.TIME_UNSET) view.liveLatency(offset)
        }
    }

    override fun release() {
        player.removeAnalyticsListener(this)
        super.release()
    }

    override fun onMediaItemTransition(eventTime: AnalyticsListener.EventTime, mediaItem: MediaItem?, reason: Int) {
        newSource(hasSource = mediaItem != null)
        if (mediaItem != null && player.playWhenReady) current()?.play()
    }

    override fun onPlayWhenReadyChanged(eventTime: AnalyticsListener.EventTime, playWhenReady: Boolean, reason: Int) {
        if (playWhenReady) current()?.play() else {
            view?.pause()
            // Pausing is also how the app goes to the background: send what we have.
            client.flush()
        }
    }

    override fun onPlaybackStateChanged(eventTime: AnalyticsListener.EventTime, state: Int) {
        if (state == Player.STATE_READY) ready()
        if (player.isPlayingAd) return
        val tracker = view ?: return
        when (state) {
            Player.STATE_BUFFERING -> tracker.bufferingStart()
            Player.STATE_READY -> if (player.isPlaying) tracker.playing() else tracker.seeked(paused = !player.playWhenReady)
            Player.STATE_ENDED -> {
                tracker.completed()
                client.flush()
            }
        }
    }

    override fun onIsPlayingChanged(eventTime: AnalyticsListener.EventTime, isPlaying: Boolean) {
        if (isPlaying && !player.isPlayingAd) view?.playing()
    }

    override fun onRenderedFirstFrame(eventTime: AnalyticsListener.EventTime, output: Any, renderTimeMs: Long) {
        if (player.isPlayingAd) return
        val tracker = view ?: return
        val first = tracker.videoStartupMs == null
        if (player.isPlaying || first) tracker.playing()
        if (first) client.flush()
    }

    override fun onPositionDiscontinuity(
        eventTime: AnalyticsListener.EventTime,
        oldPosition: Player.PositionInfo,
        newPosition: Player.PositionInfo,
        reason: Int,
    ) {
        if (reason != Player.DISCONTINUITY_REASON_SEEK) return
        val tracker = view ?: return
        tracker.seeking()
        // A seek inside the buffer never leaves READY: it is over at once.
        if (player.playbackState == Player.STATE_READY) {
            if (player.isPlaying) tracker.playing() else tracker.seeked(paused = !player.playWhenReady)
        }
    }

    override fun onVideoInputFormatChanged(eventTime: AnalyticsListener.EventTime, format: Format, decoderReuseEvaluation: DecoderReuseEvaluation?) {
        drm(format)
        view?.let { rendition(it, format) }
    }

    override fun onDroppedVideoFrames(eventTime: AnalyticsListener.EventTime, droppedFrames: Int, elapsedMs: Long) {
        dropped += droppedFrames
        view?.droppedFrames(dropped)
    }

    override fun onTracksChanged(eventTime: AnalyticsListener.EventTime, tracks: Tracks) {
        captions(tracks.isTypeSelected(C.TRACK_TYPE_TEXT))
    }

    override fun onSurfaceSizeChanged(eventTime: AnalyticsListener.EventTime, width: Int, height: Int) {
        size(width, height)
    }

    override fun onPlayerReleased(eventTime: AnalyticsListener.EventTime) {
        release()
    }

    override fun onPlayerError(eventTime: AnalyticsListener.EventTime, error: PlaybackException) {
        current()?.failed(error.errorCodeName, error.message.orEmpty(), fatal = true)
        client.flush()
    }

    // Network requests (spec: Requests): the player's loads, with their bytes, time and response headers.
    // It does not report time to first byte.
    override fun onLoadCompleted(eventTime: AnalyticsListener.EventTime, loadEventInfo: LoadEventInfo, mediaLoadData: MediaLoadData) {
        val type = requestType(mediaLoadData) ?: return
        requestCompleted(RequestInfo(
            type = type, hostname = loadEventInfo.uri.host, bytes = loadEventInfo.bytesLoaded,
            start = loadEventInfo.elapsedRealtimeMs - loadEventInfo.loadDurationMs, responseEnd = loadEventInfo.elapsedRealtimeMs,
            headers = loadEventInfo.responseHeaders,
        ))
    }

    override fun onLoadError(
        eventTime: AnalyticsListener.EventTime,
        loadEventInfo: LoadEventInfo,
        mediaLoadData: MediaLoadData,
        error: IOException,
        wasCanceled: Boolean,
    ) {
        val type = requestType(mediaLoadData) ?: return
        if (wasCanceled) {
            requestCanceled(RequestInfo(type = type, hostname = loadEventInfo.uri.host))
            return
        }
        val status = (error as? HttpDataSource.InvalidResponseCodeException)?.responseCode
        requestFailed(RequestInfo(type = type, hostname = loadEventInfo.uri.host, headers = loadEventInfo.responseHeaders,
            error = error.javaClass.simpleName, errorCode = status, errorText = error.message))
    }

    override fun onLoadCanceled(eventTime: AnalyticsListener.EventTime, loadEventInfo: LoadEventInfo, mediaLoadData: MediaLoadData) {
        val type = requestType(mediaLoadData) ?: return
        requestCanceled(RequestInfo(type = type, hostname = loadEventInfo.uri.host))
    }

    private fun requestType(data: MediaLoadData): String? {
        val track = data.trackType
        return when (data.dataType) {
            C.DATA_TYPE_MANIFEST -> "manifest"
            C.DATA_TYPE_DRM -> "encryption"
            C.DATA_TYPE_MEDIA_INITIALIZATION -> if (track == C.TRACK_TYPE_AUDIO) "audio_init" else "video_init"
            C.DATA_TYPE_MEDIA -> when (track) {
                C.TRACK_TYPE_VIDEO -> "video"
                C.TRACK_TYPE_AUDIO -> "audio"
                C.TRACK_TYPE_TEXT -> "subtitle"
                else -> "media"
            }
            else -> null // ads, time sync…: not the content
        }
    }

    private fun drm(format: Format) {
        val init: DrmInitData = format.drmInitData ?: return
        for (index in 0 until init.schemeDataCount) {
            val type = when (init.get(index).uuid) {
                C.WIDEVINE_UUID -> "widevine"
                C.PLAYREADY_UUID -> "playready"
                C.CLEARKEY_UUID -> "clearkey"
                else -> null
            }
            if (type != null) { setDrmType(type); return }
        }
    }

    private fun rendition(tracker: ViewTracker, format: Format) {
        val bitrate = format.bitrate.takeIf { it != Format.NO_VALUE }?.let { it / 1000.0 }
        val range = when {
            format.sampleMimeType == "video/dolby-vision" -> "Dolby Vision"
            format.colorInfo?.colorTransfer == C.COLOR_TRANSFER_ST2084 -> "HDR10"
            format.colorInfo?.colorTransfer == C.COLOR_TRANSFER_HLG -> "HLG"
            else -> "SDR"
        }
        tracker.rendition(
            bitrate, format.width.takeIf { it != Format.NO_VALUE }, format.height.takeIf { it != Format.NO_VALUE },
            RenditionDetails(videoCodec = format.codecs ?: format.sampleMimeType, framerate = format.frameRate.takeIf { it > 0 }?.toDouble(), dynamicRange = range),
        )
    }

    override fun onAudioInputFormatChanged(eventTime: AnalyticsListener.EventTime, format: Format, decoderReuseEvaluation: DecoderReuseEvaluation?) {
        view?.renditionDetails(RenditionDetails(audioCodec = format.codecs ?: format.sampleMimeType))
    }
}

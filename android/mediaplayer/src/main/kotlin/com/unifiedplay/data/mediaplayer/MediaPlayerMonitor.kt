package com.unifiedplay.data.mediaplayer

import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.widget.VideoView
import com.unifiedplay.data.DataClient
import com.unifiedplay.data.PlayerInfo
import com.unifiedplay.data.PlayerMonitor
import com.unifiedplay.data.VideoInfo
import com.unifiedplay.data.ViewTracker

/**
 * Watches an Android MediaPlayer or VideoView.
 *
 * Both take only one listener of each kind, so the monitor takes them and passes every callback on
 * to yours: set your listeners on the monitor, not on the player. Neither tells when playback
 * starts or pauses, so the monitor checks every 250 ms; calling [play]/[pause] on the monitor
 * instead of the player makes that exact.
 *
 * ```
 * val monitor = MediaPlayerMonitor(dataClient, videoView)
 * monitor.onPrepared = MediaPlayer.OnPreparedListener { … }
 * monitor.load(VideoInfo(id = "ep-1", title = "Episode 1"))   // before setVideoURI / setDataSource
 * videoView.setVideoURI(uri)
 * monitor.play()
 * …
 * monitor.release()
 * ```
 */
class MediaPlayerMonitor private constructor(
    client: DataClient,
    private val mediaPlayer: MediaPlayer?,
    private val videoView: VideoView?,
) : PlayerMonitor(client, PlayerInfo(name = if (videoView != null) "videoview" else "mediaplayer", version = Build.VERSION.RELEASE, software = "MediaPlayer", softwareVersion = Build.VERSION.RELEASE)) {

    constructor(client: DataClient, player: MediaPlayer) : this(client, player, null)
    constructor(client: DataClient, videoView: VideoView) : this(client, null, videoView)

    var onPrepared: MediaPlayer.OnPreparedListener? = null
    var onCompletion: MediaPlayer.OnCompletionListener? = null
    var onError: MediaPlayer.OnErrorListener? = null
    var onInfo: MediaPlayer.OnInfoListener? = null
    var onSeekComplete: MediaPlayer.OnSeekCompleteListener? = null
    var onVideoSizeChanged: MediaPlayer.OnVideoSizeChangedListener? = null

    private var video: VideoInfo? = null
    private var wasPlaying = false
    private val handler = Handler(Looper.getMainLooper())
    private val poll = object : Runnable {
        override fun run() {
            check()
            handler.postDelayed(this, POLL_MS)
        }
    }

    private val prepared = MediaPlayer.OnPreparedListener { mp ->
        ready()
        if (videoView != null) {
            // VideoView hands out its MediaPlayer only here.
            mp.setOnSeekCompleteListener(seekComplete)
            mp.setOnVideoSizeChangedListener(videoSize)
        }
        if (mp.videoWidth > 0) view?.rendition(null, mp.videoWidth, mp.videoHeight)
        onPrepared?.onPrepared(mp)
    }
    private val completion = MediaPlayer.OnCompletionListener { mp ->
        wasPlaying = false
        view?.completed()
        client.flush()
        onCompletion?.onCompletion(mp)
    }
    private val error = MediaPlayer.OnErrorListener { mp, what, extra ->
        current()?.failed("$what/$extra", errorName(what, extra), fatal = true)
        client.flush()
        onError?.onError(mp, what, extra) ?: false
    }
    private val info = MediaPlayer.OnInfoListener { mp, what, extra ->
        when (what) {
            MediaPlayer.MEDIA_INFO_VIDEO_RENDERING_START -> current()?.let {
                val first = it.videoStartupMs == null
                it.playing()
                if (first) client.flush()
            }
            MediaPlayer.MEDIA_INFO_BUFFERING_START -> view?.bufferingStart()
            MediaPlayer.MEDIA_INFO_BUFFERING_END -> view?.bufferingEnd()
        }
        onInfo?.onInfo(mp, what, extra) ?: false
    }
    private val seekComplete = MediaPlayer.OnSeekCompleteListener { mp ->
        view?.let { if (isPlaying()) it.playing() else it.seeked(paused = true) }
        onSeekComplete?.onSeekComplete(mp)
    }
    private val videoSize = MediaPlayer.OnVideoSizeChangedListener { mp, width, height ->
        if (width > 0) view?.rendition(null, width, height)
        onVideoSizeChanged?.onVideoSizeChanged(mp, width, height)
    }

    init {
        mediaPlayer?.apply {
            setOnPreparedListener(prepared)
            setOnCompletionListener(completion)
            setOnErrorListener(error)
            setOnInfoListener(info)
            setOnSeekCompleteListener(seekComplete)
            setOnVideoSizeChangedListener(videoSize)
        }
        videoView?.apply {
            setOnPreparedListener(prepared)
            setOnCompletionListener(completion)
            setOnErrorListener(error)
            setOnInfoListener(info)
        }
        handler.postDelayed(poll, POLL_MS)
    }

    /** What plays next: call before giving the player a new source. Ends the open view. */
    fun load(video: VideoInfo) {
        newSource()
        wasPlaying = false
        this.video = video
    }

    /** Starts the player: the exact moment playback was asked for. */
    fun play() {
        startedByPlayer()
        mediaPlayer?.start()
        videoView?.start()
    }

    fun pause() {
        mediaPlayer?.pause()
        videoView?.pause()
        check()
    }

    fun seekTo(ms: Int) {
        view?.seeking()
        mediaPlayer?.seekTo(ms)
        videoView?.seekTo(ms)
    }

    /** A MediaPlayer has no view to measure: tell the monitor how big its surface is on screen, in pixels. */
    fun playerSize(width: Int, height: Int) = size(width, height)

    override fun describe(): VideoInfo? = video

    override fun beforeBeacon(view: ViewTracker) {
        videoView?.let { size(it.width, it.height) }
        val position = runCatching { mediaPlayer?.currentPosition ?: videoView?.currentPosition }.getOrNull()
        position?.let { view.playhead(it.toLong()) }
    }

    override fun release() {
        handler.removeCallbacks(poll)
        super.release()
    }

    private fun isPlaying(): Boolean = runCatching { mediaPlayer?.isPlaying ?: videoView?.isPlaying ?: false }.getOrDefault(false)

    /** Playback started or stopped without the monitor being told. */
    private fun check() {
        val playing = isPlaying()
        if (playing == wasPlaying) return
        if (playing) startedByPlayer() else {
            wasPlaying = false
            view?.pause()
            // Pausing is also how the app goes to the background: send what we have.
            client.flush()
        }
    }

    private fun startedByPlayer() {
        if (wasPlaying) return
        wasPlaying = true
        val tracker = current() ?: return
        // A resume has no first frame to wait for.
        if (tracker.videoStartupMs == null) tracker.play() else tracker.playing()
    }

    private fun errorName(what: Int, extra: Int): String = when (extra) {
        MediaPlayer.MEDIA_ERROR_IO -> "MEDIA_ERROR_IO"
        MediaPlayer.MEDIA_ERROR_MALFORMED -> "MEDIA_ERROR_MALFORMED"
        MediaPlayer.MEDIA_ERROR_UNSUPPORTED -> "MEDIA_ERROR_UNSUPPORTED"
        MediaPlayer.MEDIA_ERROR_TIMED_OUT -> "MEDIA_ERROR_TIMED_OUT"
        else -> if (what == MediaPlayer.MEDIA_ERROR_SERVER_DIED) "MEDIA_ERROR_SERVER_DIED" else "MEDIA_ERROR_UNKNOWN"
    }

    private companion object {
        const val POLL_MS = 250L
    }
}

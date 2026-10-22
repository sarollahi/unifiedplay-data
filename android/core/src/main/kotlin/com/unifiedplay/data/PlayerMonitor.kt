package com.unifiedplay.data

import java.util.Locale
import java.util.UUID

/** The device's Widevine security level (L1: hardware, L3: software), "" where it cannot tell. */
val widevineSecurityLevel: String by lazy {
    runCatching {
        val drm = android.media.MediaDrm(UUID.fromString("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"))
        try { drm.getPropertyString("securityLevel") } finally { if (android.os.Build.VERSION.SDK_INT >= 28) drm.close() else @Suppress("DEPRECATION") drm.release() }
    }.getOrDefault("")
}

/**
 * Takes ad events from an ad library (com.unifiedplay.data:ima) or from your own ad player.
 * Every monitor is one.
 */
interface AdTarget {
    /** The video gave way to ads (pre-, mid- or post-roll). */
    fun adBreakStart()
    /** An ad was asked to play. */
    fun adStart()
    /** The ad's frames are moving. */
    fun adPlaying()
    fun adPause()
    fun adEnd()
    /** An ad failed; the view goes on. */
    fun adError(code: String, message: String = "")
    /** The ads gave the video back. */
    fun adBreakEnd()
    /** An ad request went out (VAST/VMAP): before the first pre-roll, its time is pre-roll request time. */
    fun adRequest() {}
    /** The ad response came back and was read. */
    fun adResponse() {}
}

/**
 * What every player monitor shares: a view starts when playback of a source is asked for (so a
 * preloaded video nobody plays is no view), a new source ends it, and player startup is measured
 * from the source to "ready" even before anyone plays. Call everything on the main thread.
 */
abstract class PlayerMonitor(protected val client: DataClient, private val info: PlayerInfo) : AdTarget {
    protected var view: ViewTracker? = null
        private set
    // Requests before a view exists (the manifest, a preload) go into it when it starts.
    private val early = mutableListOf<Pair<Int, RequestInfo>>()
    private var drmType = ""
    private var mode = "standard"
    private var captionsOn = false
    private var sourceAt: Long? = null
    private var readyAt: Long? = null
    private var width = 0
    private var height = 0
    private val instanceId = UUID.randomUUID().toString()
    private val readPlayer: () -> Unit = { view?.let { beforeBeacon(it) } }

    init {
        client.beforeBeacon(readPlayer)
    }

    /** What the current source is; null while there is none. */
    protected abstract fun describe(): VideoInfo?

    /** Whether the player starts by itself once ready. */
    protected open fun autoplay(): Boolean = false

    /** Read the player's position, live latency… just before each beacon. */
    protected open fun beforeBeacon(view: ViewTracker) {}

    protected fun now(): Long = System.nanoTime() / 1_000_000

    /** The player got a new source: the open view is over. */
    protected fun newSource(hasSource: Boolean = true) {
        view?.let {
            if (!it.ended) {
                it.end()
                client.flush()
            }
        }
        view = null
        sourceAt = if (hasSource) now() else null
        readyAt = null
        early.clear()
        drmType = ""
    }

    /** The player could start: player startup is done. */
    protected fun ready() {
        if (readyAt != null) return
        val ready = now()
        readyAt = ready
        sourceAt?.let { view?.playerStartup(ready - it) }
    }

    /** The view for the current source; a new one when there is none yet or the last one ended. */
    protected fun current(): ViewTracker? {
        view?.let { if (!it.ended) return it }
        val video = describe() ?: return null
        val next = ViewTracker(video, info.copy(autoplay = autoplay(), instanceId = info.instanceId ?: instanceId, language = info.language ?: Locale.getDefault().toLanguageTag()))
        view = next
        client.add(next)
        next.playerSize(width, height)
        val source = sourceAt
        val ready = readyAt
        if (source != null && ready != null) next.playerStartup(ready - source)
        if (drmType.isNotEmpty()) next.setDrmType(drmType)
        if (drmType == "widevine") next.setDrmLevel(widevineSecurityLevel)
        if (mode != "standard") next.playbackMode(mode)
        if (captionsOn) next.captions(true)
        for ((kind, request) in early) record(next, kind, request)
        early.clear()
        onNewView(next)
        client.flush()
        return next
    }

    /** A new view began: give it what the player already knows (its rendition…). */
    protected open fun onNewView(view: ViewTracker) {}

    /** The player's size on screen in pixels. */
    protected fun size(width: Int, height: Int) {
        this.width = width
        this.height = height
        view?.playerSize(width, height)
    }

    /** A content request came back (the monitors report their player's loads by themselves). */
    fun requestCompleted(request: RequestInfo) = request(COMPLETED, request)

    fun requestFailed(request: RequestInfo) = request(FAILED, request)

    fun requestCanceled(request: RequestInfo) = request(CANCELED, request)

    /** The DRM in use (widevine, playready, fairplay, clearkey). */
    fun setDrmType(type: String) {
        drmType = type
        view?.setDrmType(type)
        if (type == "widevine") view?.setDrmLevel(widevineSecurityLevel)
    }

    /** Captions turned on or off. */
    fun captions(on: Boolean) {
        captionsOn = captionsOn || on
        view?.captions(on)
    }

    /** Your own rule stopped playback (geo-block, paywall, too many streams): the view ends without failing. */
    fun businessException(code: String, message: String = "") {
        current()?.failed(code, message, fatal = true, businessException = true)
        client.flush()
    }

    override fun adRequest() {
        current()?.adRequest()
    }

    override fun adResponse() {
        view?.adResponse()
    }

    /** The app's player went fullscreen ("fullscreen"), picture-in-picture ("pip") or back ("standard"). */
    fun playbackMode(next: String) {
        mode = next
        view?.playbackMode(next)
    }

    private fun request(kind: Int, request: RequestInfo) {
        val open = view?.takeIf { !it.ended }
        if (open != null) record(open, kind, request) else if (early.size < MAX_EARLY_REQUESTS) early += kind to request
    }

    private fun record(view: ViewTracker, kind: Int, request: RequestInfo) = when (kind) {
        COMPLETED -> view.requestCompleted(request)
        FAILED -> view.requestFailed(request)
        else -> view.requestCanceled(request)
    }

    private companion object {
        const val COMPLETED = 0
        const val FAILED = 1
        const val CANCELED = 2
        const val MAX_EARLY_REQUESTS = 50
    }

    override fun adBreakStart() {
        current()?.adBreakStart()
        client.flush()
    }

    override fun adStart() {
        current()?.adStart()
    }

    override fun adPlaying() {
        view?.adPlaying()
    }

    override fun adPause() {
        view?.adPause()
    }

    override fun adEnd() {
        view?.adEnd()
    }

    override fun adError(code: String, message: String) {
        current()?.adError(code, message)
        client.flush()
    }

    override fun adBreakEnd() {
        view?.adBreakEnd()
        client.flush()
    }

    /** Stop watching: ends the open view and sends it. */
    open fun release() {
        view?.let { beforeBeacon(it) }
        view?.end()
        client.flush()
        client.removeBeforeBeacon(readPlayer)
        view = null
    }
}

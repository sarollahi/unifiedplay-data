package com.unifiedplay.data

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
}

/**
 * What every player monitor shares: a view starts when playback of a source is asked for (so a
 * preloaded video nobody plays is no view), a new source ends it, and player startup is measured
 * from the source to "ready" even before anyone plays. Call everything on the main thread.
 */
abstract class PlayerMonitor(protected val client: DataClient, private val info: PlayerInfo) : AdTarget {
    protected var view: ViewTracker? = null
        private set
    private var sourceAt: Long? = null
    private var readyAt: Long? = null
    private var width = 0
    private var height = 0
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
        val next = ViewTracker(video, info.copy(autoplay = autoplay()))
        view = next
        client.add(next)
        next.playerSize(width, height)
        val source = sourceAt
        val ready = readyAt
        if (source != null && ready != null) next.playerStartup(ready - source)
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

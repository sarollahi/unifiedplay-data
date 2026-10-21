package com.unifiedplay.data.ima

import com.google.ads.interactivemedia.v3.api.AdErrorEvent
import com.google.ads.interactivemedia.v3.api.AdEvent
import com.unifiedplay.data.AdTarget

/**
 * Ads from the Google IMA SDK: ad breaks, ads played, ad watch time and ad errors, on the view of
 * the monitor it is given. Hand it to IMA as both listeners, e.g. with Media3:
 *
 * ```
 * val tracker = ImaAdTracker(media3Monitor)
 * ImaAdsLoader.Builder(context).setAdEventListener(tracker).setAdErrorListener(tracker).build()
 * ```
 * or `adsManager.addAdEventListener(tracker)` / `addAdErrorListener(tracker)` with IMA directly.
 */
class ImaAdTracker(private val target: AdTarget) : AdEvent.AdEventListener, AdErrorEvent.AdErrorListener {
    override fun onAdEvent(event: AdEvent) {
        when (event.type) {
            AdEvent.AdEventType.CONTENT_PAUSE_REQUESTED -> target.adBreakStart()
            AdEvent.AdEventType.CONTENT_RESUME_REQUESTED, AdEvent.AdEventType.ALL_ADS_COMPLETED -> target.adBreakEnd()
            AdEvent.AdEventType.LOADED -> target.adStart()
            AdEvent.AdEventType.STARTED, AdEvent.AdEventType.RESUMED -> target.adPlaying()
            AdEvent.AdEventType.PAUSED -> target.adPause()
            AdEvent.AdEventType.COMPLETED, AdEvent.AdEventType.SKIPPED -> target.adEnd()
            else -> Unit
        }
    }

    override fun onAdError(event: AdErrorEvent) {
        target.adError(event.error.errorCodeNumber.toString(), event.error.message.orEmpty())
    }
}

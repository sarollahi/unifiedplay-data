#if canImport(GoogleInteractiveMediaAds)
import GoogleInteractiveMediaAds
import UnifiedPlayData

/// Ads from the Google IMA SDK: ad breaks, ads played, ad watch time and ad errors, on the view of
/// the monitor it is given. IMA takes a single delegate, so call these from yours:
///
/// ```
/// let ads = IMAAdTracker(monitor)
/// func adsManager(_ m: IMAAdsManager, didReceive event: IMAAdEvent) { ads.adsManager(m, didReceive: event); … }
/// func adsManager(_ m: IMAAdsManager, didReceive error: IMAAdError) { ads.adsManager(m, didReceive: error); … }
/// func adsManagerDidRequestContentPause(_ m: IMAAdsManager) { ads.adsManagerDidRequestContentPause(m); … }
/// func adsManagerDidRequestContentResume(_ m: IMAAdsManager) { ads.adsManagerDidRequestContentResume(m); … }
/// func adsLoader(_ l: IMAAdsLoader, failedWith data: IMAAdLoadingErrorData) { ads.adsLoader(l, failedWith: data); … }
/// ```
@MainActor
public final class IMAAdTracker {
    private weak var target: AdTarget?

    public init(_ target: AdTarget) {
        self.target = target
    }

    public func adsManager(_ adsManager: IMAAdsManager, didReceive event: IMAAdEvent) {
        switch event.type {
        case .LOADED: target?.adStart()
        case .STARTED, .RESUME: target?.adPlaying()
        case .PAUSE: target?.adPause()
        case .COMPLETE, .SKIPPED: target?.adEnd()
        case .ALL_ADS_COMPLETED: target?.adBreakEnd()
        default: break
        }
    }

    public func adsManager(_ adsManager: IMAAdsManager, didReceive error: IMAAdError) {
        target?.adError(code: String(error.code.rawValue), message: error.message ?? "")
    }

    public func adsManagerDidRequestContentPause(_ adsManager: IMAAdsManager) {
        target?.adBreakStart()
    }

    public func adsManagerDidRequestContentResume(_ adsManager: IMAAdsManager) {
        target?.adBreakEnd()
    }

    public func adsLoader(_ loader: IMAAdsLoader, failedWith adErrorData: IMAAdLoadingErrorData) {
        target?.adError(code: String(adErrorData.adError.code.rawValue), message: adErrorData.adError.message ?? "")
    }
}
#endif

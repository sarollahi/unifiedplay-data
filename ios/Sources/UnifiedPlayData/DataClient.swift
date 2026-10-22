import Foundation
import Network
#if canImport(UIKit)
import UIKit
#endif

public let sdkName = "unifiedplay-data-ios"
public let sdkVersion = "1.1.1"
public let defaultAPIBase = URL(string: "https://backend.unifiedplay.com")!
private let beaconPath = "/api/v1/data/beacons"
private let deviceKey = "unifiedplay-data-device"
// A beacon carries at most this much, far under the backend's 64 KB; the rest goes with the next ones.
private let maxViews = 10
private let maxEvents = 25

public struct DataConfig: Sendable {
    /// Your data key (up_data_…) from the Console's Video data page, or a UnifiedPlay app's tenant key.
    public var key: String
    /// Where beacons go. Defaults to UnifiedPlay.
    public var apiBase: URL
    /// Your own beacon host (data.example.com), set up in the Console's Video data page: beacons go to
    /// https://{beaconDomain}, which blockers of other sites' hosts let through. Wins over apiBase.
    public var beaconDomain: String?
    /// Defaults to the app's CFBundleShortVersionString.
    public var appVersion: String?
    /// Your own id for the viewer, if you want views per viewer: an opaque id, never an email.
    /// (UnifiedPlay's own apps send the viewer's usr_ id, kept only with analytics consent.)
    public var userID: String?
    /// Your own words for the viewer's plan, for breakdowns: plan ("premium"), its status ("trialing"), its category ("sports").
    public var viewerPlan: String?
    public var viewerPlanStatus: String?
    public var viewerPlanCategory: String?
    public var interval: TimeInterval

    public init(key: String, apiBase: URL = defaultAPIBase, beaconDomain: String? = nil, appVersion: String? = nil, userID: String? = nil,
                interval: TimeInterval = 10, viewerPlan: String? = nil, viewerPlanStatus: String? = nil, viewerPlanCategory: String? = nil) {
        self.viewerPlan = viewerPlan
        self.viewerPlanStatus = viewerPlanStatus
        self.viewerPlanCategory = viewerPlanCategory
        self.key = key
        self.apiBase = apiBase
        self.beaconDomain = beaconDomain
        self.appVersion = appVersion
        self.userID = userID
        self.interval = interval
    }
}

/// What the backend answered: the HTTP status and, when it said so, whether Video data is on.
public struct BeaconResponse: Sendable {
    public var status: Int
    public var enabled: Bool?

    public init(status: Int, enabled: Bool? = nil) {
        self.status = status
        self.enabled = enabled
    }
}

public typealias BeaconSender = @Sendable (_ request: URLRequest, _ done: @escaping @Sendable (BeaconResponse?) -> Void) -> Void

/// Sends the views of every monitored player in one beacon: every 10 s, and right away on key moments.
@MainActor
public final class DataClient {
    private var config: DataConfig
    private let device: [String: String]
    private let deviceID: String
    private let send: BeaconSender
    private var views: [ViewTracker] = []
    private var beforeBeacon: [ObjectIdentifier: () -> Void] = [:]
    private let sessionID = UUID().uuidString.lowercased()
    private var timer: Timer?
    private var inFlight = false
    private var again = false
    /// Off for this app run: the tenant has Video data off, or the key is wrong.
    public private(set) var disabled = false

    public convenience init(config: DataConfig) {
        self.init(config: config, device: appleDevice(appVersion: config.appVersion), deviceID: storedDeviceID(), send: urlSessionSend)
    }

    init(config: DataConfig, device: [String: String], deviceID: String, send: @escaping BeaconSender) {
        self.config = config
        self.device = device
        self.deviceID = deviceID
        self.send = send
        #if canImport(UIKit)
        // Going to the background: send what we have while the app still may.
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.flush() }
        }
        #endif
    }

    public func setUserID(_ userID: String?) {
        config.userID = userID
    }

    /// The viewer's plan changed (signed in, subscribed): the next beacons carry it.
    public func setViewerPlan(_ plan: String?, status: String? = nil, category: String? = nil) {
        config.viewerPlan = plan
        config.viewerPlanStatus = status
        config.viewerPlanCategory = category
    }

    public func add(_ view: ViewTracker) {
        guard !disabled else { return }
        views.append(view)
        if timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: config.interval, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
        }
    }

    /// Runs before every beacon: monitors read the player's position there.
    func setBeforeBeacon(_ owner: AnyObject, _ block: (() -> Void)?) {
        beforeBeacon[ObjectIdentifier(owner)] = block
    }

    func tick() {
        if views.isEmpty || disabled {
            timer?.invalidate()
            timer = nil
            return
        }
        flush()
    }

    /// Where beacons go: the beacon domain when set, else apiBase.
    static func base(_ config: DataConfig) -> URL {
        guard let domain = config.beaconDomain?.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "")
            .split(separator: "/").first, !domain.isEmpty, let url = URL(string: "https://\(domain)") else { return config.apiBase }
        return url
    }

    /// Sends now. One beacon at a time; a call during one sends again when it is back.
    public func flush() {
        guard !disabled, !views.isEmpty else { return }
        if inFlight {
            again = true
            return
        }
        inFlight = true
        beforeBeacon.values.forEach { $0() }
        let sending = Array(views.prefix(maxViews))
        let snapshots = sending.map { $0.snapshot(maxEvents: maxEvents) }
        let body: [String: Any] = [
            "sdk": ["name": sdkName, "version": sdkVersion],
            "session_id": sessionID,
            "viewer": ["device_id": deviceID, "user_id": config.userID ?? "", "plan": config.viewerPlan ?? "",
                       "plan_status": config.viewerPlanStatus ?? "", "plan_category": config.viewerPlanCategory ?? ""],
            // The network can change during the session; a device given in tests keeps its own.
            "device": device.merging(["connection": Connection.shared.current]) { given, _ in given },
            "views": snapshots,
        ]
        var request = URLRequest(url: Self.base(config).appendingPathComponent(beaconPath))
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(config.key, forHTTPHeaderField: "X-Tenant-Key")
        #if os(tvOS)
        request.setValue("tvos", forHTTPHeaderField: "X-Platform")
        #else
        request.setValue("ios", forHTTPHeaderField: "X-Platform")
        #endif
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        send(request) { [weak self] result in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.finished(sending, snapshots, result) }
            }
        }
    }

    private func finished(_ sending: [ViewTracker], _ snapshots: [[String: Any]], _ result: BeaconResponse?) {
        inFlight = false
        if let result {
            // 413: too big to ever go through, so its events are dropped (the totals still go next time).
            if (result.status < 300 && result.enabled != false) || result.status == 413 {
                for (index, view) in sending.enumerated() {
                    view.sent((snapshots[index]["events"] as? [Any])?.count ?? 0)
                    // Only once the backend has the view's end: it may have ended while this beacon was out.
                    if snapshots[index]["ended"] as? Bool == true { views.removeAll { $0 === view } }
                }
            } else if result.status < 300 || [400, 401, 403, 404, 422].contains(result.status) {
                disabled = true
                views.removeAll()
                timer?.invalidate()
                timer = nil
            }
            // 429, 5xx: the events go with the next beacon.
        }
        // Offline (nil): the same.
        if again && !disabled {
            again = false
            flush()
        }
    }
}

private let urlSessionSend: BeaconSender = { request, done in
    URLSession.shared.dataTask(with: request) { data, response, _ in
        guard let http = response as? HTTPURLResponse else { return done(nil) }
        let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        done(BeaconResponse(status: http.statusCode, enabled: http.statusCode < 300 ? json?["enabled"] as? Bool : nil))
    }.resume()
}

private func storedDeviceID() -> String {
    if let known = UserDefaults.standard.string(forKey: deviceKey) { return known }
    let fresh = UUID().uuidString.lowercased()
    UserDefaults.standard.set(fresh, forKey: deviceKey)
    return fresh
}

/// The network the device is on, kept current in the background.
private final class Connection: @unchecked Sendable {
    static let shared = Connection()
    private let monitor = NWPathMonitor()
    private let lock = NSLock()
    private var kind = ""

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let kind = path.status != .satisfied ? "" : path.usesInterfaceType(.wifi) ? "wifi"
                : path.usesInterfaceType(.cellular) ? "cellular" : path.usesInterfaceType(.wiredEthernet) ? "ethernet" : "other"
            self?.lock.lock()
            self?.kind = kind
            self?.lock.unlock()
        }
        monitor.start(queue: DispatchQueue(label: "unifiedplay-data.connection"))
    }

    var current: String {
        lock.lock()
        defer { lock.unlock() }
        return kind
    }
}

@MainActor
private func appleDevice(appVersion: String?) -> [String: String] {
    var system = utsname()
    uname(&system)
    let model = withUnsafeBytes(of: &system.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    #if canImport(UIKit)
    let os = UIDevice.current.systemName
    let osVersion = UIDevice.current.systemVersion
    let category: String
    switch UIDevice.current.userInterfaceIdiom {
    case .tv: category = "tv"
    case .pad: category = "tablet"
    case .phone: category = "phone"
    case .mac: category = "desktop"
    default: category = ""
    }
    #else
    let os = "macOS"
    let osVersion = ProcessInfo.processInfo.operatingSystemVersionString
    let category = "desktop"
    #endif
    return [
        "category": category,
        "os": os,
        "os_version": osVersion,
        "manufacturer": "Apple",
        "model": model,
        "app_id": Bundle.main.bundleIdentifier ?? "",
        "app_version": appVersion ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""),
    ]
}

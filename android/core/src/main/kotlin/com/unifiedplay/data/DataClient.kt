package com.unifiedplay.data

import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executor
import java.util.concurrent.Executors

const val SDK_NAME = "unifiedplay-data-android"
const val SDK_VERSION = "1.1.1"
const val DEFAULT_API_BASE = "https://backend.unifiedplay.com"
private const val BEACON_PATH = "/api/v1/data/beacons"
private const val PREFS = "unifiedplay-data"
private const val DEVICE_KEY = "device_id"
// A beacon carries at most this much, far under the backend's 64 KB; the rest goes with the next ones.
private const val MAX_VIEWS = 10
private const val MAX_EVENTS = 25

data class DataConfig(
    /** Your data key (up_data_…) from the Console's Video data page, or a UnifiedPlay app's tenant key. */
    val key: String,
    /** Where beacons go. Defaults to UnifiedPlay. */
    val apiBase: String = DEFAULT_API_BASE,
    /**
     * Your own beacon host (data.example.com), set up in the Console's Video data page: beacons go
     * to https://{beaconDomain}, which blockers of other sites' hosts let through. Wins over apiBase.
     */
    val beaconDomain: String? = null,
    /** Defaults to the app's versionName. */
    val appVersion: String = "",
    /**
     * Your own id for the viewer, if you want views per viewer: an opaque id, never an email.
     * (UnifiedPlay's own apps send the viewer's usr_ id, kept only with analytics consent.)
     */
    val userId: String? = null,
    /** Your own words for the viewer's plan, for breakdowns: plan ("premium"), its status ("trialing"), its category ("sports"). */
    val viewerPlan: String? = null,
    val viewerPlanStatus: String? = null,
    val viewerPlanCategory: String? = null,
    val intervalMs: Long = 10_000,
)

/** What the backend answered: the HTTP status and, when it said so, whether Video data is on. */
data class BeaconResponse(val status: Int, val enabled: Boolean? = null)

/**
 * Sends the views of every monitored player in one beacon: every 10 s, and right away on key
 * moments. Runs on the main thread; only the request itself goes to a background thread.
 */
class DataClient internal constructor(
    private var config: DataConfig,
    private val device: Map<String, String>,
    private val deviceId: String,
    private val send: (url: String, key: String, body: String) -> BeaconResponse,
    private val onMain: (delayMs: Long, block: () -> Unit) -> Unit,
    private val io: Executor,
) {
    constructor(context: Context, config: DataConfig) : this(
        config,
        androidDevice(context, config.appVersion),
        storedDeviceId(context),
        ::httpPost,
        mainHandler(),
        Executors.newSingleThreadExecutor(),
    )

    private val views = LinkedHashSet<ViewTracker>()
    private val beforeBeacon = mutableListOf<() -> Unit>()
    private val sessionId = UUID.randomUUID().toString()
    private var ticking = false
    private var inFlight = false
    private var again = false

    /** Off for this app run: the tenant has Video data off, or the key is wrong. */
    var disabled = false
        private set

    fun setUserId(userId: String?) {
        config = config.copy(userId = userId)
    }

    /** The viewer's plan changed (signed in, subscribed): the next beacons carry it. */
    fun setViewerPlan(plan: String?, status: String? = null, category: String? = null) {
        config = config.copy(viewerPlan = plan, viewerPlanStatus = status, viewerPlanCategory = category)
    }

    fun add(view: ViewTracker) {
        if (disabled) return
        views += view
        if (!ticking) {
            ticking = true
            onMain(config.intervalMs, ::tick)
        }
    }

    /** Runs before every beacon, on the main thread: monitors read the player's position there. */
    fun beforeBeacon(block: () -> Unit) {
        beforeBeacon += block
    }

    fun removeBeforeBeacon(block: () -> Unit) {
        beforeBeacon -= block
    }

    private fun tick() {
        if (views.isEmpty() || disabled) {
            ticking = false
            return
        }
        flush()
        onMain(config.intervalMs, ::tick)
    }

    /** Sends now. One beacon at a time; a call during one sends again when it is back. */
    fun flush() {
        if (disabled || views.isEmpty()) return
        if (inFlight) {
            again = true
            return
        }
        inFlight = true
        beforeBeacon.toList().forEach { it() }
        val sending = views.take(MAX_VIEWS)
        val snapshots = sending.map { it.snapshot(MAX_EVENTS) }
        val body = JSONObject(
            mapOf(
                "sdk" to mapOf("name" to SDK_NAME, "version" to SDK_VERSION),
                "session_id" to sessionId,
                "viewer" to mapOf(
                    "device_id" to deviceId, "user_id" to (config.userId ?: ""),
                    "plan" to config.viewerPlan, "plan_status" to config.viewerPlanStatus, "plan_category" to config.viewerPlanCategory,
                ),
                "device" to device,
                "views" to snapshots,
            ),
        ).toString()
        val base = config.beaconDomain?.takeIf { it.isNotBlank() }
            ?.let { "https://" + it.removePrefix("https://").removePrefix("http://").substringBefore('/') } ?: config.apiBase
        val url = base.trimEnd('/') + BEACON_PATH
        val key = config.key
        io.execute {
            val result = runCatching { send(url, key, body) }.getOrNull()
            onMain(0) { finished(sending, snapshots, result) }
        }
    }

    private fun finished(sending: List<ViewTracker>, snapshots: List<Map<String, Any?>>, result: BeaconResponse?) {
        inFlight = false
        when {
            result == null -> Unit // offline: the events go with the next beacon
            // 413: too big to ever go through, so its events are dropped (the totals still go next time).
            (result.status < 300 && result.enabled != false) || result.status == 413 -> sending.forEachIndexed { index, view ->
                @Suppress("UNCHECKED_CAST")
                view.sent((snapshots[index]["events"] as List<*>).size)
                // Only once the backend has the view's end: it may have ended while this beacon was out.
                if (snapshots[index]["ended"] == true) views -= view
            }
            result.status < 300 || result.status in setOf(400, 401, 403, 404, 422) -> {
                disabled = true
                views.clear()
            }
            else -> Unit // 429, 5xx: the events go with the next beacon
        }
        if (again && !disabled) {
            again = false
            flush()
        }
    }
}

private fun mainHandler(): (Long, () -> Unit) -> Unit {
    val handler = Handler(Looper.getMainLooper())
    return { delay, block -> handler.postDelayed(block, delay) }
}

private fun storedDeviceId(context: Context): String {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    return prefs.getString(DEVICE_KEY, null) ?: UUID.randomUUID().toString().also { prefs.edit().putString(DEVICE_KEY, it).apply() }
}

@SuppressLint("MissingPermission") // ACCESS_NETWORK_STATE is in the SDK's manifest
private fun androidDevice(context: Context, appVersion: String): Map<String, String> {
    val connection = runCatching {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork)
        when {
            capabilities == null -> ""
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
    }.getOrDefault("")
    val version = appVersion.ifEmpty {
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName.orEmpty() }.getOrDefault("")
    }
    val tv = context.packageManager.hasSystemFeature("android.software.leanback")
    val category = when {
        tv -> "tv"
        context.resources.configuration.smallestScreenWidthDp >= 600 -> "tablet"
        else -> "phone"
    }
    return mapOf(
        "category" to category,
        "os" to if (tv) "Android TV" else "Android",
        "os_version" to Build.VERSION.RELEASE.orEmpty(),
        "manufacturer" to Build.MANUFACTURER.orEmpty(),
        "model" to Build.MODEL.orEmpty(),
        "app_id" to context.packageName,
        "app_version" to version,
        "connection" to connection,
    )
}

private fun httpPost(url: String, key: String, body: String): BeaconResponse {
    val connection = URL(url).openConnection() as HttpURLConnection
    try {
        connection.requestMethod = "POST"
        connection.connectTimeout = 10_000
        connection.readTimeout = 10_000
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        connection.setRequestProperty("X-Tenant-Key", key)
        connection.setRequestProperty("X-Platform", "android")
        connection.outputStream.use { it.write(body.toByteArray()) }
        val status = connection.responseCode
        val enabled = if (status < 300) {
            runCatching { JSONObject(connection.inputStream.bufferedReader().use { it.readText() }).optBoolean("enabled", true) }.getOrNull()
        } else null
        return BeaconResponse(status, enabled)
    } finally {
        connection.disconnect()
    }
}

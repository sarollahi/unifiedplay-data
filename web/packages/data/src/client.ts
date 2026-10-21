import type { ViewTracker } from './tracker.js'

export const SDK_NAME = 'unifiedplay-data-web'
export const SDK_VERSION = '1.1.0'
export const DEFAULT_API_BASE = 'https://backend.unifiedplay.com'
const BEACON_PATH = '/api/v1/data/beacons'
// A beacon carries at most this much, far under the backend's 64 KB; the rest goes with the next ones.
const MAX_VIEWS = 10
const MAX_EVENTS = 25
const DEVICE_KEY = 'unifiedplay-data-device'

export interface DataConfig {
  /** Your data key (up_data_…) from the Console's Video data page, or a UnifiedPlay site's tenant key. */
  key: string
  /** Where beacons go. Defaults to UnifiedPlay; '' sends to the page's own origin. */
  apiBase?: string
  /**
   * Your own beacon host (data.example.com), set up in the Console's Video data page: beacons go
   * to https://{beaconDomain}, which blockers of other sites' hosts let through. Wins over apiBase.
   */
  beaconDomain?: string
  appVersion?: string
  /** What the beacons say they come from; by default tizen, webos or chromecast on those TVs, else web. */
  platform?: string
  /** A device id the app keeps (React Native and TVs without local storage); by default one kept in localStorage. */
  deviceId?: string
  /** Device fields the browser cannot tell (os, os_version, manufacturer, model, app_id…), over what it does tell. */
  device?: Record<string, string>
  /**
   * Your own id for the viewer, if you want views per viewer: an opaque id, never an email.
   * (UnifiedPlay's own apps send the viewer's usr_ id, kept only with analytics consent.)
   */
  userId?: string
  intervalMs?: number
}

type Send = (url: string, body: string) => Promise<{ status: number; enabled?: boolean }>

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
}

function deviceId(): string {
  try {
    const known = localStorage.getItem(DEVICE_KEY)
    if (known) return known
    const fresh = randomId()
    localStorage.setItem(DEVICE_KEY, fresh)
    return fresh
  } catch {
    return randomId() // private mode: one id per page load
  }
}

function match(ua: string, pattern: RegExp): string {
  return pattern.exec(ua)?.[1]?.replace(/_/g, '.') ?? ''
}

/** web, or tizen, webos or chromecast when the page runs on one of those TVs. */
export function webPlatform(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent ?? ''): string {
  return /Tizen/.test(ua) ? 'tizen' : /Web0S|webOS/.test(ua) ? 'webos' : /CrKey/.test(ua) ? 'chromecast' : 'web'
}

/** What the browser tells about itself. */
export function webDevice(nav: Navigator = navigator): Record<string, string> {
  const ua = nav.userAgent
  const [browser, browserVersion] =
    /Edg\//.test(ua) ? ['Edge', match(ua, /Edg\/([\d.]+)/)]
      : /OPR\//.test(ua) ? ['Opera', match(ua, /OPR\/([\d.]+)/)]
        : /Firefox\//.test(ua) ? ['Firefox', match(ua, /Firefox\/([\d.]+)/)]
          : /(Chrome|CriOS)\//.test(ua) ? ['Chrome', match(ua, /(?:Chrome|CriOS)\/([\d.]+)/)]
            : /Safari\//.test(ua) ? ['Safari', match(ua, /Version\/([\d.]+)/)]
              : ['', '']
  const [os, osVersion] =
    /Tizen/.test(ua) ? ['Tizen', match(ua, /Tizen ([\d.]+)/)]
      : /Web0S|webOS/.test(ua) ? ['webOS', match(ua, /Web0S(?:\.TV)?-?([\d.]+)?/)]
        : /CrKey/.test(ua) ? ['Cast', match(ua, /CrKey\/([\d.]+)/)]
          : /iPhone|iPad|iPod/.test(ua) ? ['iOS', match(ua, /OS ([\d_]+)/)]
      : /Android/.test(ua) ? ['Android', match(ua, /Android ([\d.]+)/)]
        : /Mac OS X/.test(ua) ? ['macOS', match(ua, /Mac OS X ([\d_.]+)/)]
          : /Windows/.test(ua) ? ['Windows', match(ua, /Windows NT ([\d.]+)/)]
            : /CrOS/.test(ua) ? ['ChromeOS', ''] : /Linux/.test(ua) ? ['Linux', ''] : ['', '']
  const connection = (nav as Navigator & { connection?: { type?: string; effectiveType?: string } }).connection
  return {
    os, os_version: osVersion, browser, browser_version: browserVersion,
    model: /Tizen|Web0S|webOS|SMART-TV|CrKey/.test(ua) ? 'TV' : /Mobi|Android|iPhone/.test(ua) ? 'Mobile' : /iPad|Tablet/.test(ua) ? 'Tablet' : 'Desktop',
    connection: connection?.type ?? connection?.effectiveType ?? '',
    app_id: typeof location === 'undefined' ? '' : location.hostname,
  }
}

const fetchSend: Send = async (url, body) => {
  // text/plain keeps it a simple request (no preflight); keepalive lets it outlive a closing page.
  const response = await fetch(url, { method: 'POST', body, keepalive: body.length < 60_000, headers: { 'Content-Type': 'text/plain' } })
  const json = response.ok ? await response.json().catch(() => ({})) as { enabled?: boolean } : {}
  return { status: response.status, enabled: json.enabled }
}

/** Sends the views of every monitored player in one beacon: every 10 s, and right away on key moments. */
export class DataClient {
  private readonly views = new Set<ViewTracker>()
  private readonly sessionId = randomId()
  private readonly deviceId: string
  private readonly device: Record<string, string>
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight = false
  private again = false
  /** Off for this session: the tenant has Video data off, or the key is wrong. */
  disabled = false

  constructor(private readonly config: DataConfig, private readonly send: Send = fetchSend) {
    this.deviceId = config.deviceId || deviceId()
    this.device = { ...(typeof navigator === 'undefined' ? {} : webDevice()), app_version: config.appVersion ?? '', ...config.device }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void this.flush() })
      window.addEventListener('pagehide', () => { for (const view of this.views) view.end(); void this.flush() })
    }
  }

  setUserId(userId: string | undefined): void {
    this.config.userId = userId
  }

  add(view: ViewTracker): void {
    if (this.disabled) return
    this.views.add(view)
    this.timer ??= setInterval(() => void this.flush(), this.config.intervalMs ?? 10_000)
  }

  /** Sends now. One beacon at a time; a call during one sends again when it is back. */
  async flush(): Promise<void> {
    if (this.disabled || !this.views.size) return
    if (this.inFlight) { this.again = true; return }
    this.inFlight = true
    const views = [...this.views].slice(0, MAX_VIEWS)
    const snapshots = views.map(view => view.snapshot(MAX_EVENTS))
    const body = JSON.stringify({
      key: this.config.key,
      platform: this.config.platform ?? webPlatform(),
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      session_id: this.sessionId,
      viewer: { device_id: this.deviceId, user_id: this.config.userId ?? '' },
      device: this.device,
      views: snapshots,
    })
    try {
      const base = this.config.beaconDomain ? `https://${this.config.beaconDomain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}` : (this.config.apiBase ?? DEFAULT_API_BASE)
      const result = await this.send(`${base.replace(/\/$/, '')}${BEACON_PATH}`, body)
      // 413: too big to ever go through, so its events are dropped (the totals still go next time).
      if ((result.status < 300 && result.enabled !== false) || result.status === 413) {
        views.forEach((view, index) => {
          view.sent(snapshots[index].events.length)
          // Only once the backend has the view's end: it may have ended while this beacon was out.
          if (snapshots[index].ended) this.views.delete(view)
        })
      } else if (result.status < 300 || [400, 401, 403, 404, 422].includes(result.status)) {
        this.stop()
      }
      // 429, 5xx: the events stay and go with the next beacon.
    } catch {
      // Offline: the same.
    } finally {
      this.inFlight = false
      if (!this.views.size && this.timer) { clearInterval(this.timer); this.timer = null }
      if (this.again && !this.disabled) { this.again = false; void this.flush() }
    }
  }

  private stop(): void {
    this.disabled = true
    this.views.clear()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

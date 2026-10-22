import { describe, expect, it, vi } from 'vitest'

import { DataClient, monitorVideo, ViewTracker, type VideoMonitor } from '../src/index.js'
import { trackHlsJs } from '../../data-hlsjs/src/index.js'
import { trackShaka } from '../../data-shaka/src/index.js'
import { trackDashJs } from '../../data-dashjs/src/index.js'
import { monitorVideoJs } from '../../data-videojs/src/index.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...args: any[]) => void
function hub() {
  const listeners = new Map<string, Set<Listener>>()
  return {
    on: (type: string, listener: Listener) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener) },
    off: (type: string, listener: Listener) => { listeners.get(type)?.delete(listener) },
    emit: (type: string, ...args: unknown[]) => { for (const listener of listeners.get(type) ?? []) listener(...args) },
  }
}

function spyMonitor() {
  return { rendition: vi.fn(), error: vi.fn(), requestCompleted: vi.fn(), requestFailed: vi.fn(), requestCanceled: vi.fn(), setDrmType: vi.fn(), playbackMode: vi.fn() } as unknown as VideoMonitor & Record<string, ReturnType<typeof vi.fn>>
}

describe('the view tracker (spec: Requests)', () => {
  it('adds up media requests, counts failures by type, and names the CDN from X-CDN', () => {
    let now = 0
    const view = new ViewTracker({ id: 'v', viewSessionId: 'cmcd-1' }, { name: 'test' }, () => now)
    view.requestCompleted({ type: 'manifest', start: 0, responseStart: 50, responseEnd: 80, bytes: 2_000, headers: { 'X-CDN': 'fastly' } })
    view.requestCompleted({ type: 'video', start: 100, responseStart: 140, responseEnd: 1100, bytes: 1_250_000 })
    view.requestCompleted({ type: 'audio', start: 100, responseStart: 160, responseEnd: 600, bytes: 125_000, headers: name => name === 'x-cdn' ? 'cloudflare' : null })
    view.requestCompleted({ type: 'video_init', start: 0, responseEnd: 10, bytes: 900 }) // not a media request
    view.requestFailed({ type: 'video', hostname: 'cdn.example.com', error: 'fragLoadError', errorCode: 503 })
    view.requestFailed({ type: 'encryption', hostname: 'license.example.com', errorCode: 403 })
    view.requestCanceled({ type: 'audio' })
    view.playbackMode('fullscreen')
    view.playbackMode('fullscreen')
    view.playbackMode('standard')
    view.setPage({ type: 'iframe', url: 'https://www.example.com/watch' })
    now = 2000
    const snapshot = view.snapshot()
    expect(snapshot.metrics).toMatchObject({
      request_completed: 4, request_failed: 2, request_canceled: 1,
      request_failed_media: 1, request_failed_encryption: 1, request_failed_manifest: 0,
      request_media_completed: 2, request_media_bytes: 1_375_000, request_media_ms: 1500,
      request_media_ttfb_ms: 100, request_media_ttfb_count: 2, request_media_max_ttfb_ms: 60,
    })
    expect(snapshot.video.cdn).toBe('cloudflare') // the latest header wins
    expect(snapshot.player).toMatchObject({ fullscreen: true, pip: false })
    expect(snapshot.page).toEqual({ type: 'iframe', url: 'https://www.example.com/watch' })
    expect(snapshot.view_session_id).toBe('cmcd-1')
    const types = snapshot.events.map(event => event.type)
    expect(types.filter(type => type === 'cdnchange')).toHaveLength(2)
    expect(types.filter(type => type === 'playbackmodechange')).toHaveLength(2) // fullscreen, standard
    expect(snapshot.events.find(event => event.type === 'requestfailed')?.data).toEqual({ type: 'video', hostname: 'cdn.example.com', error: 'fragLoadError', code: 503, text: null })
  })

  it('keeps a CDN the app set, and DRM from the player', () => {
    const view = new ViewTracker({ id: 'v', cdn: 'akamai' }, { name: 'test' })
    view.requestCompleted({ type: 'video', headers: { 'x-cdn': 'fastly' } })
    view.setDrmType('widevine')
    expect(view.snapshot().video).toMatchObject({ cdn: 'akamai', drm_type: 'widevine' })
  })
})

describe('the HTML5 monitor', () => {
  it('puts requests from before the view into it, and sees fullscreen, page and beacon domain', async () => {
    const send = vi.fn(async () => ({ status: 202, enabled: true }))
    const client = new DataClient({ key: 'up_data_test', beaconDomain: 'https://data.example.com/' }, send)
    const element = document.createElement('video')
    document.body.append(element)
    const monitor = monitorVideo(client, element, { id: 'v' })
    element.dispatchEvent(new Event('loadstart'))
    monitor.requestCompleted({ type: 'manifest', bytes: 500 })
    monitor.setDrmType('playready')
    for (const name of ['play', 'playing']) element.dispatchEvent(new Event(name))
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => element })
    document.dispatchEvent(new Event('fullscreenchange'))
    await client.flush()
    const [url, body] = send.mock.calls.at(-1) as unknown as [string, string]
    expect(url).toBe('https://data.example.com/api/v1/data/beacons')
    const view = JSON.parse(body).views[0]
    expect(view.metrics.request_completed).toBe(1)
    expect(view.video.drm_type).toBe('playready')
    expect(view.player.fullscreen).toBe(true)
    expect(view.page).toEqual({ type: 'watchpage', url: 'http://localhost:3000/' })
    Reflect.deleteProperty(document, 'fullscreenElement')
  })
})

describe('streaming libraries report their requests', () => {
  it('hls.js: segments with timings and headers, keys with their DRM, load errors', () => {
    const monitor = spyMonitor()
    const events = hub()
    trackHlsJs(monitor, { levels: [], ...events })
    const stats = { loaded: 1000, loading: { start: 10, first: 30, end: 110 } }
    const xhr = { getResponseHeader: (name: string) => name === 'x-cdn' ? 'fastly' : null }
    events.emit('hlsFragLoaded', 'hlsFragLoaded', { frag: { type: 'audio', sn: 4, url: 'https://cdn.example.com/a/4.ts', stats }, part: null, networkDetails: xhr })
    events.emit('hlsKeyLoaded', 'hlsKeyLoaded', { frag: {}, keyInfo: { decryptdata: { keyFormat: 'com.apple.streamingkeydelivery', uri: 'skd://k' } } })
    events.emit('hlsError', 'hlsError', { type: 'networkError', details: 'fragLoadError', fatal: false, frag: { type: 'main', sn: 'initSegment', url: 'https://cdn.example.com/init.mp4' }, response: { code: 404, text: 'Not Found' } })
    const completed = vi.mocked(monitor.requestCompleted).mock.calls[0][0]
    expect(completed).toMatchObject({ type: 'audio', hostname: 'cdn.example.com', bytes: 1000, start: 10, responseStart: 30, responseEnd: 110 })
    expect((completed.headers as (name: string) => string)('x-cdn')).toBe('fastly')
    expect(monitor.setDrmType).toHaveBeenCalledWith('fairplay')
    expect(monitor.requestFailed).toHaveBeenCalledWith({ type: 'video_init', hostname: 'cdn.example.com', error: 'fragLoadError', errorCode: 404, errorText: 'Not Found' })
  })

  it('dash.js 5: every response through its interceptor; dash.js 4: its segment events', async () => {
    const monitor = spyMonitor()
    const events = hub()
    let interceptor: ((response: unknown) => Promise<unknown>) | undefined
    trackDashJs(monitor, { ...events, addResponseInterceptor: fn => { interceptor = fn as typeof interceptor }, removeResponseInterceptor: vi.fn() })
    const timing = { startTime: 100, responseStart: 130, duration: 400, encodedBodySize: 50_000 }
    await interceptor!({ request: { url: 'https://cdn.example.com/v/1.m4s', customData: { request: { type: 'MediaSegment', mediaType: 'video' } } }, status: 200, headers: { 'x-cdn': 'akamai' }, resourceTiming: timing })
    await interceptor!({ request: { url: 'https://cdn.example.com/manifest.mpd', customData: { request: { type: 'MPD' } } }, status: 503, statusText: 'Unavailable' })
    events.emit('public_keySystemSelected', { data: { keySystem: { systemString: 'com.widevine.alpha' } } })
    expect(monitor.requestCompleted).toHaveBeenCalledWith(expect.objectContaining({ type: 'video', bytes: 50_000, start: 100, responseStart: 130, responseEnd: 500 }))
    expect(monitor.requestFailed).toHaveBeenCalledWith({ type: 'manifest', hostname: 'cdn.example.com', error: 'HTTP', errorCode: 503, errorText: 'Unavailable' })
    expect(monitor.setDrmType).toHaveBeenCalledWith('widevine')

    const older = spyMonitor()
    const oldEvents = hub()
    trackDashJs(older, oldEvents)
    oldEvents.emit('fragmentLoadingCompleted', { request: { type: 'MediaSegment', mediaType: 'audio', url: 'https://cdn.example.com/a/1.m4s', startDate: new Date(1000), firstByteDate: new Date(1020), requestEndDate: new Date(1200), bytesLoaded: 9000 } })
    oldEvents.emit('error', { error: { code: 27, message: 'segment', data: { request: { url: 'https://cdn.example.com/v/2.m4s' } } } })
    expect(older.requestCompleted).toHaveBeenCalledWith(expect.objectContaining({ type: 'audio', start: 1000, responseStart: 1020, responseEnd: 1200, bytes: 9000 }))
    expect(older.requestFailed).toHaveBeenCalledWith(expect.objectContaining({ type: 'video', hostname: 'cdn.example.com', error: '27' }))
  })

  it('Shaka: responses through its networking engine, network errors as failed requests', () => {
    const monitor = spyMonitor()
    const events = hub()
    let filter: ((type: number, response: unknown, context?: unknown) => void) | undefined
    const engine = { registerResponseFilter: (fn: typeof filter) => { filter = fn }, unregisterResponseFilter: vi.fn() }
    trackShaka(monitor, { addEventListener: events.on, removeEventListener: events.off, getVariantTracks: () => [], getNetworkingEngine: () => engine as never, drmInfo: () => ({ keySystem: 'com.microsoft.playready' }) })
    filter!(1, { uri: 'https://cdn.example.com/v/3.mp4', data: new ArrayBuffer(4096), headers: { 'x-cdn': 'cloudfront' }, timeMs: 250 }, { type: 1, stream: { type: 'video' } })
    filter!(2, { uri: 'https://license.example.com/', data: new ArrayBuffer(10), timeMs: 40 })
    events.emit('trackschanged')
    events.emit('error', { detail: { category: 1, code: 1001, severity: 1, data: ['https://cdn.example.com/v/4.mp4', 502, '', {}, 1] } })
    expect(monitor.requestCompleted).toHaveBeenCalledWith(expect.objectContaining({ type: 'video', bytes: 4096, start: 0, responseEnd: 250 }))
    expect(monitor.requestCompleted).toHaveBeenCalledWith(expect.objectContaining({ type: 'encryption' }))
    expect(monitor.requestFailed).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'cdn.example.com', error: '1001', errorCode: 502 }))
    expect(monitor.setDrmType).toHaveBeenCalledWith('playready')
  })

  it('Video.js: its streaming engine’s requests', async () => {
    const send = vi.fn(async () => ({ status: 202, enabled: true }))
    const client = new DataClient({ apiBase: '', key: 'up_data_test' }, send)
    const container = document.createElement('div')
    const element = document.createElement('video')
    container.append(element)
    const events = hub()
    const hooks = new Set<(...args: unknown[]) => void>()
    const vhs = { xhr: { onResponse: (fn: (...args: unknown[]) => void) => hooks.add(fn), offResponse: (fn: (...args: unknown[]) => void) => hooks.delete(fn) } }
    monitorVideoJs(client, { el: () => container, ...events, error: () => null, tech: () => ({ vhs }) as never }, { id: 'v' })
    for (const name of ['loadstart', 'play', 'playing']) element.dispatchEvent(new Event(name))
    for (const hook of hooks) {
      hook({ uri: 'https://cdn.example.com/s/1.ts', requestType: 'segment', requestTime: Date.now() - 100, response: new ArrayBuffer(2048) }, null, { statusCode: 200, headers: { 'x-cdn': 'bunny' } })
      hook({ uri: 'https://cdn.example.com/s/2.ts', requestType: 'segment', requestTime: Date.now() }, null, { statusCode: 404 })
      hook({ uri: 'https://cdn.example.com/s/3.ts', requestType: 'segment', aborted: true }, null, undefined)
    }
    await client.flush()
    const view = JSON.parse((send.mock.calls.at(-1) as unknown as [string, string])[1]).views[0]
    expect(view.metrics).toMatchObject({ request_completed: 1, request_failed: 1, request_canceled: 1, request_media_bytes: 2048, request_failed_media: 1 })
    expect(view.video.cdn).toBe('bunny')
  })
})

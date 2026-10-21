import { describe, expect, it, vi } from 'vitest'

import { DataClient, monitorVideo, ViewTracker, webDevice } from '../src/index.js'

function clock() {
  let time = 0
  return { now: () => time, advance: (ms: number) => { time += ms } }
}

describe('ViewTracker', () => {
  it('splits time into startup, playing, rebuffering and seeking', () => {
    const c = clock()
    const view = new ViewTracker({ id: 'ep_1' }, { name: 'test' }, c.now)
    view.playerStartup(100)
    view.play(); c.advance(800); view.playing()
    c.advance(5000); view.bufferingStart(); c.advance(1200); view.bufferingEnd()
    c.advance(3000); view.seeking(); c.advance(400); view.seeked(false); c.advance(100); view.playing()
    c.advance(2000); view.pause(); c.advance(10_000)
    const snapshot = view.snapshot()
    expect(snapshot.metrics).toMatchObject({
      player_startup_ms: 100, video_startup_ms: 800, rebuffer_count: 1, rebuffer_ms: 1200, seek_count: 1, seek_ms: 500,
      playing_ms: 10_000, watch_ms: 800 + 10_000 + 1200 + 500,
    })
    expect(snapshot.events.map(event => event.type)).toEqual([
      'viewstart', 'play', 'playing', 'rebufferstart', 'rebufferend', 'playing', 'seeking', 'seeked', 'playing', 'pause',
    ])
  })

  it('counts a stall before the first frame as startup, and a seek to the resume point too', () => {
    const c = clock()
    const view = new ViewTracker({}, { name: 'test' }, c.now)
    view.play(); view.seeking(); view.bufferingStart(); c.advance(2000); view.playing()
    const { metrics } = view.snapshot()
    expect(metrics).toMatchObject({ video_startup_ms: 2000, rebuffer_count: 0, seek_count: 0, watch_ms: 2000 })
  })

  it('weights bitrate by playing time and measures upscaling', () => {
    const c = clock()
    const view = new ViewTracker({}, { name: 'test' }, c.now)
    view.playerSize(1080, 1920)
    view.rendition(1000, 540, 960)
    view.play(); view.playing()
    c.advance(3000); view.rendition(4000, 1080, 1920); c.advance(1000)
    const { metrics } = view.snapshot()
    expect(metrics).toMatchObject({ avg_bitrate_kbps: 1750, max_bitrate_kbps: 4000, upscale_ms: 3000, downscale_ms: 0, max_upscale_pct: 100, rendition_changes: 1 })
  })

  it('ends on a fatal error and keeps unsent events', () => {
    const view = new ViewTracker({}, { name: 'test' }, clock().now)
    view.play()
    view.failed('2004', 'Source error')
    const first = view.snapshot()
    expect(first).toMatchObject({ ended: true, error: { code: '2004', message: 'Source error', fatal: true }, seq: 1 })
    view.sent(2)
    expect(view.snapshot()).toMatchObject({ seq: 2, events: [{ type: 'error' }, { type: 'viewend' }] })
  })
})

describe('ads', () => {
  it('keeps ad time out of the video and a pre-roll out of startup', () => {
    const c = clock()
    const view = new ViewTracker({ custom: { 1: 'experiment-b' } }, { name: 'test' }, c.now)
    view.adBreakStart(); view.adStart(); view.adPlaying()
    c.advance(15_000); view.adEnd(); view.adStart(); view.adError('1009', 'VAST empty'); view.adBreakEnd()
    c.advance(500); view.playing()
    c.advance(10_000); view.adBreakStart(); view.playing(); view.bufferingStart(); view.adStart(); view.adPlaying()
    c.advance(5_000); view.adEnd(); view.adBreakEnd(); c.advance(100); view.playing(); c.advance(1_000)
    const snapshot = view.snapshot()
    expect(snapshot.metrics).toMatchObject({
      video_startup_ms: 500, ad_break_count: 2, ad_count: 3, ad_error_count: 1, ad_watch_ms: 20_000,
      playing_ms: 11_000, watch_ms: 500 + 11_000, rebuffer_count: 0,
    })
    expect(snapshot.custom).toEqual({ 1: 'experiment-b' })
    expect(snapshot.events.map(event => event.type)).toContain('aderror')
  })
})

describe('DataClient', () => {
  it('sends every open view with the key in the body and drops sent events', async () => {
    const send = vi.fn(async () => ({ status: 202, enabled: true }))
    const client = new DataClient({ apiBase: 'https://api.example.test/', key: 'key-1', userId: 'usr_1' }, send)
    const view = new ViewTracker({ id: 'ep_1' }, { name: 'test' })
    client.add(view)
    await client.flush()
    const [url, body] = send.mock.calls[0] as unknown as [string, string]
    expect(url).toBe('https://api.example.test/api/v1/data/beacons')
    const beacon = JSON.parse(body)
    expect(beacon).toMatchObject({ key: 'key-1', platform: 'web', viewer: { user_id: 'usr_1' }, sdk: { name: 'unifiedplay-data-web' } })
    expect(beacon.views[0].events.map((event: { type: string }) => event.type)).toEqual(['viewstart'])
    await client.flush()
    expect(JSON.parse((send.mock.calls[1] as unknown as [string, string])[1]).views[0].events).toEqual([])
  })

  it('sends 25 events of a view per beacon, and drops a beacon the backend finds too big', async () => {
    const send = vi.fn(async () => ({ status: 202, enabled: true }))
    const client = new DataClient({ apiBase: '', key: 'k' }, send)
    const view = new ViewTracker({}, { name: 'test' })
    for (let index = 0; index < 15; index += 1) { view.play(); view.playing(); view.pause() } // 1 + 45 events
    client.add(view)
    await client.flush()
    await client.flush()
    const counts = send.mock.calls.map(call => JSON.parse((call as unknown as [string, string])[1]).views[0].events.length)
    expect(counts).toEqual([25, 21])

    const tooBig = vi.fn(async () => ({ status: 413 }))
    const dropping = new DataClient({ apiBase: '', key: 'k' }, tooBig)
    dropping.add(new ViewTracker({}, { name: 'test' }))
    await dropping.flush(); await dropping.flush()
    expect(JSON.parse((tooBig.mock.calls[1] as unknown as [string, string])[1]).views[0].events).toEqual([])
  })

  it('stops for the session when Video data is off, and keeps events through a server error', async () => {
    const view = new ViewTracker({}, { name: 'test' })
    const flaky = vi.fn(async () => ({ status: 503 }))
    const retrying = new DataClient({ apiBase: '', key: 'k' }, flaky)
    retrying.add(view)
    await retrying.flush(); await retrying.flush()
    expect(JSON.parse((flaky.mock.calls[1] as unknown as [string, string])[1]).views[0].events).toHaveLength(1)

    const off = vi.fn(async () => ({ status: 200, enabled: false }))
    const client = new DataClient({ apiBase: '', key: 'k' }, off)
    client.add(new ViewTracker({}, { name: 'test' }))
    await client.flush(); await client.flush()
    expect(client.disabled).toBe(true)
    expect(off).toHaveBeenCalledTimes(1)
  })
})

describe('monitorVideo', () => {
  it('starts a view when playback is asked for and ends it on a new source', async () => {
    const send = vi.fn(async () => ({ status: 202, enabled: true }))
    const client = new DataClient({ apiBase: '', key: 'k' }, send)
    const element = document.createElement('video')
    const monitor = monitorVideo(client, element, { id: 'ep_1', title: 'Episode 1' }, { name: 'shaka', version: '4' })
    // Preloaded and never played: no view.
    for (const name of ['loadstart', 'loadedmetadata']) element.dispatchEvent(new Event(name))
    await client.flush()
    expect(send).not.toHaveBeenCalled()

    for (const name of ['play', 'playing', 'waiting', 'playing']) element.dispatchEvent(new Event(name))
    monitor.setVideo({ id: 'ep_2' })
    for (const name of ['loadstart', 'play']) element.dispatchEvent(new Event(name))
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    await client.flush()
    const views = send.mock.calls.flatMap(call => JSON.parse((call as unknown as [string, string])[1]).views)
    const first = views.filter((view: { video: { id: string } }) => view.video.id === 'ep_1').at(-1)
    expect(first).toMatchObject({ ended: true, player: { name: 'shaka' }, metrics: { rebuffer_count: 1 } })
    expect(first.metrics.player_startup_ms).not.toBeNull()
    expect(views.some((view: { video: { id: string } }) => view.video.id === 'ep_2')).toBe(true)
    monitor.destroy()
  })
})

describe('webDevice', () => {
  it('reads the browser and OS from the user agent', () => {
    const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1' } as Navigator
    expect(webDevice(iphone)).toMatchObject({ os: 'iOS', os_version: '18.1', browser: 'Safari', browser_version: '18.1', model: 'Mobile' })
    const chrome = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' } as Navigator
    expect(webDevice(chrome)).toMatchObject({ os: 'Windows', browser: 'Chrome', browser_version: '141.0.0.0', model: 'Desktop' })
  })
})

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
      // Video startup ends at the pre-roll's first frame; content startup leaves the ads out.
      video_startup_ms: 0, content_startup_ms: 500, ad_startup_ms: 0, ad_break_count: 2, ad_count: 3, ad_error_count: 1, ad_watch_ms: 20_000,
      playing_ms: 11_000, watch_ms: 500 + 11_000, rebuffer_count: 0,
    })
    expect(snapshot.custom).toEqual({ 1: 'experiment-b' })
    expect(snapshot.events.map(event => event.type)).toContain('aderror')
  })
})

describe('the reference startup parts, scaling amounts and errors', () => {
  it('times pre-roll requests, loading and startup after the play request', () => {
    const c = clock()
    const view = new ViewTracker({ id: 'v', experimentName: 'ladder-b', contentType: 'episode', custom: { 10: 'tenth' } }, { name: 'test' }, c.now)
    view.adRequest()              // before play: counts, but its time is not startup
    c.advance(300); view.play()
    c.advance(200); view.adResponse() // 200 ms after the play request
    c.advance(100); view.adRequest(); c.advance(150); view.adResponse()
    c.advance(50); view.adBreakStart(); view.adStart()
    c.advance(400); view.adPlaying()  // the pre-roll's first frame
    c.advance(10_000); view.adEnd(); view.adBreakEnd()
    c.advance(700); view.playing()
    const snapshot = view.snapshot()
    expect(snapshot.metrics).toMatchObject({
      preroll_requests: 2, preroll_request_ms: 350, ad_startup_ms: 400, preroll_load_ms: 450, // last response → first ad frame
      video_startup_ms: 900, content_startup_ms: 1200, // 11.6 s after play, less the 10.4 s ad break
    })
    expect(snapshot).toMatchObject({ experiment_name: 'ladder-b', video: { content_type: 'episode' }, custom: { 10: 'tenth' } })
  })

  it('weighs upscaling and downscaling amounts by time, and keeps business exceptions apart', () => {
    const c = clock()
    const view = new ViewTracker({ id: 'v' }, { name: 'test' }, c.now)
    view.playerSize(1280, 720)
    view.rendition(800, 640, 360) // 100 % upscaled
    view.play(); view.playing()
    c.advance(1000)
    view.rendition(4000, 2560, 1440) // 100 % downscaled
    c.advance(3000)
    view.captions(true)
    view.failed('geo', 'Not in your country', true, true)
    const snapshot = view.snapshot()
    expect(snapshot.metrics).toMatchObject({ upscale_pct_ms: 100_000, max_upscale_pct: 100, downscale_pct_ms: 300_000, max_downscale_pct: 100 })
    expect(snapshot.error).toEqual({ code: 'geo', message: 'Not in your country', fatal: true, business_exception: true })
    expect(snapshot.player.captions).toBe(true)
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
    element.src = 'https://cdn.example.test/ep_1.mp4'
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

  it('keeps the view when play comes before the source', async () => {
    let time = 1000
    const now = vi.spyOn(performance, 'now').mockImplementation(() => time)
    const send = vi.fn(async () => ({ status: 202, enabled: true }))
    const client = new DataClient({ apiBase: '', key: 'k' }, send)
    const element = document.createElement('video')
    const monitor = monitorVideo(client, element, { id: 'ep_1' })
    // The last reel's source loaded in 50 ms, then the player emptied the element.
    element.dispatchEvent(new Event('loadstart'))
    time += 50
    for (const name of ['loadedmetadata', 'emptied']) element.dispatchEvent(new Event(name))
    // play() on the empty element; the player attaches its MediaSource 85 ms later.
    element.dispatchEvent(new Event('play'))
    time += 85
    element.dispatchEvent(new Event('loadstart'))
    time += 300
    element.dispatchEvent(new Event('loadedmetadata'))
    time += 200
    element.dispatchEvent(new Event('playing'))
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    await client.flush()
    const views = send.mock.calls.flatMap(call => JSON.parse((call as unknown as [string, string])[1]).views)
    expect(new Set(views.map((view: { view_id: string }) => view.view_id)).size).toBe(1)
    expect(views.at(-1)).toMatchObject({ ended: false, metrics: { video_startup_ms: 585, player_startup_ms: 300 } })
    monitor.destroy()
    now.mockRestore()
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

describe('more view fields', () => {
  it('counts up- and downshifts, keeps the first rendition and its codecs, the CDN edge, and playing on another screen', () => {
    const c = clock()
    const view = new ViewTracker({ id: 'ep_1', brand: 'Drama+', creatorId: 'studio-9', drmLevel: 'L1' },
      { name: 'main', software: 'Shaka Player', softwareVersion: '4.13.25', language: 'sv', preload: true }, c.now)
    view.rendition(1500, 1280, 720, { videoCodec: 'avc1.640028', audioCodec: 'mp4a.40.2' })
    view.play(); c.advance(500); view.playing()
    view.rendition(3000, 1920, 1080, { framerate: 25, dynamicRange: 'SDR' })
    view.rendition(800, 960, 540)
    view.rendition(800, 960, 540)  // no change, no shift
    view.requestCompleted({ type: 'video', headers: { 'X-Amz-Cf-Pop': 'ARN56-P1' } })
    view.playbackMode('remote')
    const snapshot = view.snapshot()
    expect(snapshot.metrics).toMatchObject({ rendition_changes: 2, rendition_upshifts: 1, rendition_downshifts: 1 })
    expect(snapshot.rendition).toEqual({ video_codec: 'avc1.640028', audio_codec: 'mp4a.40.2', framerate: 25, dynamic_range: 'SDR',
      initial_bitrate_kbps: 1500, initial_width: 1280, initial_height: 720 })
    expect(snapshot.video).toMatchObject({ brand: 'Drama+', creator_id: 'studio-9', drm_level: 'L1', cdn_edge_pop: 'ARN56-P1' })
    expect(snapshot.player).toMatchObject({ software: 'Shaka Player', software_version: '4.13.25', language: 'sv', preload: true, remote_played: true })
  })

  it('tells the device category and sends the viewer’s plan', async () => {
    const { deviceCategory } = await import('../src/client.js')
    expect(deviceCategory('Mozilla/5.0 (Web0S; Linux/SmartTV) Chrome/120')).toBe('tv')
    expect(deviceCategory('Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X)')).toBe('tablet')
    expect(deviceCategory('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari')).toBe('phone')
    expect(deviceCategory('Mozilla/5.0 (X11; CrOS x86_64) CrKey/1.56')).toBe('chromecast')
    expect(deviceCategory('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('desktop')
    const send = vi.fn(async () => ({ status: 202, enabled: true }))
    const client = new DataClient({ key: 'up_data_x', deviceId: 'd1', viewer: { plan: 'premium', planStatus: 'trialing' } }, send)
    const view = new ViewTracker({}, { name: 'test' })
    client.add(view)
    await client.flush()
    const body = JSON.parse((send.mock.calls[0] as unknown as [string, string])[1])
    expect(body.viewer).toMatchObject({ device_id: 'd1', plan: 'premium', plan_status: 'trialing' })
  })
})

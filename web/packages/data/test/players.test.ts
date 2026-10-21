import { describe, expect, it, vi } from 'vitest'

import { DataClient } from '../src/index.js'
import { monitorJwPlayer } from '../../data-jwplayer/src/index.js'
import { castDataClient, monitorCastReceiver } from '../../data-chromecast/src/index.js'
import { monitorAvPlay, type AvPlayListener } from '../../data-tizen/src/index.js'
import { monitorReactNativeVideo } from '../../data-react-native/src/index.js'

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

function client(config: Partial<ConstructorParameters<typeof DataClient>[0]> = {}) {
  const send = vi.fn(async () => ({ status: 202, enabled: true }))
  const data = new DataClient({ apiBase: '', key: 'up_data_test', ...config }, send)
  const beacons = async () => {
    await data.flush()
    return send.mock.calls.map(call => JSON.parse((call as unknown as [string, string])[1]))
  }
  return { data, beacons }
}

describe('JW Player', () => {
  it('turns its events into a view: startup, rebuffering, quality, fullscreen, ads, completion', async () => {
    const { data, beacons } = client()
    const events = hub()
    let state = 'idle'
    const player = { ...events, version: '8.36.2+commercial', getState: () => state, getPlaylistItem: () => ({ mediaid: 'abc123', title: 'Trailer', duration: 90 }) }
    monitorJwPlayer(data, player)
    events.emit('beforePlay', {})
    events.emit('adBreakStart', {}); events.emit('adImpression', {}); events.emit('adPlay', {}); events.emit('adComplete', {}); events.emit('adBreakEnd', {})
    events.emit('firstFrame', { loadTime: 400 })
    events.emit('visualQuality', { level: { bitrate: 2_500_000, width: 1280, height: 720 } })
    events.emit('buffer', {}); events.emit('play', {})
    events.emit('fullscreen', { fullscreen: true })
    state = 'paused'; events.emit('pause', {})
    events.emit('complete', {})
    const sent = await beacons()
    const view = sent.flatMap(beacon => beacon.views).at(-1)
    expect(view.video).toMatchObject({ id: 'abc123', title: 'Trailer', duration_ms: 90_000 })
    expect(view.player).toMatchObject({ name: 'jwplayer', version: '8.36.2', fullscreen: true })
    expect(view.metrics).toMatchObject({ rebuffer_count: 1, ad_break_count: 1, ad_count: 1, max_bitrate_kbps: 2500, video_width: 1280 })
    expect(view.metrics.video_startup_ms).not.toBeNull()
    expect(view.ended).toBe(true)
    expect(view.page.type).toBe('watchpage')
  })
})

describe('Chromecast receiver', () => {
  it('watches the PlayerManager, counts segment downloads and says it is a Chromecast', async () => {
    const send = vi.fn(async () => ({ status: 202, enabled: true }))
    const data = castDataClient({ apiBase: '', key: 'up_data_test' })
    ;(data as unknown as { send: typeof send }).send = send
    const events = hub()
    const manager = { addEventListener: events.on, removeEventListener: events.off, getPlayerState: () => 'PLAYING',
      getMediaInformation: () => ({ contentId: 'ep_9', streamType: 'BUFFERED', duration: 1200, metadata: { title: 'Episode 9' } }) }
    monitorCastReceiver(data, manager, undefined, '3.0.0')
    events.emit('LOAD_START', {}); events.emit('PLAYER_LOAD_COMPLETE', {})
    events.emit('PLAY', {}); events.emit('PLAYING', {})
    events.emit('SEGMENT_DOWNLOADED', { downloadTime: 500, size: 1_000_000 })
    events.emit('BUFFERING', { isBuffering: true }); events.emit('BUFFERING', { isBuffering: false })
    events.emit('BITRATE_CHANGED', { totalBitrate: 4_000_000 })
    events.emit('MEDIA_FINISHED', { endedReason: 'END_OF_STREAM' })
    await data.flush()
    const beacon = JSON.parse((send.mock.calls.at(-1) as unknown as [string, string])[1])
    expect(beacon.platform).toBe('chromecast')
    const view = beacon.views.at(-1)
    expect(view.video).toMatchObject({ id: 'ep_9', title: 'Episode 9', stream_type: 'on-demand' })
    expect(view.metrics).toMatchObject({ request_media_completed: 1, request_media_bytes: 1_000_000, request_media_ms: 500, rebuffer_count: 1, max_bitrate_kbps: 4000 })
    expect(view.ended).toBe(true)
  })
})

describe('Samsung Tizen AVPlay', () => {
  it('wraps AVPlay’s methods, chains the app’s listener, and ends views on stop', async () => {
    const { data, beacons } = client({ platform: 'tizen' })
    let listener: AvPlayListener = {}
    let state = 'NONE'
    const avplay = {
      open: vi.fn((_url: string) => { state = 'IDLE' }), prepare: vi.fn(() => { state = 'READY' }), play: vi.fn(() => { state = 'PLAYING' }),
      pause: vi.fn(() => { state = 'PAUSED' }), stop: vi.fn(() => { state = 'IDLE' }), close: vi.fn(() => { state = 'NONE' }),
      seekTo: vi.fn((_ms: number, success?: () => void) => success?.()), setListener: vi.fn((next: AvPlayListener) => { listener = next }),
      getState: () => state,
    }
    const play = avplay.play
    monitorAvPlay(data, avplay, url => ({ id: url.split('/').pop() }), '6.5')
    const mine = { onbufferingstart: vi.fn() }
    avplay.setListener(mine)
    avplay.open('https://cdn.example.com/movie.m3u8'); avplay.prepare(); avplay.play()
    listener.onbufferingstart!(); listener.onbufferingcomplete!()
    listener.oncurrentplaytime!(42_000)
    avplay.seekTo(60_000, () => undefined)
    avplay.pause()
    avplay.stop()
    expect(mine.onbufferingstart).toHaveBeenCalled() // the app's listener still runs
    expect(play).toHaveBeenCalled() // AVPlay itself still plays
    const view = (await beacons()).flatMap(beacon => beacon.views).at(-1)
    expect(view.video.id).toBe('movie.m3u8')
    expect(view.player).toMatchObject({ name: 'avplay', version: '6.5' })
    expect(view.metrics).toMatchObject({ rebuffer_count: 1, seek_count: 1, playhead_ms: 42_000 })
    expect(view.ended).toBe(true)
  })
})

describe('React Native (react-native-video)', () => {
  it('wraps the <Video> callbacks and keeps the app’s own', async () => {
    const { data, beacons } = client({ platform: 'ios', deviceId: 'rn-device-1', device: { os: 'iOS', os_version: '18.1', model: 'iPhone 16' } })
    const monitor = monitorReactNativeVideo(data, { id: 'ep_1', title: 'Pilot' }, '6.10.0')
    const onEnd = vi.fn()
    const props = monitor.props({ onEnd })
    props.onLoadStart({ isNetwork: true })
    props.onLoad({ naturalSize: { width: 1080, height: 1920 } })
    monitor.setPaused(false)
    props.onPlaybackStateChanged({ isPlaying: true, isSeeking: false })
    props.onBuffer({ isBuffering: true }); props.onBuffer({ isBuffering: false })
    props.onBandwidthUpdate({ bitrate: 1_800_000, width: 720, height: 1280 })
    props.onPictureInPictureStatusChanged({ isActive: true })
    props.onEnd()
    expect(onEnd).toHaveBeenCalled()
    const sent = await beacons()
    expect(sent[0]).toMatchObject({ platform: 'ios', viewer: { device_id: 'rn-device-1' }, device: { os: 'iOS', model: 'iPhone 16' } })
    const view = sent.flatMap(beacon => beacon.views).at(-1)
    expect(view.player).toMatchObject({ name: 'react-native-video', pip: true })
    expect(view.metrics).toMatchObject({ rebuffer_count: 1, max_bitrate_kbps: 1800 })
    expect(view.metrics.video_startup_ms).not.toBeNull()
    expect(view.ended).toBe(true)
  })
})

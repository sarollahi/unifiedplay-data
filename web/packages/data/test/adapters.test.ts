import { describe, expect, it, vi } from 'vitest'

import { DataClient, monitorVideo, type VideoMonitor } from '../src/index.js'
import { trackHlsJs } from '../../data-hlsjs/src/index.js'
import { trackShaka } from '../../data-shaka/src/index.js'
import { trackDashJs } from '../../data-dashjs/src/index.js'
import { trackIma } from '../../data-ima/src/index.js'
import { monitorVideoJs } from '../../data-videojs/src/index.js'

/** A fake player's event hub: on/off/emit, under whatever method names the player uses. */
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

function setup() {
  const send = vi.fn(async () => ({ status: 202, enabled: true }))
  const client = new DataClient({ apiBase: '', key: 'up_data_test' }, send)
  const views = async () => {
    await client.flush()
    return send.mock.calls.flatMap(call => JSON.parse((call as unknown as [string, string])[1]).views)
  }
  return { client, views }
}

function playing(element: EventTarget) {
  for (const name of ['loadstart', 'loadedmetadata', 'play', 'playing']) element.dispatchEvent(new Event(name))
}

function spyMonitor() {
  return { rendition: vi.fn(), error: vi.fn(), requestCompleted: vi.fn(), requestFailed: vi.fn(), requestCanceled: vi.fn(), setDrmType: vi.fn(), playbackMode: vi.fn(), adBreakStart: vi.fn(), adStart: vi.fn(), adPlaying: vi.fn(), adPause: vi.fn(), adEnd: vi.fn(), adError: vi.fn(), adBreakEnd: vi.fn() } as unknown as VideoMonitor & Record<string, ReturnType<typeof vi.fn>>
}

describe('streaming libraries', () => {
  it('hls.js: level switches and fatal errors', () => {
    const monitor = spyMonitor()
    const events = hub()
    trackHlsJs(monitor, { levels: [{ bitrate: 800_000, width: 540, height: 960 }, { bitrate: 2_400_000, width: 1080, height: 1920 }], ...events })
    events.emit('hlsLevelSwitched', 'hlsLevelSwitched', { level: 1 })
    events.emit('hlsError', 'hlsError', { fatal: true, details: 'manifestLoadError', type: 'networkError' })
    expect(monitor.rendition).toHaveBeenCalledWith(2400, 1080, 1920)
    expect(monitor.error).toHaveBeenCalledWith('manifestLoadError', 'networkError', true)
  })

  it('Shaka: the active variant, and teardown errors are no failures', () => {
    const monitor = spyMonitor()
    const events = hub()
    trackShaka(monitor, { addEventListener: events.on, removeEventListener: events.off, getVariantTracks: () => [{ active: true, bandwidth: 1_500_000, width: 720, height: 1280 }] })
    events.emit('adaptation')
    events.emit('error', { detail: { code: 7000, severity: 2 } })
    events.emit('error', { detail: { code: 1001, severity: 2, message: 'Bad HTTP status' } })
    expect(monitor.rendition).toHaveBeenCalledWith(1500, 720, 1280)
    expect(monitor.error).toHaveBeenCalledTimes(1)
    expect(monitor.error).toHaveBeenCalledWith('1001', 'Bad HTTP status', true)
  })

  it('dash.js 4 and 5 qualities', () => {
    const monitor = spyMonitor()
    const events = hub()
    trackDashJs(monitor, { ...events, getBitrateInfoListFor: () => [{ bitrate: 1_000_000, width: 640, height: 360 }] })
    events.emit('qualityChangeRendered', { mediaType: 'video', newQuality: 0 })
    events.emit('qualityChangeRendered', { mediaType: 'video', newRepresentation: { bandwidth: 3_000_000, width: 1920, height: 1080 } })
    events.emit('qualityChangeRendered', { mediaType: 'audio', newQuality: 0 })
    expect(vi.mocked(monitor.rendition).mock.calls).toEqual([[1000, 640, 360], [3000, 1920, 1080]])
  })
})

describe('ads', () => {
  it('IMA: breaks, ads and errors reach the view', async () => {
    const { client, views } = setup()
    const element = document.createElement('video')
    const monitor = monitorVideo(client, element, { id: 'ep_1' })
    const manager = hub()
    const loader = hub()
    const Type = { CONTENT_PAUSE_REQUESTED: 'contentPauseRequested', CONTENT_RESUME_REQUESTED: 'contentResumeRequested', ALL_ADS_COMPLETED: 'allAdsCompleted', LOADED: 'loaded', STARTED: 'start', RESUMED: 'resume', PAUSED: 'pause', COMPLETE: 'complete', SKIPPED: 'skip' }
    const ima = { AdEvent: { Type }, AdErrorEvent: { Type: { AD_ERROR: 'adError' } } }
    trackIma(monitor, { addEventListener: manager.on, removeEventListener: manager.off }, { addEventListener: loader.on, removeEventListener: loader.off }, ima)
    for (const type of ['contentPauseRequested', 'loaded', 'start', 'complete']) manager.emit(type, { type })
    loader.emit('adError', { getError: () => ({ getErrorCode: () => 1009, getMessage: () => 'VAST empty' }) })
    manager.emit('contentResumeRequested', { type: 'contentResumeRequested' })
    const sent = await views()
    expect(sent.at(-1).metrics).toMatchObject({ ad_break_count: 1, ad_count: 1, ad_error_count: 1 })
    const events = sent.flatMap((view: { events: Array<{ type: string }> }) => view.events.map(event => event.type))
    expect(events).toEqual(expect.arrayContaining(['adbreakstart', 'adplay', 'adplaying', 'adended', 'aderror', 'adbreakend']))
  })
})

describe('players', () => {
  it('Video.js: watches its <video> element', async () => {
    const { client, views } = setup()
    const container = document.createElement('div')
    const videojsVideo = document.createElement('video')
    container.append(videojsVideo)
    const videojsEvents = hub()
    monitorVideoJs(client, { el: () => container, ...videojsEvents, error: () => null, tech: () => undefined }, { id: 'v' }, '8.23.0')
    playing(videojsVideo)

    const sent = await views()
    const last = (name: string) => sent.filter((view: { player: { name: string } }) => view.player.name === name).at(-1)
    expect(last('videojs').player.version).toBe('8.23.0')
  })
})

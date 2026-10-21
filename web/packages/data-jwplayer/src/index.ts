import { playerDriver, type DataClient, type PlayerDriver, type VideoInfo } from '@unifiedplay/data'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JwEvent = Record<string, any>
/** The part of a JW Player instance (jwplayer('id')) the monitor uses. */
export interface JwPlayerLike {
  on(event: string, listener: (event: JwEvent) => void): unknown
  off(event: string, listener: (event: JwEvent) => void): unknown
  getPlaylistItem(): { mediaid?: string; title?: string; file?: string; duration?: number } | undefined
  getState(): string
  getContainer?(): HTMLElement
  version?: string
}

const pageInfo = () => typeof location === 'undefined' ? null
  : { type: (typeof window !== 'undefined' && window.self !== window.top ? 'iframe' : 'watchpage') as 'iframe' | 'watchpage', url: `${location.origin}${location.pathname}` }

/**
 * Watches a JW Player (8.x): views, startup, rebuffering, seeks, quality, fullscreen, errors and
 * its ads (IMA and VAST). describe turns the playlist item into the view's VideoInfo.
 *
 * ```
 * const monitor = monitorJwPlayer(data, jwplayer('player'), item => ({ id: item.mediaid, title: item.title }))
 * ```
 */
export function monitorJwPlayer(
  client: DataClient,
  player: JwPlayerLike,
  describe: (item: NonNullable<ReturnType<JwPlayerLike['getPlaylistItem']>>) => VideoInfo = item => ({ id: item.mediaid, title: item.title }),
): PlayerDriver & { stop(): void } {
  const version = player.version ?? (globalThis as { jwplayer?: { version?: string } }).jwplayer?.version
  const driver = playerDriver(client, { name: 'jwplayer', version: version?.split('+')[0] }, pageInfo())
  const item = () => {
    const current = player.getPlaylistItem()
    return current ? { durationMs: current.duration ? current.duration * 1000 : undefined, ...describe(current) } : null
  }
  const listeners: Record<string, (event: JwEvent) => void> = {
    playlistItem: () => driver.source(item()),
    // beforePlay: playback was asked for (also autostart); play: the player is playing.
    beforePlay: () => driver.play(),
    firstFrame: () => driver.playing(),
    play: () => driver.playing(),
    pause: () => driver.pause(),
    buffer: () => driver.bufferingStart(),
    meta: () => driver.ready(),
    seek: () => driver.seeking(),
    seeked: () => driver.seeked(player.getState() === 'paused'),
    time: event => driver.playhead((event.position ?? 0) * 1000),
    complete: () => driver.completed(),
    error: event => driver.error(String(event.code ?? 'jwplayer'), String(event.message ?? ''), true),
    setupError: event => driver.error(String(event.code ?? 'setup'), String(event.message ?? ''), true),
    warning: event => driver.error(String(event.code ?? 'warning'), String(event.message ?? ''), false),
    visualQuality: event => {
      const level = event.level ?? {}
      driver.rendition(level.bitrate ? level.bitrate / 1000 : null, level.width || null, level.height || null)
    },
    fullscreen: event => driver.playbackMode(event.fullscreen ? 'fullscreen' : 'standard'),
    pipEnter: () => driver.playbackMode('pip'),
    pipLeave: () => driver.playbackMode('standard'),
    resize: event => {
      const ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1
      if (event.width && event.height) driver.size(Math.round(event.width * ratio), Math.round(event.height * ratio))
    },
    // JW Player 8's ad request and its loaded VAST response time pre-roll requests (spec: Startup).
    adRequest: () => driver.adRequest(),
    adLoaded: () => driver.adResponse(),
    captionsChanged: event => driver.captions(Number(event.track) > 0),
    adBreakStart: () => driver.adBreakStart(),
    adImpression: () => driver.adStart(),
    adPlay: () => driver.adPlaying(),
    adPause: () => driver.adPause(),
    adComplete: () => driver.adEnd(),
    adSkipped: () => driver.adEnd(),
    adError: event => driver.adError(String(event.code ?? 'ad'), String(event.message ?? '')),
    adBreakEnd: () => driver.adBreakEnd(),
  }
  for (const [name, listener] of Object.entries(listeners)) player.on(name, listener)
  if (player.getPlaylistItem()) driver.source(item())
  return Object.assign(driver, {
    stop() {
      for (const [name, listener] of Object.entries(listeners)) player.off(name, listener)
      driver.destroy()
    },
  })
}

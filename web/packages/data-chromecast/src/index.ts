import { DataClient, playerDriver, type DataConfig, type PlayerDriver, type VideoInfo } from '@unifiedplay/data'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CastEvent = Record<string, any>
/** The Cast receiver's PlayerManager (cast.framework.CastReceiverContext.getInstance().getPlayerManager()). */
export interface CastPlayerManager {
  addEventListener(type: string, listener: (event: CastEvent) => void): void
  removeEventListener(type: string, listener: (event: CastEvent) => void): void
  getMediaInformation(): { contentId?: string; contentUrl?: string; streamType?: string; duration?: number; metadata?: { title?: string; seriesTitle?: string } } | null
  getPlayerState?(): string
}

/** A DataClient that says it runs on a Chromecast. */
export function castDataClient(config: DataConfig): DataClient {
  return new DataClient({ platform: 'chromecast', ...config })
}

/**
 * Watches a Chromecast receiver (Cast Application Framework): views, startup, rebuffering, seeks,
 * bitrate, errors, segment downloads (throughput) and ad breaks. describe turns the loaded media
 * into the view's VideoInfo.
 *
 * ```
 * const playerManager = cast.framework.CastReceiverContext.getInstance().getPlayerManager()
 * monitorCastReceiver(castDataClient({ key: 'up_data_…' }), playerManager)
 * ```
 */
export function monitorCastReceiver(
  client: DataClient,
  playerManager: CastPlayerManager,
  describe: (media: NonNullable<ReturnType<CastPlayerManager['getMediaInformation']>>) => VideoInfo = media => ({
    id: media.contentId, title: media.metadata?.title, seriesTitle: media.metadata?.seriesTitle,
    durationMs: media.duration ? media.duration * 1000 : undefined, streamType: media.streamType === 'LIVE' ? 'live' : 'on-demand',
  }),
  version?: string,
): PlayerDriver & { stop(): void } {
  const driver = playerDriver(client, { name: 'cast', version })
  const media = () => {
    const info = playerManager.getMediaInformation()
    return info ? describe(info) : null
  }
  // cast.framework.events.EventType values.
  const listeners: Record<string, (event: CastEvent) => void> = {
    LOAD_START: () => driver.source(media()),
    PLAYER_LOAD_COMPLETE: () => { driver.setVideo(media() ?? { }); driver.ready() },
    PLAY: () => driver.play(),
    PLAYING: () => driver.playing(),
    PAUSE: () => driver.pause(),
    BUFFERING: event => event.isBuffering ? driver.bufferingStart() : driver.bufferingEnd(),
    SEEKING: () => driver.seeking(),
    SEEKED: () => driver.seeked(playerManager.getPlayerState?.() === 'PAUSED'),
    TIME_UPDATE: event => driver.playhead((event.currentMediaTime ?? 0) * 1000),
    BITRATE_CHANGED: event => driver.rendition(event.totalBitrate ? event.totalBitrate / 1000 : null, null, null),
    SEGMENT_DOWNLOADED: event => driver.requestCompleted({ type: 'media', start: 0, responseEnd: event.downloadTime, bytes: event.size }),
    MEDIA_FINISHED: event => event.endedReason === 'END_OF_STREAM' ? driver.completed() : driver.source(null),
    ERROR: event => driver.error(String(event.detailedErrorCode ?? 'cast'), String(event.error?.message ?? event.reason ?? ''), true),
    BREAK_STARTED: () => driver.adBreakStart(),
    BREAK_CLIP_LOADING: () => driver.adStart(),
    BREAK_CLIP_STARTED: () => driver.adPlaying(),
    BREAK_CLIP_ENDED: () => driver.adEnd(),
    BREAK_ENDED: () => driver.adBreakEnd(),
  }
  for (const [type, listener] of Object.entries(listeners)) playerManager.addEventListener(type, listener)
  return Object.assign(driver, {
    stop() {
      for (const [type, listener] of Object.entries(listeners)) playerManager.removeEventListener(type, listener)
      driver.destroy()
    },
  })
}

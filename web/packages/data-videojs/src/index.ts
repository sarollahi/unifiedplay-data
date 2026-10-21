import { monitorVideo, type DataClient, type VideoInfo, type VideoMonitor } from '@unifiedplay/data'

interface VhsPlaylist { attributes?: { BANDWIDTH?: number; RESOLUTION?: { width: number; height: number } } }
interface VhsLike { playlists?: { media(): VhsPlaylist | undefined; on(type: string, listener: () => void): void } }
interface VideoJsPlayer {
  el(): Element
  on(type: string, listener: () => void): void
  off(type: string, listener: () => void): void
  error(): { code: number; message: string } | null
  tech(options?: { IWillNotUseThisInPlugins: boolean }): { vhs?: VhsLike } | undefined
}

/**
 * Watches a Video.js player: its <video> element through monitorVideo, plus HLS/DASH bitrates
 * from Video.js's own streaming engine (VHS) and the player's errors.
 */
export function monitorVideoJs(client: DataClient, player: VideoJsPlayer, video: VideoInfo, version?: string): VideoMonitor & { stop(): void } {
  const element = player.el().querySelector('video')
  if (!element) throw new Error('This Video.js player has no <video> element (the html5 tech is needed)')
  const monitor = monitorVideo(client, element, video, { name: 'videojs', version })
  const media = () => {
    const attributes = player.tech({ IWillNotUseThisInPlugins: true })?.vhs?.playlists?.media()?.attributes
    if (attributes) monitor.rendition(attributes.BANDWIDTH ? attributes.BANDWIDTH / 1000 : null, attributes.RESOLUTION?.width ?? null, attributes.RESOLUTION?.height ?? null)
  }
  // VHS exists once a source is loaded; it reports each rendition change on its playlists.
  const loaded = () => player.tech({ IWillNotUseThisInPlugins: true })?.vhs?.playlists?.on('mediachange', media)
  const error = () => {
    const failure = player.error()
    if (failure) monitor.error(String(failure.code), failure.message ?? '', true)
  }
  player.on('loadedmetadata', loaded)
  player.on('error', error)
  return {
    ...monitor,
    stop() {
      player.off('loadedmetadata', loaded)
      player.off('error', error)
      monitor.destroy()
    },
  }
}

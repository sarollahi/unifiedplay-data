import { playerDriver, type DataClient, type PlayerDriver, type VideoInfo } from '@unifiedplay/data'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Payload = Record<string, any>
/** The react-native-video (6.x) callbacks the monitor sets; your own still run. */
export interface VideoEventProps {
  onLoadStart(event: Payload): void
  onLoad(event: Payload): void
  onReadyForDisplay(): void
  onBuffer(event: Payload): void
  onPlaybackStateChanged(event: Payload): void
  onProgress(event: Payload): void
  onSeek(event: Payload): void
  onEnd(): void
  onError(event: Payload): void
  onBandwidthUpdate(event: Payload): void
  onFullscreenPlayerDidPresent(): void
  onFullscreenPlayerDidDismiss(): void
  onPictureInPictureStatusChanged(event: Payload): void
}

export interface ReactNativeVideoMonitor extends PlayerDriver {
  /** Spread on <Video>: `{...monitor.props(props)}` wraps your own callbacks in props. */
  props(own?: Partial<VideoEventProps>): VideoEventProps
  /** Tell the monitor about the paused prop: false is a play request. */
  setPaused(paused: boolean): void
  stop(): void
}

/**
 * Watches a react-native-video player. The DataClient needs the app's device facts:
 * `new DataClient({ key, platform: Platform.OS, deviceId, device: { os: Platform.OS, os_version: String(Platform.Version), model, app_id } })`.
 *
 * ```
 * const monitor = useMemo(() => monitorReactNativeVideo(data, { id: episode.id, title: episode.title }), [episode.id])
 * useEffect(() => monitor.setPaused(paused), [monitor, paused])
 * useEffect(() => () => monitor.stop(), [monitor])
 * <Video source={source} paused={paused} {...monitor.props({ onEnd: next })} />
 * ```
 */
export function monitorReactNativeVideo(client: DataClient, video: VideoInfo, version?: string): ReactNativeVideoMonitor {
  const driver = playerDriver(client, { name: 'react-native-video', version })
  let paused = true
  let buffering = false
  let seekPaused = false
  driver.source(video)
  const handlers: VideoEventProps = {
    // A new source on the same <Video>: a new view (setVideo first says what it is).
    onLoadStart: () => { if (driver.view && driver.view.metrics.video_startup_ms !== null) driver.source(video) },
    onLoad: event => {
      driver.ready()
      const size = event.naturalSize
      if (size?.width) driver.rendition(null, size.width, size.height)
      if (!paused) driver.play()
    },
    onReadyForDisplay: () => driver.ready(),
    onBuffer: event => {
      buffering = Boolean(event.isBuffering)
      if (buffering) driver.bufferingStart(); else driver.bufferingEnd()
    },
    onPlaybackStateChanged: event => {
      if (event.isSeeking) return
      if (event.isPlaying) { driver.play(); driver.playing() } else if (!buffering && paused) driver.pause()
    },
    onProgress: event => driver.playhead((event.currentTime ?? 0) * 1000),
    onSeek: () => { driver.seeking(); driver.seeked(seekPaused) },
    onEnd: () => driver.completed(),
    onError: event => {
      const error = event.error ?? {}
      driver.error(String(error.errorCode ?? error.code ?? 'error'), String(error.errorString ?? error.localizedDescription ?? error.errorException ?? ''), true)
    },
    onBandwidthUpdate: event => driver.rendition(event.bitrate ? event.bitrate / 1000 : null, event.width ?? null, event.height ?? null),
    onFullscreenPlayerDidPresent: () => driver.playbackMode('fullscreen'),
    onFullscreenPlayerDidDismiss: () => driver.playbackMode('standard'),
    onPictureInPictureStatusChanged: event => driver.playbackMode(event.isActive ? 'pip' : 'standard'),
  }
  return Object.assign(driver, {
    setVideo(next: VideoInfo) { video = next; driver.setVideo(next) },
    props(own: Partial<VideoEventProps> = {}): VideoEventProps {
      const merged = {} as Record<string, (event: Payload) => void>
      for (const [name, handler] of Object.entries(handlers)) {
        const theirs = own[name as keyof VideoEventProps] as ((event: Payload) => void) | undefined
        merged[name] = (event: Payload) => { (handler as (event: Payload) => void)(event); theirs?.(event) }
      }
      return merged as unknown as VideoEventProps
    },
    setPaused(next: boolean) {
      paused = next
      seekPaused = next
      if (!next) driver.play(); else driver.pause()
    },
    stop() { driver.destroy() },
  })
}

import { DataClient, playerDriver, type DataConfig, type PlayerDriver, type VideoInfo } from '@unifiedplay/data'

/** The listener AVPlay calls (webapis.avplay.setListener). */
export interface AvPlayListener {
  onbufferingstart?(): void
  onbufferingprogress?(percent: number): void
  onbufferingcomplete?(): void
  oncurrentplaytime?(ms: number): void
  onstreamcompleted?(): void
  onerror?(error: string): void
  onevent?(type: string, data: string): void
  ondrmevent?(type: string, data: unknown): void
  [name: string]: unknown
}
/** Samsung's webapis.avplay. */
export interface AvPlayLike {
  open(url: string): void
  prepare?(): void
  prepareAsync?(onSuccess?: () => void, onError?: (error: unknown) => void): void
  play(): void
  pause(): void
  stop(): void
  close(): void
  seekTo?(ms: number, onSuccess?: () => void, onError?: (error: unknown) => void): void
  jumpForward?(ms: number, onSuccess?: () => void, onError?: (error: unknown) => void): void
  jumpBackward?(ms: number, onSuccess?: () => void, onError?: (error: unknown) => void): void
  setListener(listener: AvPlayListener): void
  getState(): string
  getCurrentTime?(): number
  setDisplayRect?(x: number, y: number, width: number, height: number): void
  getCurrentStreamInfo?(): Array<{ type: string; extra_info: string }>
}

/** A DataClient that says it runs on a Samsung Tizen TV. */
export function tizenDataClient(config: DataConfig): DataClient {
  return new DataClient({ platform: 'tizen', ...config })
}

type Methods = 'open' | 'prepare' | 'prepareAsync' | 'play' | 'pause' | 'stop' | 'close' | 'seekTo' | 'jumpForward' | 'jumpBackward' | 'setListener' | 'setDisplayRect'

/**
 * Watches Samsung's AVPlay player on Tizen TVs. AVPlay has no events for play, pause or a new
 * source, so the monitor wraps its methods (the app keeps calling webapis.avplay as before) and
 * chains your listener (call setListener after monitorAvPlay: AVPlay keeps one listener). describe turns
 * the opened URL into the view's VideoInfo. Apps playing
 * through an HTML5 <video> (also LG webOS) use monitorVideo from @unifiedplay/data instead.
 */
export function monitorAvPlay(
  client: DataClient,
  avplay: AvPlayLike,
  describe: (url: string) => VideoInfo = url => ({ id: url }),
  version?: string,
): PlayerDriver & { stop(): void } {
  const driver = playerDriver(client, { name: 'avplay', version, software: 'AVPlay', softwareVersion: version })
  const original: Partial<Record<Methods, (...args: never[]) => unknown>> = {}
  let appListener: AvPlayListener = {}
  let seekingNow = false
  // AVPlay plays a prepared stream at once and has no first-frame event: the first time update
  // after play() means frames are moving. Resumes after that count at once.
  let moving = false
  let startFrom: number | null = null
  const ours: AvPlayListener = {
    onbufferingstart: () => { if (!seekingNow) driver.bufferingStart() },
    onbufferingcomplete: () => { if (seekingNow) return; driver.bufferingEnd() },
    oncurrentplaytime: ms => {
      driver.playhead(ms)
      if (moving || avplay.getState() !== 'PLAYING' || (startFrom !== null && ms <= startFrom)) return
      moving = true
      driver.playing()
    },
    onstreamcompleted: () => driver.completed(),
    onerror: error => driver.error(String(error), '', true),
    onevent: (type, data) => {
      // A track change carries the new video stream (bitrate and size in extra_info).
      if (type === 'PLAYER_MSG_BITRATE_CHANGE') driver.rendition(Number(data) / 1000 || null, null, null)
    },
    ondrmevent: () => driver.setDrmType('playready'),
  }
  const chained: AvPlayListener = new Proxy(ours, {
    get: (target, name: string) => (...args: unknown[]) => {
      (target[name] as ((...values: unknown[]) => void) | undefined)?.(...args)
      ;(appListener[name] as ((...values: unknown[]) => void) | undefined)?.(...args)
    },
  })
  const wrap = <K extends Methods>(name: K, around: (call: () => unknown, args: unknown[]) => unknown) => {
    const method = avplay[name] as unknown as ((...args: unknown[]) => unknown) | undefined
    if (!method) return
    original[name] = method as never
    ;(avplay as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => around(() => method.apply(avplay, args), args)
  }
  const seek = (call: () => unknown, args: unknown[]) => {
    seekingNow = true
    driver.seeking()
    const [, success, failure] = args as [number, (() => void)?, ((error: unknown) => void)?]
    const done = () => {
      seekingNow = false
      driver.seeked(avplay.getState() === 'PAUSED')
      if (avplay.getState() === 'PLAYING' && moving) driver.playing()
    }
    args[1] = () => { done(); success?.() }
    args[2] = (error: unknown) => { done(); failure?.(error) }
    return call()
  }
  wrap('open', (call, [url]) => { moving = false; driver.source(describe(String(url))); return call() })
  wrap('prepare', call => { const result = call(); driver.ready(); return result })
  wrap('prepareAsync', (call, args) => {
    const [success] = args as [(() => void)?]
    args[0] = () => { driver.ready(); success?.() }
    return call()
  })
  wrap('play', call => {
    driver.play()
    startFrom = avplay.getCurrentTime?.() ?? null
    const result = call()
    if (moving) driver.playing()
    return result
  })
  wrap('pause', call => { const result = call(); driver.pause(); return result })
  wrap('stop', call => { const result = call(); driver.source(null); return result })
  wrap('close', call => { const result = call(); driver.source(null); return result })
  wrap('seekTo', seek)
  wrap('jumpForward', seek)
  wrap('jumpBackward', seek)
  wrap('setDisplayRect', (call, [, , width, height]) => { driver.size(Number(width), Number(height)); return call() })
  wrap('setListener', (call, args) => { appListener = (args[0] as AvPlayListener) ?? {}; args[0] = chained; return call() })
  original.setListener!.call(avplay, chained as never)
  return Object.assign(driver, {
    stop() {
      for (const [name, method] of Object.entries(original)) (avplay as unknown as Record<string, unknown>)[name] = method
      avplay.setListener(appListener)
      driver.destroy()
    },
  })
}

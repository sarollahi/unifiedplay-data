# UnifiedPlay Data

Playback quality data from your video players, in the UnifiedPlay Console: startup time,
rebuffering, failures, bitrate and upscaling, network requests and CDNs, watch time, ads, and
who is watching right now.

1. Get a **data key** (`up_data_…`) from the Console's **Analytics → Video data** page (one for
   production, one for staging: their views stay apart). No
   UnifiedPlay account yet? Write to hello@unifiedplay.com for a Video data workspace.
2. Add the library for your player (below) and give it the key.
3. Views show up in the Console within seconds.

The key can only send views, never read them, so it can sit in your apps' code like any app key.

| Platform | Library | Player |
|---|---|---|
| Android | `com.unifiedplay.data:media3` | Media3 ExoPlayer (any 1.x) |
| | `com.unifiedplay.data:exoplayer2` | ExoPlayer 2 (2.16+), and Amazon's ExoPlayer port |
| | `com.unifiedplay.data:mediaplayer` | Android `MediaPlayer` and `VideoView` |
| | `com.unifiedplay.data:ima` | Google IMA ads (with any of the above) |
| iOS, tvOS | `UnifiedPlayData` | AVPlayer |
| iOS | `UnifiedPlayDataIMA` | Google IMA ads |
| Web | `@unifiedplay/data` | any HTML5 `<video>`, also on LG webOS and Samsung Tizen TVs |
| | `@unifiedplay/data-hlsjs`, `-shaka`, `-dashjs` | bitrates, requests, CDN, DRM and errors from hls.js, Shaka Player, dash.js (4 and 5) |
| | `@unifiedplay/data-videojs` | Video.js, and Brightcove Player (it is Video.js) |
| | `@unifiedplay/data-jwplayer` | JW Player 8 |
| | `@unifiedplay/data-ima` | Google IMA ads (IMA HTML5 SDK) |
| Chromecast | `@unifiedplay/data-chromecast` | Cast receivers (Cast Application Framework) |
| Samsung Tizen | `@unifiedplay/data-tizen` | AVPlay (`webapis.avplay`) |
| React Native | `@unifiedplay/data-react-native` | `react-native-video` 6 |
| Flutter | `unifiedplay_data` (this repository's `flutter/`) | `video_player` |
| Roku | this repository's `roku/` | SceneGraph `Video` node |

Android libraries are on Maven Central, web packages on npm, and the Swift package, the Roku
component and the Flutter package are this repository. What is sent and how every number is worked out: [spec/beacon.md](spec/beacon.md).

**Needs:** Android 7.0 (API 24) and Kotlin 2.0 or later · iOS 15 / tvOS 15 and Swift 5.10 or later ·
web: ES modules (any bundler, or `<script type="module">`).

## Android

```kotlin
dependencies {
    implementation("com.unifiedplay.data:media3:1.1.1")
    implementation("com.unifiedplay.data:ima:1.1.1") // only with IMA ads
}
```

```kotlin
import com.unifiedplay.data.DataClient
import com.unifiedplay.data.DataConfig
import com.unifiedplay.data.VideoInfo
import com.unifiedplay.data.ima.ImaAdTracker
import com.unifiedplay.data.media3.Media3Monitor

// Once, e.g. in Application.onCreate()
val data = DataClient(context, DataConfig(key = "up_data_…"))
data.setUserId(yourViewerId) // optional: an opaque id, never an email

// For each player; it lets go by itself when the player is released
val monitor = Media3Monitor(data, player) { item ->
    VideoInfo(id = item.mediaId, title = item.mediaMetadata.title?.toString())
}

// IMA ads, with Media3's IMA extension (androidx.media3:media3-exoplayer-ima)
val ads = ImaAdTracker(monitor)
val adsLoader = ImaAdsLoader.Builder(context).setAdEventListener(ads).setAdErrorListener(ads).build()
```

`ExoPlayer2Monitor` (`com.unifiedplay.data.exoplayer2`) works the same way. Both report the
player's loads (requests, throughput, failures, the CDN from `X-CDN`) and the DRM by themselves;
fullscreen and picture-in-picture are the app's to tell: `monitor.playbackMode("fullscreen")`,
`"pip"`, `"standard"`.
`MediaPlayerMonitor(data, videoView)` (or a `MediaPlayer`, from `com.unifiedplay.data.mediaplayer`)
takes the player's listeners, so set yours on the monitor (`monitor.onPrepared = …`), call
`monitor.load(VideoInfo(…))` before each new source, and `monitor.release()` when done.

## iOS and tvOS

Swift Package Manager: `https://github.com/sarollahi/unifiedplay-data`, from `1.1.1`. Products:
`UnifiedPlayData`, and on iOS, for IMA ads, `UnifiedPlayDataIMA`.

```swift
import UnifiedPlayData

let data = DataClient(config: DataConfig(key: "up_data_…"))

// The player keeps its monitor; replacing its item with nil ends the open view.
let monitor = AVPlayerMonitor.attach(client: data, player: player, layer: playerLayer) { _ in
    VideoInfo(id: video.id, title: video.title)
}
```

Pass the layer that shows the video: video startup then ends when it has a frame to show. Without
it, startup ends when AVPlayer says it is playing, which for a prerolled item is the tick play() was called.

The access log gives the requests (bytes, transfer time) and the error log the failed ones;
FairPlay content is seen by itself. Tell fullscreen and picture-in-picture with
`monitor.playbackMode("fullscreen")` / `"pip"` / `"standard"`.

IMA takes a single delegate, so call `IMAAdTracker` from yours:

```swift
import UnifiedPlayDataIMA

let ads = IMAAdTracker(monitor)
// in your IMAAdsManagerDelegate / IMAAdsLoaderDelegate:
ads.adsManager(adsManager, didReceive: event)
ads.adsManager(adsManager, didReceive: error)
ads.adsManagerDidRequestContentPause(adsManager)
ads.adsManagerDidRequestContentResume(adsManager)
ads.adsLoader(loader, failedWith: adErrorData)
```

## Web

```bash
npm install @unifiedplay/data @unifiedplay/data-hlsjs
```

```ts
import { DataClient, monitorVideo } from '@unifiedplay/data'
import { trackHlsJs } from '@unifiedplay/data-hlsjs'
import { trackIma } from '@unifiedplay/data-ima'

const data = new DataClient({ key: 'up_data_…' })
const monitor = monitorVideo(data, videoElement, { id: video.id, title: video.title })
trackHlsJs(monitor, hls)                   // bitrates and errors from hls.js
trackIma(monitor, adsManager, adsLoader)   // IMA ads (google.ima loaded on the page)

// before switching the element to another video:
monitor.setVideo({ id: next.id, title: next.title })
```

`trackShaka(monitor, player)` and `trackDashJs(monitor, player)` work like `trackHlsJs`;
`monitorVideoJs(data, player, video)` watches a Video.js player
(`monitorVideoJs(data, videojs.getPlayer('id'), video, version, 'brightcove')` a Brightcove
Player). Fullscreen, picture-in-picture and the page (its address without query) are seen by
themselves.

### JW Player

```ts
import { monitorJwPlayer } from '@unifiedplay/data-jwplayer'

monitorJwPlayer(data, jwplayer('player'), item => ({ id: item.mediaid, title: item.title }))
```

### TVs and Chromecast

LG webOS and Samsung Tizen apps playing in a `<video>` use `monitorVideo`; the client says
`webos` / `tizen` by itself. Tizen apps playing with AVPlay:

```ts
import { monitorAvPlay, tizenDataClient } from '@unifiedplay/data-tizen'

const data = tizenDataClient({ key: 'up_data_…' })
monitorAvPlay(data, webapis.avplay, url => ({ id: url }))   // then setListener / open / play as before
```

A Chromecast receiver:

```ts
import { castDataClient, monitorCastReceiver } from '@unifiedplay/data-chromecast'

const playerManager = cast.framework.CastReceiverContext.getInstance().getPlayerManager()
monitorCastReceiver(castDataClient({ key: 'up_data_…' }), playerManager)
```

### React Native

```tsx
import { DataClient } from '@unifiedplay/data'
import { monitorReactNativeVideo } from '@unifiedplay/data-react-native'

const data = new DataClient({ key: 'up_data_…', platform: Platform.OS, deviceId, device: { os: Platform.OS, os_version: String(Platform.Version) } })
const monitor = useMemo(() => monitorReactNativeVideo(data, { id: episode.id, title: episode.title }), [episode.id])
useEffect(() => monitor.setPaused(paused), [monitor, paused])
useEffect(() => () => monitor.stop(), [monitor])
<Video source={source} paused={paused} {...monitor.props({ onEnd: next })} />
```

## Flutter

```yaml
dependencies:
  unifiedplay_data:
    git: { url: https://github.com/sarollahi/unifiedplay-data, path: flutter, ref: v1.1.1 }
```

```dart
final data = DataClient(const DataConfig(key: 'up_data_…'));
final monitor = VideoPlayerMonitor(data, controller, const VideoInfo(id: 'ep_1', title: 'Pilot'));
// another source on the same controller: monitor.newVideo(...); when done: monitor.release()
```

## Roku

Copy `roku/source/UnifiedPlayDataTracker.brs` into your channel's `source/` and
`roku/components/UnifiedPlayData.*` into `components/`, then:

```brightscript
m.data = CreateObject("roSGNode", "UnifiedPlayData")
m.data.config = { key: "up_data_…" }
m.data.video = m.videoNode
m.data.control = "run"
```

It watches the `Video` node (control, state, position, segments, errors); set `info` for your
own ids before new content and `adEvent` from your ad code (see the component's comment).

## Your own ad player

Every monitor takes ad events, so any ad player can report them: `adRequest()` when an ad
request (VAST/VMAP) goes out and `adResponse()` when it is read, `adBreakStart()` when the video
gives way to ads, `adStart()` for each ad asked to play, `adPlaying()`, `adPause()`, `adEnd()`,
`adError(code, message)`, and `adBreakEnd()` when the video takes over again. Time in an ad break
never counts as video time. Video startup ends at the first frame of a pre-roll (or the video);
content startup leaves the pre-roll out, and the Console also shows the pre-roll's startup, its
request and load time, and the requests before it.

## Errors your own rules cause

A geo-block, a paywall or too many streams stop playback on purpose: report them as business
exceptions and they do not count as playback failures (the Console counts them apart):
`monitor.error(code, message, true, true)` on the web, `monitor.businessException(code, message)`
on Android, iOS and Flutter.

## Requests, CDN and CMCD

Where the player tells (hls.js, dash.js, Shaka, Video.js, Media3, ExoPlayer 2, AVPlayer, Cast,
Roku), the libraries count its network requests: throughput, time to first byte, and failed or
aborted manifests, segments and keys. A CDN that sets an `X-CDN` response header names the
view's CDN; otherwise set `cdn` in `VideoInfo`. To join views with CDN logs, give your player's
CMCD session id (`sid`) and `viewSessionId` the same value: e.g. hls.js
`cmcd: { sessionId }` with `{ id, viewSessionId: sessionId }`.

## Your own beacon domain

Ad and tracker blockers drop beacons to other sites' hosts. Add a subdomain of your own
(`data.example.com`) in the Console (Video data → SDK setup → Beacon domain), add the CNAME it
shows, and once it is live set `beaconDomain: 'data.example.com'` in `DataConfig` (Android,
iOS, web, Flutter; Roku `config.beaconDomain`).

## Your own dimensions

`VideoInfo` takes your experiment, a sub-property, the content type, language, variant and
encoding variant, and up to ten custom values; the Console breaks views down by all of them:

```kotlin
VideoInfo(id = "ep-1", experimentName = "new-ladder", contentType = "episode", custom = mapOf(1 to "sports"))   // Android
```
```swift
VideoInfo(id: "ep-1", contentType: "episode", experimentName: "new-ladder", custom: [1: "sports"])              // iOS
```
```ts
{ id: 'ep-1', experimentName: 'new-ladder', contentType: 'episode', custom: { 1: 'sports' } }                  // web
```

Captions are seen by themselves on the web (text tracks), Media3, AVPlayer and Roku; elsewhere
call `monitor.captions(true)`.

## How a view works

A view starts when playback of a source is asked for (play pressed, autoplay, playWhenReady), so
a preloaded video nobody plays is no view. It ends on the video's end, a fatal error, a new
source, the monitor's release, or the app or page closing. The SDK sends every open view every
10 s and right away on the first frame, errors, ad breaks, the end and pauses (which is also how
apps go to the background). Counters are totals so far, so a lost beacon loses nothing but its
events; unsent events go with the next beacon.

## Develop

```bash
cd web && npm install && npm test && npm run build
cd android && ./gradlew :core:testDebugUnitTest assembleRelease
swift test   # at the repo root; the tracker and client run on macOS too
cd flutter && flutter test
npx --package=brs-node@2.6.1 brs-cli roku/source/UnifiedPlayDataTracker.brs roku/components/UnifiedPlayData.brs roku/tests/main.brs
```

The trackers (`tracker.ts`, `ViewTracker.kt`, `ViewTracker.swift`, `view_tracker.dart`,
`UnifiedPlayDataTracker.brs`) do the same thing and their tests check the same cases; change
them together.

Publishing a GitHub Release (tag `v1.2.3`) publishes every library: Android to Maven Central, and
the tag is the Swift package's version. The web packages wait staged on npm until a maintainer
approves each one on npmjs.com (2FA). The version must match
`android/gradle.properties`, the web packages and the `SDK_VERSION` constants. `develop` and
`main` change only through pull requests with green CI, and only the owner creates `v*` tags
(`.github/rulesets/`).

## License

[MIT](LICENSE): free for anyone to use, change and ship.

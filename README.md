# UnifiedPlay Data

Playback quality data from your video players, in the UnifiedPlay Console: startup time,
rebuffering, failures, bitrate and upscaling, watch time, ads, and who is watching right now.

1. Get a **data key** (`up_data_…`) from the Console's **Analytics → Video data** page. No
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
| Web | `@unifiedplay/data` | any HTML5 `<video>` |
| | `@unifiedplay/data-hlsjs`, `-shaka`, `-dashjs` | bitrates and errors from hls.js, Shaka Player, dash.js (4 and 5) |
| | `@unifiedplay/data-videojs` | Video.js |
| | `@unifiedplay/data-ima` | Google IMA ads (IMA HTML5 SDK) |

Android libraries are on Maven Central, web packages on npm, and the Swift package is this
repository. What is sent and how every number is worked out: [spec/beacon.md](spec/beacon.md).

**Needs:** Android 7.0 (API 24) and Kotlin 2.0 or later · iOS 15 / tvOS 15 and Swift 5.10 or later ·
web: ES modules (any bundler, or `<script type="module">`).

## Android

```kotlin
dependencies {
    implementation("com.unifiedplay.data:media3:1.0.0")
    implementation("com.unifiedplay.data:ima:1.0.0") // only with IMA ads
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

`ExoPlayer2Monitor` (`com.unifiedplay.data.exoplayer2`) works the same way.
`MediaPlayerMonitor(data, videoView)` (or a `MediaPlayer`, from `com.unifiedplay.data.mediaplayer`)
takes the player's listeners, so set yours on the monitor (`monitor.onPrepared = …`), call
`monitor.load(VideoInfo(…))` before each new source, and `monitor.release()` when done.

## iOS and tvOS

Swift Package Manager: `https://github.com/sarollahi/unifiedplay-data`, from `1.0.0`. Products:
`UnifiedPlayData`, and on iOS, for IMA ads, `UnifiedPlayDataIMA`.

```swift
import UnifiedPlayData

let data = DataClient(config: DataConfig(key: "up_data_…"))

// The player keeps its monitor; replacing its item with nil ends the open view.
let monitor = AVPlayerMonitor.attach(client: data, player: player, layer: playerLayer) { _ in
    VideoInfo(id: video.id, title: video.title)
}
```

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
`monitorVideoJs(data, player, video)` watches a Video.js player.

## Your own ad player

Every monitor takes ad events, so any ad player can report them: `adBreakStart()` when the video
gives way to ads, `adStart()` for each ad asked to play, `adPlaying()`, `adPause()`, `adEnd()`,
`adError(code, message)`, and `adBreakEnd()` when the video takes over again. Time in an ad break
never counts as video time, and a pre-roll does not count towards video startup.

## Your own dimensions

`VideoInfo` takes up to five custom values, and the Console breaks views down by them:

```kotlin
VideoInfo(id = "ep-1", custom = mapOf(1 to "experiment-b", 2 to "sports"))   // Android
```
```swift
VideoInfo(id: "ep-1", custom: [1: "experiment-b", 2: "sports"])              // iOS
```
```ts
{ id: 'ep-1', custom: { 1: 'experiment-b', 2: 'sports' } }                   // web
```

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
```

The three trackers (`tracker.ts`, `ViewTracker.kt`, `ViewTracker.swift`) do the same thing and
their tests check the same cases; change them together.

Publishing a GitHub Release (tag `v1.2.3`) publishes every library: Android to Maven Central, web
to npm, and the tag is the Swift package's version. The version must match
`android/gradle.properties`, the web packages and the `SDK_VERSION` constants. `develop` and
`main` change only through pull requests with green CI, and only the owner creates `v*` tags
(`.github/rulesets/`).

## License

[MIT](LICENSE): free for anyone to use, change and ship.

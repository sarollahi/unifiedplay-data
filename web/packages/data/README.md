# @unifiedplay/data

Playback quality data from your web video players, in the UnifiedPlay Console: startup time, rebuffering, failures, bitrate and upscaling, requests and CDNs, watch time, ads, and who is watching right now. Works with any HTML5 `<video>`, also on LG webOS and Samsung Tizen TVs.

```bash
npm install @unifiedplay/data
```

```ts
import { DataClient, monitorVideo } from '@unifiedplay/data'

const data = new DataClient({ key: 'up_data_…' })
const monitor = monitorVideo(data, videoElement, { id: video.id, title: video.title })

// before giving the element another video:
monitor.setVideo({ id: next.id, title: next.title })
```

A view starts when playback is asked for (play pressed or autoplay), so a preloaded video nobody
plays is no view. `VideoInfo` also takes the series, duration, stream type, content type,
language, experiment and up to ten custom values (`custom: { 1: 'sports' }`), and the Console
breaks views down by all of them. `DataClient` takes an opaque `userId` (never an email), the
viewer's `viewer.plan` and your own `beaconDomain`.

Your own ad player reports ads on the monitor: `adBreakStart()`, `adStart()`, `adPlaying()`,
`adPause()`, `adEnd()`, `adError(code, message)` and `adBreakEnd()`.

Players and streaming libraries add more with their own package:

| Package | For |
|---|---|
| [`@unifiedplay/data-hlsjs`](https://www.npmjs.com/package/@unifiedplay/data-hlsjs) | hls.js |
| [`@unifiedplay/data-shaka`](https://www.npmjs.com/package/@unifiedplay/data-shaka) | Shaka Player |
| [`@unifiedplay/data-dashjs`](https://www.npmjs.com/package/@unifiedplay/data-dashjs) | dash.js 4 and 5 |
| [`@unifiedplay/data-videojs`](https://www.npmjs.com/package/@unifiedplay/data-videojs) | Video.js and Brightcove Player |
| [`@unifiedplay/data-jwplayer`](https://www.npmjs.com/package/@unifiedplay/data-jwplayer) | JW Player 8 |
| [`@unifiedplay/data-ima`](https://www.npmjs.com/package/@unifiedplay/data-ima) | Google IMA ads |
| [`@unifiedplay/data-chromecast`](https://www.npmjs.com/package/@unifiedplay/data-chromecast) | Chromecast receivers |
| [`@unifiedplay/data-tizen`](https://www.npmjs.com/package/@unifiedplay/data-tizen) | Samsung Tizen AVPlay |
| [`@unifiedplay/data-react-native`](https://www.npmjs.com/package/@unifiedplay/data-react-native) | `react-native-video` 6 |

Get a data key (`up_data_…`) from the UnifiedPlay Console's **Analytics → Video data** page. No
account yet? Write to hello@unifiedplay.com. The key can only send views, never read them, so it
can sit in your app's code.

More: [every player and platform, ads and your own dimensions](https://github.com/sarollahi/unifiedplay-data#readme) · [what is sent and
how every number is worked out](https://github.com/sarollahi/unifiedplay-data/blob/main/spec/beacon.md)

## License

[MIT](https://github.com/sarollahi/unifiedplay-data/blob/main/LICENSE)

# @unifiedplay/data-dashjs

Bitrates, segment requests, the CDN, DRM and errors from [dash.js](https://github.com/Dash-Industry-Forum/dash.js) 4 and 5, for [`@unifiedplay/data`](https://www.npmjs.com/package/@unifiedplay/data): playback quality data in the UnifiedPlay Console.

```bash
npm install @unifiedplay/data @unifiedplay/data-dashjs
```

```ts
import { DataClient, monitorVideo } from '@unifiedplay/data'
import { trackDashJs } from '@unifiedplay/data-dashjs'

const data = new DataClient({ key: 'up_data_…' })
const monitor = monitorVideo(data, videoElement, { id: video.id, title: video.title })
const stop = trackDashJs(monitor, player)   // player: your dashjs.MediaPlayer() on videoElement
```

`trackDashJs` returns a function that stops listening to the player.

Get a data key (`up_data_…`) from the UnifiedPlay Console's **Analytics → Video data** page. No
account yet? Write to hello@unifiedplay.com. The key can only send views, never read them, so it
can sit in your app's code.

More: [every player and platform, ads and your own dimensions](https://github.com/sarollahi/unifiedplay-data#readme) · [what is sent and
how every number is worked out](https://github.com/sarollahi/unifiedplay-data/blob/main/spec/beacon.md)

## License

[MIT](https://github.com/sarollahi/unifiedplay-data/blob/main/LICENSE)

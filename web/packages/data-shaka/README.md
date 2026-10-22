# @unifiedplay/data-shaka

Bitrates, segment requests, the CDN, DRM and errors from [Shaka Player](https://github.com/shaka-project/shaka-player), for [`@unifiedplay/data`](https://www.npmjs.com/package/@unifiedplay/data): playback quality data in the UnifiedPlay Console.

```bash
npm install @unifiedplay/data @unifiedplay/data-shaka
```

```ts
import { DataClient, monitorVideo } from '@unifiedplay/data'
import { trackShaka } from '@unifiedplay/data-shaka'

const data = new DataClient({ key: 'up_data_…' })
const monitor = monitorVideo(data, videoElement, { id: video.id, title: video.title })
const stop = trackShaka(monitor, player)   // player: your shaka.Player on videoElement
```

`trackShaka` returns a function that stops listening to the player.

Get a data key (`up_data_…`) from the UnifiedPlay Console's **Analytics → Video data** page. No
account yet? Write to hello@unifiedplay.com. The key can only send views, never read them, so it
can sit in your app's code.

More: [every player and platform, ads and your own dimensions](https://github.com/sarollahi/unifiedplay-data#readme) · [what is sent and
how every number is worked out](https://github.com/sarollahi/unifiedplay-data/blob/main/spec/beacon.md)

## License

[MIT](https://github.com/sarollahi/unifiedplay-data/blob/main/LICENSE)

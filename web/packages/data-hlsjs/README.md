# @unifiedplay/data-hlsjs

Bitrates, segment requests, the CDN, DRM and errors from [hls.js](https://github.com/video-dev/hls.js), for [`@unifiedplay/data`](https://www.npmjs.com/package/@unifiedplay/data): playback quality data in the UnifiedPlay Console.

```bash
npm install @unifiedplay/data @unifiedplay/data-hlsjs
```

```ts
import { DataClient, monitorVideo } from '@unifiedplay/data'
import { trackHlsJs } from '@unifiedplay/data-hlsjs'

const data = new DataClient({ key: 'up_data_…' })
const monitor = monitorVideo(data, videoElement, { id: video.id, title: video.title })
const stop = trackHlsJs(monitor, hls)   // hls: your Hls instance on videoElement
```

`trackHlsJs` returns a function that stops listening to `hls`.

Get a data key (`up_data_…`) from the UnifiedPlay Console's **Analytics → Video data** page. No
account yet? Write to hello@unifiedplay.com. The key can only send views, never read them, so it
can sit in your app's code.

More: [every player and platform, ads and your own dimensions](https://github.com/sarollahi/unifiedplay-data#readme) · [what is sent and
how every number is worked out](https://github.com/sarollahi/unifiedplay-data/blob/main/spec/beacon.md)

## License

[MIT](https://github.com/sarollahi/unifiedplay-data/blob/main/LICENSE)

# @unifiedplay/data-ima

Ad breaks, ads, ad watch time and ad errors from the [Google IMA HTML5 SDK](https://developers.google.com/interactive-media-ads/docs/sdks/html5/client-side), for any [`@unifiedplay/data`](https://www.npmjs.com/package/@unifiedplay/data) monitor. Time in an ad break never counts as video time, and a pre-roll does not count towards video startup.

```bash
npm install @unifiedplay/data @unifiedplay/data-ima
```

```ts
import { DataClient, monitorVideo } from '@unifiedplay/data'
import { trackIma } from '@unifiedplay/data-ima'

const data = new DataClient({ key: 'up_data_…' })
const monitor = monitorVideo(data, videoElement, { id: video.id, title: video.title })
const stop = trackIma(monitor, adsManager, adsLoader)   // google.ima loaded on the page
```

Works the same with the Video.js monitor (JW Player reports its own ads). `trackIma` returns a function that stops listening.

Get a data key (`up_data_…`) from the UnifiedPlay Console's **Analytics → Video data** page. No
account yet? Write to hello@unifiedplay.com. The key can only send views, never read them, so it
can sit in your app's code.

More: [every player and platform, ads and your own dimensions](https://github.com/sarollahi/unifiedplay-data#readme) · [what is sent and
how every number is worked out](https://github.com/sarollahi/unifiedplay-data/blob/main/spec/beacon.md)

## License

[MIT](https://github.com/sarollahi/unifiedplay-data/blob/main/LICENSE)

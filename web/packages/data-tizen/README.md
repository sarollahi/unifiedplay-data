# @unifiedplay/data-tizen

Playback quality data from Samsung Tizen TV apps that play with AVPlay (`webapis.avplay`), in the UnifiedPlay Console. Built on [`@unifiedplay/data`](https://www.npmjs.com/package/@unifiedplay/data); Tizen apps playing in a `<video>` use its `monitorVideo` instead.

```bash
npm install @unifiedplay/data @unifiedplay/data-tizen
```

```ts
import { monitorAvPlay, tizenDataClient } from '@unifiedplay/data-tizen'

const data = tizenDataClient({ key: 'up_data_…' })
const monitor = monitorAvPlay(data, webapis.avplay, url => ({ id: url }))
// then setListener / open / play as before
```

Call `monitor.stop()` when the app stops playing.

Get a data key (`up_data_…`) from the UnifiedPlay Console's **Analytics → Video data** page. No
account yet? Write to hello@unifiedplay.com. The key can only send views, never read them, so it
can sit in your app's code.

More: [every player and platform, ads and your own dimensions](https://github.com/sarollahi/unifiedplay-data#readme) · [what is sent and
how every number is worked out](https://github.com/sarollahi/unifiedplay-data/blob/main/spec/beacon.md)

## License

[MIT](https://github.com/sarollahi/unifiedplay-data/blob/main/LICENSE)

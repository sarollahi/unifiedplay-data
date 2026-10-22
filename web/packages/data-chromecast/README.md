# @unifiedplay/data-chromecast

Playback quality data from Chromecast receivers (Cast Application Framework), in the UnifiedPlay Console. Built on [`@unifiedplay/data`](https://www.npmjs.com/package/@unifiedplay/data).

```bash
npm install @unifiedplay/data @unifiedplay/data-chromecast
```

```ts
import { castDataClient, monitorCastReceiver } from '@unifiedplay/data-chromecast'

const playerManager = cast.framework.CastReceiverContext.getInstance().getPlayerManager()
const monitor = monitorCastReceiver(castDataClient({ key: 'up_data_…' }), playerManager)
```

Each loaded media is a view, named from its `contentId` and metadata (pass your own `describe` function as the third argument to change that), and break clips count as ads.

Get a data key (`up_data_…`) from the UnifiedPlay Console's **Analytics → Video data** page. No
account yet? Write to hello@unifiedplay.com. The key can only send views, never read them, so it
can sit in your app's code.

More: [every player and platform, ads and your own dimensions](https://github.com/sarollahi/unifiedplay-data#readme) · [what is sent and
how every number is worked out](https://github.com/sarollahi/unifiedplay-data/blob/main/spec/beacon.md)

## License

[MIT](https://github.com/sarollahi/unifiedplay-data/blob/main/LICENSE)

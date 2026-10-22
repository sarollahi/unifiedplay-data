# @unifiedplay/data-jwplayer

Views, startup, rebuffering, quality, errors and ads from [JW Player](https://www.jwplayer.com) 8, in the UnifiedPlay Console. Built on [`@unifiedplay/data`](https://www.npmjs.com/package/@unifiedplay/data).

```bash
npm install @unifiedplay/data @unifiedplay/data-jwplayer
```

```ts
import { DataClient } from '@unifiedplay/data'
import { monitorJwPlayer } from '@unifiedplay/data-jwplayer'

const data = new DataClient({ key: 'up_data_…' })
const monitor = monitorJwPlayer(data, jwplayer('player'), item => ({ id: item.mediaid, title: item.title }))
```

Each playlist item is its own view, and JW Player's ad events count as ads by themselves. Call `monitor.stop()` when the player goes away.

Get a data key (`up_data_…`) from the UnifiedPlay Console's **Analytics → Video data** page. No
account yet? Write to hello@unifiedplay.com. The key can only send views, never read them, so it
can sit in your app's code.

More: [every player and platform, ads and your own dimensions](https://github.com/sarollahi/unifiedplay-data#readme) · [what is sent and
how every number is worked out](https://github.com/sarollahi/unifiedplay-data/blob/main/spec/beacon.md)

## License

[MIT](https://github.com/sarollahi/unifiedplay-data/blob/main/LICENSE)

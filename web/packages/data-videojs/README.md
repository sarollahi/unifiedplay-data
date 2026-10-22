# @unifiedplay/data-videojs

Playback quality data from [Video.js](https://videojs.com) players, and Brightcove Player (it is Video.js), in the UnifiedPlay Console. Built on [`@unifiedplay/data`](https://www.npmjs.com/package/@unifiedplay/data).

```bash
npm install @unifiedplay/data @unifiedplay/data-videojs
```

```ts
import { DataClient } from '@unifiedplay/data'
import { monitorVideoJs } from '@unifiedplay/data-videojs'

const data = new DataClient({ key: 'up_data_…' })
const monitor = monitorVideoJs(data, player, { id: video.id, title: video.title })

// Brightcove Player:
monitorVideoJs(data, videojs.getPlayer('player-id'), video, version, 'brightcove')
```

Call `monitor.setVideo(...)` before a new source and `monitor.stop()` when the player goes away.

Get a data key (`up_data_…`) from the UnifiedPlay Console's **Analytics → Video data** page. No
account yet? Write to hello@unifiedplay.com. The key can only send views, never read them, so it
can sit in your app's code.

More: [every player and platform, ads and your own dimensions](https://github.com/sarollahi/unifiedplay-data#readme) · [what is sent and
how every number is worked out](https://github.com/sarollahi/unifiedplay-data/blob/main/spec/beacon.md)

## License

[MIT](https://github.com/sarollahi/unifiedplay-data/blob/main/LICENSE)

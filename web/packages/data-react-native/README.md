# @unifiedplay/data-react-native

Playback quality data from [`react-native-video`](https://github.com/TheWidlarzGroup/react-native-video) 6, in the UnifiedPlay Console. Built on [`@unifiedplay/data`](https://www.npmjs.com/package/@unifiedplay/data).

```bash
npm install @unifiedplay/data @unifiedplay/data-react-native
```

```tsx
import { DataClient } from '@unifiedplay/data'
import { monitorReactNativeVideo } from '@unifiedplay/data-react-native'

const data = new DataClient({ key: 'up_data_…', platform: Platform.OS, deviceId, device: { os: Platform.OS, os_version: String(Platform.Version) } })

const monitor = useMemo(() => monitorReactNativeVideo(data, { id: episode.id, title: episode.title }), [episode.id])
useEffect(() => monitor.setPaused(paused), [monitor, paused])
useEffect(() => () => monitor.stop(), [monitor])

<Video source={source} paused={paused} {...monitor.props({ onEnd: next })} />
```

`deviceId` is an id your app keeps for the device; React Native has no `localStorage` for the client to keep one.

Get a data key (`up_data_…`) from the UnifiedPlay Console's **Analytics → Video data** page. No
account yet? Write to hello@unifiedplay.com. The key can only send views, never read them, so it
can sit in your app's code.

More: [every player and platform, ads and your own dimensions](https://github.com/sarollahi/unifiedplay-data#readme) · [what is sent and
how every number is worked out](https://github.com/sarollahi/unifiedplay-data/blob/main/spec/beacon.md)

## License

[MIT](https://github.com/sarollahi/unifiedplay-data/blob/main/LICENSE)

# UnifiedPlay Data — beacon contract (v1)

All three SDKs (Android, iOS, web) watch a video player and send the same beacon to the
UnifiedPlay backend. The Console's Analytics → Video data page reads what they send.

## Words

- **View**: one attempt to watch one video, from the moment playback is asked for (or the
  player is given a source) until the viewer leaves the video, the video ends, or a fatal
  error. A new source on the same player starts a new view.
- **Session**: one app run or one page load. A session has many views.
- **Viewer**: an anonymous device id the SDK keeps (local storage / SharedPreferences /
  UserDefaults), plus `user_id` when the app sets one. In a UnifiedPlay streaming service's
  own apps that is the public user id (`usr_…`), kept only if that user gave analytics
  consent. In a Video data only workspace it is the customer's own viewer id, kept as sent:
  send an opaque id, never an email or a name.

## Request

```
POST {api_base}/api/v1/data/beacons        api_base defaults to https://backend.unifiedplay.com
X-Tenant-Key: <data key, or a UnifiedPlay app's tenant app key>
X-Platform: android | ios | web | tvos | roku | …
Content-Type: application/json
```

No sign-in token. The key says whose views these are:

- **Data key** (`up_data_…`): one per workspace, shown on the Console's Video data page, for
  any platform. It can only send views; it opens no other API, so it can sit in public code.
- **Tenant app key**: what a UnifiedPlay app already sends (platform-bound).

Web pages send `key` and `platform` in the body instead of headers (see below).

Responses:

| Status | Body | SDK does |
|---|---|---|
| 202 | `{"enabled": true}` | keep sending |
| 200 | `{"enabled": false}` | Video data is off for this tenant: stop sending for the rest of this session |
| 400/401/403/404 | error | stop sending for this session (bad key or bad SDK) |
| 413 | — | too big to ever go through: drop that beacon's events (the totals go with the next one) |
| 429/5xx/network | — | keep the events; they go with the next beacon |

A beacon is at most 64 KB. The SDKs send at most 10 views per beacon and the 25 oldest unsent
events of each; the rest go with the next beacons.

## Body

```json
{
  "sdk": {"name": "unifiedplay-data-android", "version": "1.0.0"},
  "session_id": "3f2c…",
  "viewer": {"device_id": "a1b2…", "user_id": "usr_…"},
  "device": {
    "os": "Android", "os_version": "15", "manufacturer": "Google", "model": "Pixel 8",
    "browser": null, "browser_version": null, "app_id": "com.example.tv", "app_version": "1.4.0",
    "connection": "wifi"
  },
  "views": [ <view>, … ]
}
```

A view is sent whole every time (its counters are totals so far, not deltas), so a lost beacon
loses nothing but its events. `events` holds only the events since the previous beacon.

```json
{
  "view_id": "9c0e…",
  "seq": 4,
  "started_at": "2026-10-21T09:00:00.000Z",
  "ended": false,
  "video": {
    "id": "ep_123_ab", "title": "Episode 1", "series_id": "s_9_ab", "series_title": "My series",
    "duration_ms": 92000, "stream_type": "on-demand", "source_type": "hls",
    "source_host": "media.example.com"
  },
  "player": {"name": "media3", "version": "1.11.0", "width": 1080, "height": 1920, "autoplay": true},
  "metrics": {
    "player_startup_ms": 120,
    "video_startup_ms": 840,
    "watch_ms": 31000,
    "playing_ms": 29000,
    "rebuffer_count": 1,
    "rebuffer_ms": 1200,
    "seek_count": 0,
    "seek_ms": 0,
    "playhead_ms": 29000,
    "avg_bitrate_kbps": 2400,
    "max_bitrate_kbps": 3200,
    "rendition_changes": 2,
    "video_width": 1080,
    "video_height": 1920,
    "upscale_ms": 0,
    "downscale_ms": 0,
    "max_upscale_pct": 0,
    "dropped_frames": 3,
    "live_latency_ms": null,
    "ad_break_count": 1,
    "ad_count": 2,
    "ad_watch_ms": 30000,
    "ad_error_count": 0
  },
  "custom": {"1": "experiment-b", "2": "sports"},
  "error": null,
  "events": [{"t": 0, "type": "play"}, {"t": 840, "type": "playing"}]
}
```

`error`, when the view failed: `{"code": "2004", "message": "Source error", "fatal": true}`.

### Metrics

| Field | Meaning |
|---|---|
| `player_startup_ms` | player created (or given its first source) → ready to play. Once per view, `null` until known. |
| `video_startup_ms` | play asked for → first frame shown. `null` until the first frame. |
| `watch_ms` | time from play asked for until now/end, minus paused time. Includes startup and rebuffering. |
| `playing_ms` | time the playhead actually moved. |
| `rebuffer_count`, `rebuffer_ms` | stalls after the first frame (not seeks, not startup). |
| `seek_count`, `seek_ms` | seeks and the time from seek start until playing again. |
| `playhead_ms` | furthest playhead position reached. |
| `avg_bitrate_kbps` | bitrate of the playing rendition, weighted by playing time. |
| `max_bitrate_kbps` | highest rendition bitrate played. |
| `rendition_changes` | quality switches after the first frame. |
| `video_width/height` | size of the rendition playing now. |
| `upscale_ms`, `downscale_ms` | playing time while the rendition was smaller / larger than the player on screen. |
| `max_upscale_pct` | largest `(player size / rendition size − 1) × 100` seen. |
| `dropped_frames` | frames the player dropped. |
| `live_latency_ms` | live streams: latest distance to the live edge. |
| `ad_break_count` | ad breaks (pre-, mid-, post-roll) that started. |
| `ad_count` | ads asked to play. |
| `ad_watch_ms` | time ads were actually playing. |
| `ad_error_count` | ads that failed. |

Time inside an ad break is not content time: it is neither watch, playing nor rebuffering
time, and a pre-roll does not count towards video startup time.

`custom` holds up to five of the customer's own dimensions (`"1"` … `"5"`, 255 characters
each), e.g. an experiment name or a page type. The Console breaks views down by them.
`device.app_id` is the app's package / bundle id, or the site's host on the web.

### Events

`t` is milliseconds since the view started. Types: `viewstart`, `play`, `playing`, `pause`,
`seeking`, `seeked`, `rebufferstart`, `rebufferend`, `rendition` (`data: {"kbps", "width",
"height"}`), `error` (`data: {"code", "message", "fatal"}`), `ended`, `viewend`, and for ads
`adbreakstart`, `adplay`, `adplaying`, `adpause`, `adended`, `aderror` (`data: {"code",
"message"}`), `adbreakend`.
The backend keeps the first 500 events of a view.

## When to send

- every 10 s while a view is open (also gives the Console its live viewer count)
- right away on `viewstart`, first `playing`, `error`, `ended`, `viewend`
- when the app goes to the background / the page is hidden (web: `navigator.sendBeacon`)

A view ends (`ended: true`) on: video ended, fatal error, a new source, the player released,
or the app/page closed. A view with no beacon for 60 s is treated as ended by the backend.

## What the backend works out

Per view, stored on the view row:

- `exited_before_start`: ended, no first frame, no fatal error
- `startup_failed`: fatal error before the first frame
- `failed`: fatal error at any time
- scores 0–100:
  - playback success: 100, or 50 when exited before start, or 0 when failed
  - startup: 100 at ≤ 1 s, falling straight to 0 at 10 s; failed or exited views get none
  - smoothness: `100 × (1 − 10 × rebuffer_ms / watch_ms)`, at least 0
  - quality: `100 × (1 − upscale_ms / playing_ms)`, at least 0
  - overall: mean of the scores the view has

Across views (Console):

| Metric | Formula |
|---|---|
| Views | count of views |
| Unique viewers | distinct `device_id` |
| Playback failure % | failed views / views |
| Startup failure % | startup-failed views / views |
| Exits before start % | exited-before-start views / views |
| Video startup time | median and 95th percentile of `video_startup_ms` |
| Player startup time | median of `player_startup_ms` |
| Rebuffer % | Σ rebuffer_ms / Σ watch_ms |
| Rebuffer frequency | Σ rebuffer_count / (Σ watch_ms in minutes) |
| Rebuffer duration | Σ rebuffer_ms / views that rebuffered |
| Seek latency | Σ seek_ms / Σ seek_count |
| Upscale % / Downscale % | Σ upscale_ms / Σ playing_ms (same for downscale) |
| Average bitrate | Σ (avg_bitrate × playing_ms) / Σ playing_ms |
| Watch time / Playing time | Σ watch_ms / Σ playing_ms |
| Live viewers | views with a beacon in the last 30 s and not ended |
| Ads played / ad watch time | Σ ad_count / Σ ad_watch_ms |
| Ad errors % | Σ ad_error_count / Σ ad_count |
| Views with ads % | views with an ad / views |
| Scores | mean of each view score |

Breakdowns group these by: platform, os, os version, device model, manufacturer, browser,
app or site, app version, player, SDK version, country, connection, video, series, stream
type, source type, CDN host, error code, viewer, custom 1–5.

Country comes from the `CF-IPCountry` request header when the request passed through
Cloudflare. The viewer's IP address is never stored.

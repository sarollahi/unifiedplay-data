# UnifiedPlay Data — beacon contract (v1.1)

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
                                           (https://{beacon_domain} when one is set, see below)
X-Tenant-Key: <data key, or a UnifiedPlay app's tenant app key>
X-Platform: android | ios | web | tvos | roku | …
Content-Type: application/json
```

No sign-in token. The key says whose views these are:

- **Data key** (`up_data_…`): one per environment of a workspace (production and staging),
  shown on the Console's Video data page, for any platform. It can only send views; it opens
  no other API, so it can sit in public code. Views keep the environment of the key they came
  with, and the Console shows one environment at a time (production unless asked).
- **Tenant app key**: what a UnifiedPlay app already sends (platform-bound).

Web pages send `key` and `platform` in the body instead of headers (see below).

**Beacon domain.** A workspace can send through its own subdomain (`data.example.com`), so ad
and tracker blockers that drop third-party hosts let the beacons through. The customer adds it
in the Console and points it at the platform with one CNAME; the platform adds it as a custom
hostname and issues its certificate. The SDKs then take `beaconDomain` (`beacon_domain`) and
post to `https://{beacon_domain}/api/v1/data/beacons`; everything else stays the same.

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
    "connection": "wifi", "category": "phone"
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
    "source_host": "media.example.com", "cdn": "cloudflare", "drm_type": "widevine",
    "content_type": "episode", "language_code": "en", "variant_name": "director's cut", "encoding_variant": "ladder-b"
  },
  "player": {"name": "media3", "version": "1.11.0", "width": 1080, "height": 1920, "autoplay": true,
             "fullscreen": false, "pip": false, "captions": false},
  "experiment_name": "new-ladder", "sub_property_id": "site-b",
  "page": {"type": "watchpage", "url": "https://www.example.com/watch/ep_123_ab"},
  "view_session_id": "6e1d…",
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
    "ad_error_count": 0,
    "request_completed": 58,
    "request_failed": 1,
    "request_canceled": 0,
    "request_failed_manifest": 0,
    "request_failed_media": 1,
    "request_failed_encryption": 0,
    "request_media_completed": 52,
    "request_media_bytes": 41500000,
    "request_media_ms": 16600,
    "request_media_ttfb_ms": 4680,
    "request_media_ttfb_count": 52,
    "request_media_max_ttfb_ms": 310,
    "content_startup_ms": 840,
    "ad_startup_ms": null,
    "preroll_request_ms": null,
    "preroll_load_ms": null,
    "preroll_requests": 0,
    "page_load_ms": null,
    "upscale_pct_ms": 0,
    "downscale_pct_ms": 0,
    "max_downscale_pct": 0
  },
  "custom": {"1": "experiment-b", "2": "sports"},
  "error": null,
  "events": [{"t": 0, "type": "play"}, {"t": 840, "type": "playing"}]
}
```

`viewer` may also carry the app's own words for the viewer's plan: `plan` ("premium"),
`plan_status` ("trialing"), `plan_category` ("sports"). `device.category` is `tv`, `phone`,
`tablet`, `desktop`, `chromecast` or `console` (the backend works it out from the platform, OS,
model and user agent when the SDK leaves it out); the web SDK also sends `device.user_agent`.

`error`, when the view failed: `{"code": "2004", "message": "Source error", "fatal": true,
"business_exception": false}`. A fatal error the app marks `business_exception` (its own rule
stopped playback: a geo-block, a paywall, too many streams) ends the view without failing it.

### Metrics

| Field | Meaning |
|---|---|
| `player_startup_ms` | player created (or given its first source) → ready to play. Once per view, `null` until known. |
| `video_startup_ms` | play asked for → first frame shown, of the content or of a pre-roll ad, whichever comes first. `null` until then. |
| `content_startup_ms` | play asked for → the content's first frame, less the time of pre-roll ad breaks. |
| `ad_startup_ms` | the first pre-roll asked to play → its first frame. |
| `preroll_request_ms` | time spent on ad requests (`adRequest` → `adResponse`) after play was asked for and before the first pre-roll played. |
| `preroll_load_ms` | the last ad response (or the pre-roll's start) → the pre-roll's first frame, after play was asked for. |
| `preroll_requests` | ad requests before the first pre-roll played. |
| `page_load_ms` | web, the first view on a page: the page's request → the player's start. |
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
| `upscale_pct_ms`, `downscale_pct_ms` | the upscale (downscale) amount times the milliseconds it lasted, added up: the amount is how much the dimension that fills the player first is stretched, `(player / rendition − 1) × 100` (320 → 640: 100), or shrunk, `(rendition / player − 1) × 100`. |
| `max_upscale_pct`, `max_downscale_pct` | the largest of those amounts. |
| `dropped_frames` | frames the player dropped. |
| `live_latency_ms` | live streams: latest distance to the live edge. |
| `ad_break_count` | ad breaks (pre-, mid-, post-roll) that started. |
| `ad_count` | ads asked to play. |
| `ad_watch_ms` | time ads were actually playing. |
| `ad_error_count` | ads that failed. |
| `request_completed`, `request_failed`, `request_canceled` | network requests for the content (manifests, segments, init segments, keys and licenses, subtitles) that completed, failed or were aborted. Never ad requests. |
| `request_failed_manifest`, `_media`, `_encryption` | failed requests by type: manifests and playlists; video, audio and init segments; keys and licenses. |
| `request_media_completed` | completed media requests: video, audio and media segments (not manifests, init segments, keys or subtitles). |
| `request_media_bytes`, `request_media_ms` | their bytes, and the time each took from request start to its last byte, added up (parallel requests each count their own time). |
| `request_media_ttfb_ms`, `request_media_ttfb_count` | the time to first byte of those whose first byte the player reports, added up, and how many those were. |
| `request_media_max_ttfb_ms` | the longest of those. |

**Requests.** A player that reports its network requests gives the SDK, per request: its type
(`manifest`, `video`, `audio`, `video_init`, `audio_init`, `media`, `subtitle`,
`encryption`), start time, first-byte time (when known), end time, bytes, hostname, response
headers, and for a failure the error name, HTTP status and text. Completed requests only add to
the totals above; a failed or aborted one is also an event. The `X-CDN` response header, when
the CDN sets one, names the view's CDN (`video.cdn`, unless the app set it): the latest value
wins, and each change is a `cdnchange` event.

**Rendition, player and video details.** `rendition` holds what the player tells about what
plays: `video_codec` and `audio_codec` (as the player names them: `avc1.640028`, `hvc1`, `mp4a`),
`framerate`, `dynamic_range` (`SDR`, `HDR10`, `HLG`, `Dolby Vision`), and the first rendition of
the view: `initial_bitrate_kbps`, `initial_width`, `initial_height`. `metrics.rendition_upshifts`
and `rendition_downshifts` count quality switches up and down after the first frame (by bitrate,
or by size where the player tells no bitrate). `player.software` and `software_version` name the
player library (`Shaka Player`, `Media3`, `AVPlayer`…) where `player.name` is the app's own name for
the player; `player.instance_id` is one id per player, `player.language` the viewer's language,
`player.poster` the poster image's address without its query, `player.preload` whether the player
loads before play, `player.time_shift` a live stream the viewer can rewind, and
`player.remote_played` whether the view played on another screen (AirPlay, Cast, the Remote
Playback API: a `playbackmodechange` to `remote`). `video.affiliate`, `brand`, `producer`,
`creator_id` and `variant_id` are the app's; `video.drm_level` is the DRM's security level
(Widevine `L1` / `L3`, read by the Android SDK); `video.cdn_edge_pop` is the CDN edge that served
the last request, from `X-Amz-Cf-Pop`, `X-Served-By`, `CF-Ray`, `X-Edge-Location` or `X-CDN-PoP`.

**More view fields.** `video.content_type` (episode, movie, trailer…), `video.language_code`,
`video.variant_name`, `video.encoding_variant`, `experiment_name` (an A/B test) and
`sub_property_id` (a part of the service) are the app's, for breakdowns. `player.captions` says
whether captions were shown at some point. `custom` holds up to ten values, `"1"` … `"10"`.

**View fields.** `video.cdn` and `video.drm_type` (`widevine`, `playready`, `fairplay`,
`clearkey`) come from the player where it tells, else from the app. `player.fullscreen` and
`player.pip` say whether the view was ever fullscreen or picture-in-picture; each change of
mode is a `playbackmodechange` event (`standard`, `fullscreen`, `pip`, or the app's own name).
`page` is web only: `url` without its query or fragment, `type` `watchpage` or `iframe`.
`view_session_id` is the app's own id for the view, to join the view with CDN logs: give the
player's CMCD (`sid`) the same value. The SDKs leave it out when the app sets none.
Time inside an ad break is not content time: it is neither watch, playing nor rebuffering
time, and a pre-roll does not count towards video startup time.

`custom` holds up to ten of the customer's own dimensions (`"1"` … `"10"`, 255 characters
each), e.g. a page type or a customer segment. The Console breaks views down by them.
`device.app_id` is the app's package / bundle id, or the site's host on the web.

### Events

`t` is milliseconds since the view started. Types: `viewstart`, `play`, `playing`, `pause`,
`requestfailed` (`data: {"type", "hostname", "error", "code", "text"}`), `requestcanceled`
(`data: {"type", "hostname"}`), `cdnchange` (`data: {"cdn"}`), `playbackmodechange`
(`data: {"mode"}`),
`seeking`, `seeked`, `rebufferstart`, `rebufferend`, `captions` (`data: {"on"}`), `rendition` (`data: {"kbps", "width",
"height"}`), `error` (`data: {"code", "message", "fatal"}`), `ended`, `viewend`, and for ads
`adrequest`, `adresponse`, `adbreakstart`, `adplay`, `adplaying`, `adpause`, `adended`,
`aderror` (`data: {"code", "message"}`), `adbreakend`.
The backend keeps the first 500 events of a view.

## When to send

- every 10 s while a view is open (also gives the Console its live viewer count)
- right away on `viewstart`, first `playing`, `error`, `ended`, `viewend`
- when the app goes to the background / the page is hidden (web: `navigator.sendBeacon`)

A view ends (`ended: true`) on: video ended, fatal error, a new source, the player released,
or the app/page closed. A view with no beacon for 60 s is treated as ended by the backend.

## What the backend works out

Per view:

- `exited_before_start` (EBVS): ended, no first frame (no `video_startup_ms`), no failure, no
  business exception
- `startup_failed`: a fatal error (not a business exception) before the first frame
- `failed`: a fatal error (not a business exception) at any time
- `business_exception`: a fatal error the app marked as its own rule
- scores 0–100 (a view that never started gets only a playback success score):
  - playback success: 100; 50 when it exited before start (none when that took under 1 s); 0
    when it failed; none for a business exception
  - startup: `8 / (8 + video startup seconds) × 100` (400 ms → 95, 2 s → 80, 8 s → 50)
  - smoothness: the mean of `100 / √(1 + (rebuffer_count / 2)²)` and
    `100 × e^(−10 × rebuffer_ms / watch_ms)`
  - quality: `100 × e^(−0.33 × (0.15 × max upscale + 0.85 × average upscale))`, the upscale
    amounts as fractions (50 % → 0.5), average = `upscale_pct_ms / playing_ms`
  - overall: playback success / 100 × the mean of three tradeoffs, Tradeoff(smoothness, quality),
    Tradeoff(smoothness, startup), Tradeoff(startup, quality); Tradeoff(a, b) is the weighted
    harmonic mean `1 / (w / a + (1 − w) / b)` (0 when either is 0, the other when one is
    missing) with w = 0.6, 0.55 and 0.6, so the worse score weighs most and smoothness counts
    more than startup, startup more than quality. A view with only a success score has that.

A view counts in the metrics once it is over (ended, failed, or no beacon for 60 s). Engagement
metrics (views, viewers, watch and playing time, ads) take the views that started in the period;
the quality metrics and scores take the views that ended in it.

Across views (Console):

| Metric | Formula |
|---|---|
| Views | count of views |
| Unique viewers | distinct `device_id` |
| Playback failure % | failed views / views |
| Video startup failure % | startup-failed views / views |
| Video playback failure % | views that failed after their first frame / views |
| Business exceptions %, startup business exceptions % | views with a business exception (before the first frame) / views |
| Exits before start % | exited-before-start views / views |
| Video startup time, content startup time, ad pre-roll startup time | median and 95th percentile |
| Pre-roll request time, pre-roll load time, player startup, page load | median |
| Requests for the first pre-roll | mean of `preroll_requests` over views with a pre-roll |
| Aggregate startup time | median of page load + player startup + video startup (first view on a page) |
| Rebuffer % | Σ rebuffer_ms / Σ watch_ms |
| Rebuffer frequency | Σ rebuffer_count / (Σ watch_ms in minutes) |
| Rebuffer duration, rebuffer count | Σ rebuffer_ms / views, Σ rebuffer_count / views |
| Seek latency | Σ seek_ms / Σ seek_count |
| Upscale % / Downscale % | Σ upscale_pct_ms / Σ playing_ms (the amount, weighted by time; same for downscale) |
| Max upscale % / max downscale % | mean of the views' largest amounts |
| Live latency | mean over live views, leaving out viewers more than 5 minutes behind |
| Average bitrate | Σ (avg_bitrate × playing_ms) / Σ playing_ms |
| Watch time / Playing time | Σ watch_ms / Σ playing_ms |
| Live viewers | views with a beacon in the last 30 s and not ended |
| Ads played / ad watch time | Σ ad_count / Σ ad_watch_ms |
| Ad errors % | Σ ad_error_count / Σ ad_count |
| Views with ads % | views with an ad / views |
| Scores | mean of each view score |
| Request throughput | Σ request_media_bytes × 8 / Σ request_media_ms (Mbps) |
| Request latency | Σ request_media_ttfb_ms / Σ request_media_ttfb_count |
| Max request latency | mean of the views' request_media_max_ttfb_ms |
| Request failures % | Σ request_failed / (Σ request_completed + Σ request_failed) |
| Failed manifest / media / encryption requests | Σ of each |
| Views dropped % | views the SDK stopped sending for without ending them / views |
| Playing time per view | Σ playing_ms / views (average) and the median |
| Average completion | mean of min(playhead_ms / duration_ms, 1) over on-demand views with a length |
| Medians and 95th percentiles per view | player startup, page load, aggregate startup, rebuffer duration and count, rendition changes, upshifts, downshifts, upscale and downscale amounts (each view's average and largest), live latency; bitrate's poorer views are its 5th percentile |
| Negative impact (Insights, breakdowns) | (value − overall value) in the bad direction × the group's share of the views |

Breakdowns group these by: environment, platform, os, os version, device model, manufacturer,
browser, browser version, app or site, app version, player, player version, SDK version,
autoplay, fullscreen, picture-in-picture, captions, DRM type, page type, page URL, continent,
country, region, ASN, connection, video, series, content type, language, variant, encoding
variant, experiment, sub-property, stream type, source type, source hostname, CDN, error code,
viewer, custom 1–10.

Breakdowns also group by device category and name, player software and its version, player
language, poster, preload, playing on another screen, time shift, DRM level, video and audio codec,
dynamic range, video height and initial height, CDN trace (every CDN a view used) and edge, viewer
plan, plan status and plan category, video affiliate, brand, producer, creator and variant id, city,
error message (grouped: addresses, ids, long numbers and decoder names taken out), and the view's
own outcome: playback failure, video startup failure, exited before video start, business
exception, startup business exception, view dropped (the SDK stopped sending without ending the
view), has ad.

Continent, country, region, city (with its coordinates rounded to a tenth of a degree) and ASN come
from Cloudflare's request headers when the request passed through Cloudflare (`CF-IPContinent`,
`CF-IPCountry`, `CF-Region`, `CF-IPCity`, `CF-IPLatitude`, `CF-IPLongitude`, and `X-Client-ASN`, which
a transform rule fills from `ip.src.asnum`). The viewer's IP address is never stored.

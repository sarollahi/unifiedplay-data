import 'package:flutter_test/flutter_test.dart';
import 'package:unifiedplay_data/unifiedplay_data.dart';

void main() {
  var time = 0.0;
  ViewTracker tracker([VideoInfo video = const VideoInfo(id: 'ep_1')]) => ViewTracker(video, const PlayerInfo('test'), now: () => time);
  Map<String, Object?> metricsOf(Map<String, Object?> snapshot) => snapshot['metrics']! as Map<String, Object?>;
  List<Object?> typesOf(Map<String, Object?> snapshot) => [for (final e in snapshot['events']! as List) (e as Map)['type']];

  setUp(() => time = 0);

  test('splits time into startup, playing, rebuffering and seeking', () {
    final view = tracker();
    view.playerStartup(100);
    view.play();
    time += 800;
    view.playing();
    time += 5000;
    view.bufferingStart();
    time += 1200;
    view.bufferingEnd();
    time += 3000;
    view.seeking();
    time += 400;
    view.seeked(paused: false);
    time += 100;
    view.playing();
    time += 2000;
    view.pause();
    time += 10000;
    final snapshot = view.snapshot(maxEvents: 100);
    final m = metricsOf(snapshot);
    expect(m['player_startup_ms'], 100);
    expect(m['video_startup_ms'], 800);
    expect(m['rebuffer_ms'], 1200);
    expect(m['seek_ms'], 500);
    expect(m['playing_ms'], 10000);
    expect(m['watch_ms'], 12500);
    expect(typesOf(snapshot), ['viewstart', 'play', 'playing', 'rebufferstart', 'rebufferend', 'playing', 'seeking', 'seeked', 'playing', 'pause']);
  });

  test('adds up requests, counts failures by type and names the CDN', () {
    final view = tracker(const VideoInfo(id: 'ep_1', viewSessionId: 'cmcd-1'));
    view.requestCompleted(const RequestInfo(type: 'manifest', start: 0, responseStart: 50, responseEnd: 80, bytes: 2000, headers: {'X-CDN': 'fastly'}));
    view.requestCompleted(const RequestInfo(type: 'video', start: 100, responseStart: 140, responseEnd: 1100, bytes: 1250000));
    view.requestCompleted(const RequestInfo(type: 'audio', start: 100, responseStart: 160, responseEnd: 600, bytes: 125000, headers: {'x-cdn': 'cloudflare'}));
    view.requestCompleted(const RequestInfo(type: 'video_init', start: 0, responseEnd: 10, bytes: 900));
    view.requestFailed(const RequestInfo(type: 'video', hostname: 'cdn.example.com', errorCode: 503));
    view.requestFailed(const RequestInfo(type: 'encryption', errorCode: 403));
    view.requestCanceled(const RequestInfo(type: 'audio'));
    view.playbackMode('fullscreen');
    view.playbackMode('fullscreen');
    view.playbackMode('standard');
    final snapshot = view.snapshot(maxEvents: 100);
    final m = metricsOf(snapshot);
    expect(m['request_completed'], 4);
    expect(m['request_failed'], 2);
    expect(m['request_failed_media'], 1);
    expect(m['request_failed_encryption'], 1);
    expect(m['request_media_completed'], 2);
    expect(m['request_media_bytes'], 1375000);
    expect(m['request_media_ms'], 1500);
    expect(m['request_media_ttfb_ms'], 100);
    expect(m['request_media_max_ttfb_ms'], 60);
    expect((snapshot['video']! as Map)['cdn'], 'cloudflare');
    expect((snapshot['player']! as Map)['fullscreen'], true);
    expect(snapshot['view_session_id'], 'cmcd-1');
    expect(typesOf(snapshot).where((t) => t == 'cdnchange').length, 2);
  });

  test('sends to the beacon domain and stops on a bad key', () async {
    final urls = <Uri>[];
    final data = DataClient(const DataConfig(key: 'up_data_test', beaconDomain: 'data.example.com'), deviceId: 'd1',
        send: (url, body, headers) async {
      urls.add(url);
      return (status: 401, enabled: null);
    });
    data.add(tracker());
    await data.flush();
    expect(urls.single.toString(), 'https://data.example.com/api/v1/data/beacons');
    expect(data.disabled, true);
  });
}

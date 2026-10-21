import 'dart:math';

/// What one view plays.
class VideoInfo {
  const VideoInfo({
    this.id,
    this.title,
    this.seriesId,
    this.seriesTitle,
    this.durationMs,
    this.streamType = 'on-demand',
    this.sourceType,
    this.sourceHost,
    this.cdn,
    this.drmType,
    this.viewSessionId,
    this.custom = const {},
  });

  final String? id;
  final String? title;
  final String? seriesId;
  final String? seriesTitle;
  final int? durationMs;
  final String streamType;
  final String? sourceType;
  final String? sourceHost;

  /// The CDN serving the video, when you know it.
  final String? cdn;

  /// widevine, playready, fairplay or clearkey.
  final String? drmType;

  /// Your own id for this view, to join it with CDN logs: give your CMCD session id the same value.
  final String? viewSessionId;

  /// Up to five of your own dimensions (1..5); the Console breaks views down by them.
  final Map<int, String> custom;
}

class PlayerInfo {
  const PlayerInfo(this.name, {this.version, this.autoplay = false});
  final String name;
  final String? version;
  final bool autoplay;
}

/// One network request for the content (spec: Requests). type: manifest, video, audio, video_init,
/// audio_init, media, subtitle or encryption. Times are milliseconds on any one clock.
class RequestInfo {
  const RequestInfo({
    this.type,
    this.hostname,
    this.start,
    this.responseStart,
    this.responseEnd,
    this.bytes,
    this.headers = const {},
    this.error,
    this.errorCode,
    this.errorText,
  });

  final String? type;
  final String? hostname;
  final num? start;
  final num? responseStart;
  final num? responseEnd;
  final int? bytes;

  /// Response headers: X-CDN names the CDN.
  final Map<String, String> headers;
  final String? error;
  final int? errorCode;
  final String? errorText;
}

const _mediaRequests = {'video', 'audio', 'media'};
const _failedMedia = {'video', 'audio', 'media', 'video_init', 'audio_init'};

/// widevine, playready, fairplay or clearkey from a key system name or scheme UUID ('' when unknown).
String drmTypeOf(String? keySystem) {
  final name = (keySystem ?? '').toLowerCase();
  if (name.contains('widevine') || name.contains('edef8ba9')) return 'widevine';
  if (name.contains('playready') || name.contains('9a04f079')) return 'playready';
  if (name.contains('fairplay') || name.contains('apple.fps') || name.contains('streamingkeydelivery') || name.contains('94ce86fb')) return 'fairplay';
  if (name.contains('clearkey') || name.contains('e2719d58') || name.contains('1077efec')) return 'clearkey';
  return '';
}

enum _State { idle, starting, playing, paused, rebuffering, seeking, ad, ended }

const _watching = {_State.starting, _State.playing, _State.rebuffering, _State.seeking};

String _newId() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

/// One view: what happened since playback of one video was asked for, and the totals the beacon
/// carries (spec/beacon.md). The web (tracker.ts), Android (ViewTracker.kt), iOS
/// (ViewTracker.swift) and Roku SDKs do the same; change them together.
class ViewTracker {
  ViewTracker(this.video, this.player, {double Function()? now})
      : _now = now ?? (() => DateTime.now().microsecondsSinceEpoch / 1000),
        cdn = video.cdn ?? '',
        drmType = video.drmType ?? '' {
    _t0 = _now();
    _since = _t0;
    _event('viewstart');
  }

  final VideoInfo video;
  final PlayerInfo player;
  final double Function() _now;
  final String viewId = _newId();
  final String _startedAt = DateTime.now().toUtc().toIso8601String();
  late final double _t0;
  late double _since;
  int _seq = 0;
  _State _state = _State.idle;
  double? _playRequestedAt;
  bool _firstFrame = false;
  final List<Map<String, Object?>> _events = [];
  Map<String, Object?>? _error;
  double? _kbps;
  double _bitrateMs = 0;
  double _bitratePlayingMs = 0;
  int? _videoWidth;
  int? _videoHeight;
  int? _playerWidth;
  int? _playerHeight;
  _State _beforeAd = _State.idle;
  double _adBreakAt = 0;
  double _startupAdMs = 0;
  double? _adPlayingSince;
  String cdn;
  String drmType;
  bool _fullscreen = false;
  bool _pip = false;
  String _mode = 'standard';
  bool ended = false;

  double? playerStartupMs;
  double? videoStartupMs;
  double _watchMs = 0, _playingMs = 0, _rebufferMs = 0, _seekMs = 0, _playheadMs = 0;
  int _rebufferCount = 0, _seekCount = 0, _renditionChanges = 0, _droppedFrames = 0;
  double? _maxBitrateKbps;
  double _upscaleMs = 0, _downscaleMs = 0, _maxUpscalePct = 0;
  double? _liveLatencyMs;
  int _adBreakCount = 0, _adCount = 0, _adErrorCount = 0;
  double _adWatchMs = 0;
  int _requestCompleted = 0, _requestFailed = 0, _requestCanceled = 0;
  int _requestFailedManifest = 0, _requestFailedMedia = 0, _requestFailedEncryption = 0;
  int _requestMediaCompleted = 0, _requestMediaBytes = 0, _requestMediaTtfbCount = 0;
  double _requestMediaMs = 0, _requestMediaTtfbMs = 0, _requestMediaMaxTtfbMs = 0;

  void playerStartup(double ms) {
    if (playerStartupMs == null && ms.isFinite) playerStartupMs = max(0, ms);
  }

  /// Playback was asked for (play pressed, autoplay).
  void play() {
    if (ended || _state == _State.ad) return;
    _event('play');
    if (!_firstFrame) {
      _playRequestedAt ??= _now();
      _move(_State.starting);
    }
  }

  /// Frames are moving: the first one, after a stall, a seek or a pause.
  void playing() {
    if (ended || _state == _State.ad) return;
    if (!_firstFrame) {
      _firstFrame = true;
      videoStartupMs = _now() - (_playRequestedAt ?? _t0) - _startupAdMs;
    }
    if (_state == _State.rebuffering) _event('rebufferend');
    if (_state != _State.playing) _event('playing');
    _move(_State.playing);
  }

  void pause() {
    if (ended || _state == _State.paused || _state == _State.ad) return;
    if (_state == _State.rebuffering) _event('rebufferend');
    _event('pause');
    _move(_State.paused);
  }

  /// Only a stall after the first frame and outside a seek is rebuffering.
  void bufferingStart() {
    if (_state != _State.playing) return;
    _rebufferCount += 1;
    _event('rebufferstart');
    _move(_State.rebuffering);
  }

  void bufferingEnd() {
    if (_state == _State.rebuffering) playing();
  }

  void seeking() {
    if (ended || !_firstFrame || _state == _State.seeking || _state == _State.ad) return;
    _seekCount += 1;
    _event('seeking');
    _move(_State.seeking);
  }

  void seeked({required bool paused}) {
    if (_state != _State.seeking) return;
    _event('seeked');
    if (paused) _move(_State.paused);
  }

  void rendition(double? kbps, int? width, int? height) {
    if (_state == _State.ad) return;
    if (kbps == _kbps && width == _videoWidth && height == _videoHeight) return;
    _account();
    if (_firstFrame) _renditionChanges += 1;
    _kbps = kbps;
    _videoWidth = width;
    _videoHeight = height;
    if (kbps != null) _maxBitrateKbps = max(_maxBitrateKbps ?? 0, kbps.roundToDouble());
    _event('rendition', {'kbps': kbps?.round(), 'width': width, 'height': height});
  }

  void playerSize(int width, int height) {
    if (width == _playerWidth && height == _playerHeight) return;
    _account();
    _playerWidth = width > 0 ? width : null;
    _playerHeight = height > 0 ? height : null;
  }

  void playhead(double ms) {
    if (ms.isFinite && _state != _State.ad) _playheadMs = max(_playheadMs, ms);
  }

  void droppedFrames(int total) => _droppedFrames = max(_droppedFrames, total);

  void liveLatency(double ms) {
    if (ms.isFinite) _liveLatencyMs = max(0, ms);
  }

  void failed(String code, String message, {bool fatal = true}) {
    if (ended) return;
    _event('error', {'code': code, 'message': message, 'fatal': fatal});
    if (!fatal) return;
    _error = {'code': code, 'message': message, 'fatal': fatal};
    end();
  }

  void completed() {
    if (ended) return;
    _event('ended');
    end();
  }

  void end() {
    if (ended) return;
    _stopAdClock();
    _move(_State.ended);
    ended = true;
    _event('viewend');
  }

  // Ads: an ad break is no video time, and a pre-roll is no part of video startup.
  void adBreakStart() {
    if (ended || _state == _State.ad) return;
    if (_state == _State.idle) _playRequestedAt ??= _now();
    _beforeAd = _state == _State.idle ? _State.starting : _state;
    _adBreakAt = _now();
    _adBreakCount += 1;
    _event('adbreakstart');
    _move(_State.ad);
  }

  void adStart() {
    if (ended) return;
    if (_state != _State.ad) adBreakStart();
    _adCount += 1;
    _event('adplay');
  }

  void adPlaying() {
    if (_state != _State.ad || _adPlayingSince != null) return;
    _adPlayingSince = _now();
    _event('adplaying');
  }

  void adPause() {
    if (_state != _State.ad) return;
    _stopAdClock();
    _event('adpause');
  }

  void adEnd() {
    if (_state != _State.ad) return;
    _stopAdClock();
    _event('adended');
  }

  void adError(String code, [String message = '']) {
    if (ended) return;
    _stopAdClock();
    _adErrorCount += 1;
    _event('aderror', {'code': code, 'message': message});
  }

  void adBreakEnd() {
    if (_state != _State.ad) return;
    _stopAdClock();
    if (!_firstFrame) _startupAdMs += _now() - _adBreakAt;
    _event('adbreakend');
    final back = _beforeAd;
    _move(back == _State.playing || back == _State.rebuffering || back == _State.seeking ? _State.paused : back);
  }

  /// A content request came back. Media segments add to the throughput and latency totals.
  void requestCompleted(RequestInfo request) {
    if (ended) return;
    _requestCompleted += 1;
    _cdnFrom(request);
    if (!_mediaRequests.contains(request.type ?? 'media')) return;
    _requestMediaCompleted += 1;
    _requestMediaBytes += max(0, request.bytes ?? 0);
    final start = request.start;
    if (start == null) return;
    if (request.responseEnd != null) _requestMediaMs += max(0, request.responseEnd! - start).toDouble();
    if (request.responseStart != null) {
      final ttfb = max(0, request.responseStart! - start).toDouble();
      _requestMediaTtfbMs += ttfb;
      _requestMediaTtfbCount += 1;
      _requestMediaMaxTtfbMs = max(_requestMediaMaxTtfbMs, ttfb);
    }
  }

  void requestFailed(RequestInfo request) {
    if (ended) return;
    _requestFailed += 1;
    final type = request.type;
    if (type == 'manifest') {
      _requestFailedManifest += 1;
    } else if (type == 'encryption') {
      _requestFailedEncryption += 1;
    } else if (_failedMedia.contains(type)) {
      _requestFailedMedia += 1;
    }
    _cdnFrom(request);
    _event('requestfailed', {'type': type, 'hostname': request.hostname, 'error': request.error, 'code': request.errorCode, 'text': request.errorText});
  }

  void requestCanceled(RequestInfo request) {
    if (ended) return;
    _requestCanceled += 1;
    _event('requestcanceled', {'type': request.type, 'hostname': request.hostname});
  }

  /// standard, fullscreen, pip, or your own name.
  void playbackMode(String mode) {
    if (mode == _mode) return;
    _mode = mode;
    if (mode == 'fullscreen') _fullscreen = true;
    if (mode == 'pip') _pip = true;
    _event('playbackmodechange', {'mode': mode});
  }

  void setDrmType(String type) {
    if (type.isNotEmpty) drmType = type;
  }

  void _cdnFrom(RequestInfo request) {
    // An app-set CDN wins; otherwise the latest X-CDN header names it.
    final entry = request.headers.entries.where((e) => e.key.toLowerCase() == 'x-cdn');
    if (entry.isEmpty || video.cdn != null) return;
    final value = entry.first.value.trim();
    final name = value.length > 64 ? value.substring(0, 64) : value;
    if (name.isEmpty || name == cdn) return;
    cdn = name;
    _event('cdnchange', {'cdn': name});
  }

  /// The view as the next beacon sends it, with its oldest unsent events.
  Map<String, Object?> snapshot({int maxEvents = 25}) {
    _account();
    final playing = _adPlayingSince;
    if (playing != null) {
      final now = _now();
      _adWatchMs += now - playing;
      _adPlayingSince = now;
    }
    _seq += 1;
    int? whole(double? value) => value?.round();
    return {
      'view_id': viewId,
      'seq': _seq,
      'started_at': _startedAt,
      'ended': ended,
      'video': {
        'id': video.id, 'title': video.title, 'series_id': video.seriesId, 'series_title': video.seriesTitle,
        'duration_ms': video.durationMs, 'stream_type': video.streamType, 'source_type': video.sourceType,
        'source_host': video.sourceHost, 'cdn': cdn.isEmpty ? null : cdn, 'drm_type': drmType.isEmpty ? null : drmType,
      },
      'player': {
        'name': player.name, 'version': player.version, 'autoplay': player.autoplay,
        'width': _playerWidth, 'height': _playerHeight, 'fullscreen': _fullscreen, 'pip': _pip,
      },
      if (video.viewSessionId != null) 'view_session_id': video.viewSessionId,
      'metrics': {
        'player_startup_ms': whole(playerStartupMs),
        'video_startup_ms': whole(videoStartupMs),
        'watch_ms': _watchMs.round(),
        'playing_ms': _playingMs.round(),
        'rebuffer_count': _rebufferCount,
        'rebuffer_ms': _rebufferMs.round(),
        'seek_count': _seekCount,
        'seek_ms': _seekMs.round(),
        'playhead_ms': _playheadMs.round(),
        'avg_bitrate_kbps': _bitratePlayingMs > 0 ? (_bitrateMs / _bitratePlayingMs).round() : null,
        'max_bitrate_kbps': whole(_maxBitrateKbps),
        'rendition_changes': _renditionChanges,
        'video_width': _videoWidth,
        'video_height': _videoHeight,
        'upscale_ms': _upscaleMs.round(),
        'downscale_ms': _downscaleMs.round(),
        'max_upscale_pct': _maxUpscalePct,
        'dropped_frames': _droppedFrames,
        'live_latency_ms': whole(_liveLatencyMs),
        'ad_break_count': _adBreakCount,
        'ad_count': _adCount,
        'ad_watch_ms': _adWatchMs.round(),
        'ad_error_count': _adErrorCount,
        'request_completed': _requestCompleted,
        'request_failed': _requestFailed,
        'request_canceled': _requestCanceled,
        'request_failed_manifest': _requestFailedManifest,
        'request_failed_media': _requestFailedMedia,
        'request_failed_encryption': _requestFailedEncryption,
        'request_media_completed': _requestMediaCompleted,
        'request_media_bytes': _requestMediaBytes,
        'request_media_ms': _requestMediaMs.round(),
        'request_media_ttfb_ms': _requestMediaTtfbMs.round(),
        'request_media_ttfb_count': _requestMediaTtfbCount,
        'request_media_max_ttfb_ms': _requestMediaMaxTtfbMs.round(),
      },
      'custom': {for (final e in video.custom.entries) if (e.value.isNotEmpty) '${e.key}': e.value},
      'error': _error,
      'events': _events.take(maxEvents).toList(),
    };
  }

  /// The backend took the first [count] events.
  void sent(int count) => _events.removeRange(0, min(count, _events.length));

  void _event(String type, [Map<String, Object?>? data]) {
    final t = (_now() - _t0).round();
    _events.add(data == null ? {'t': t, 'type': type} : {'t': t, 'type': type, 'data': data});
  }

  void _move(_State next) {
    _account();
    _state = next;
  }

  void _stopAdClock() {
    final since = _adPlayingSince;
    if (since == null) return;
    _adWatchMs += _now() - since;
    _adPlayingSince = null;
  }

  /// Adds the time since the last change to the totals of the state the view is in.
  void _account() {
    final now = _now();
    final ms = max(0.0, now - _since);
    _since = now;
    if (ended || ms == 0) return;
    if (_watching.contains(_state)) _watchMs += ms;
    if (_state == _State.rebuffering) _rebufferMs += ms;
    if (_state == _State.seeking) _seekMs += ms;
    if (_state != _State.playing) return;
    _playingMs += ms;
    final kbps = _kbps;
    if (kbps != null) {
      _bitrateMs += kbps * ms;
      _bitratePlayingMs += ms;
    }
    final vw = _videoWidth, vh = _videoHeight, pw = _playerWidth, ph = _playerHeight;
    if (vw != null && vh != null && pw != null && ph != null && vw > 0 && vh > 0) {
      final scale = min(pw / vw, ph / vh);
      if (scale > 1) {
        _upscaleMs += ms;
        _maxUpscalePct = max(_maxUpscalePct, ((scale - 1) * 1000).round() / 10);
      } else if (scale < 1) {
        _downscaleMs += ms;
      }
    }
  }
}

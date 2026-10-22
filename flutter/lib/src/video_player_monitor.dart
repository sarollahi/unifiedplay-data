import 'package:video_player/video_player.dart';

import 'data_client.dart';
import 'view_tracker.dart';

/// Watches a video_player VideoPlayerController. A view starts when playback is asked for (play()
/// or autoplay), so a preloaded video nobody plays is no view; call [newVideo] before you load
/// another source on the same controller, and [release] when you dispose of it. video_player tells
/// no network requests; fullscreen and picture-in-picture are yours to report ([playbackMode]).
///
/// ```dart
/// final monitor = VideoPlayerMonitor(data, controller, const VideoInfo(id: 'ep_1', title: 'Pilot'));
/// ```
class VideoPlayerMonitor {
  VideoPlayerMonitor(this.client, this.controller, this._video, {String? version})
      : _player = PlayerInfo('video_player', version: version, software: 'video_player', softwareVersion: version) {
    _sourceAt = _now();
    controller.addListener(_changed);
    _changed();
  }

  final DataClient client;
  final VideoPlayerController controller;
  final PlayerInfo _player;
  VideoInfo _video;
  ViewTracker? _view;
  double? _sourceAt;
  double? _readyAt;
  bool _wasPlaying = false;
  bool _wasBuffering = false;
  Duration _lastPosition = Duration.zero;
  double _lastPositionAt = 0;
  String _mode = 'standard';
  bool _captionsOn = false;

  static double _now() => DateTime.now().microsecondsSinceEpoch / 1000;

  /// The open view, if any.
  ViewTracker? get view => _view;

  /// The next source is a different video: the open view ends.
  void newVideo(VideoInfo video) {
    final open = _view;
    if (open != null && !open.ended) {
      open.end();
      client.flush();
    }
    _view = null;
    _video = video;
    _sourceAt = _now();
    _readyAt = null;
    _wasPlaying = false;
  }

  /// Captions turned on or off (video_player has no caption state of its own).
  void captions(bool on) {
    _captionsOn = _captionsOn || on;
    _view?.captions(on);
  }

  /// Your own rule stopped playback (geo-block, paywall, too many streams): the view ends without failing.
  void businessException(String code, [String message = '']) {
    _current().failed(code, message, businessException: true);
    client.flush();
  }

  /// Your ad code: an ad request went out / its response was read (pre-roll request time), and the ad events.
  void adRequest() => _current().adRequest();
  void adResponse() => _view?.adResponse();
  void adBreakStart() {
    _current().adBreakStart();
    client.flush();
  }

  void adStart() => _current().adStart();
  void adPlaying() => _view?.adPlaying();
  void adPause() => _view?.adPause();
  void adEnd() => _view?.adEnd();
  void adError(String code, [String message = '']) => _current().adError(code, message);
  void adBreakEnd() {
    _view?.adBreakEnd();
    client.flush();
  }

  /// standard, fullscreen, pip, or your own name.
  void playbackMode(String mode) {
    _mode = mode;
    _view?.playbackMode(mode);
  }

  ViewTracker _current() {
    final open = _view;
    if (open != null && !open.ended) return open;
    final next = ViewTracker(_video, _player);
    _view = next;
    client.add(next);
    final source = _sourceAt, ready = _readyAt;
    if (source != null && ready != null) next.playerStartup(ready - source);
    if (_mode != 'standard') next.playbackMode(_mode);
    if (_captionsOn) next.captions(true);
    final size = controller.value.size;
    if (size.width > 0) next.rendition(null, size.width.round(), size.height.round());
    client.flush();
    return next;
  }

  void _changed() {
    final value = controller.value;
    if (value.isInitialized && _readyAt == null) {
      _readyAt = _now();
      final source = _sourceAt;
      if (source != null) _view?.playerStartup(_readyAt! - source);
    }
    if (value.hasError) {
      final open = _view ?? (value.isPlaying ? _current() : null);
      if (open != null && !open.ended) {
        open.failed('video_player', value.errorDescription ?? '');
        client.flush();
      }
      return;
    }
    if (value.isPlaying && !_wasPlaying) _current().play();
    final view = _view;
    if (view == null) {
      _wasPlaying = value.isPlaying;
      return;
    }
    final now = _now();
    final position = value.position;
    final moved = position > _lastPosition;
    // A jump much further than the time that passed is a seek.
    final jumped = (position - _lastPosition).inMilliseconds.abs() > (now - _lastPositionAt) + 1500 && view.videoStartupMs != null;
    if (jumped) {
      view.seeking();
      view.seeked(paused: !value.isPlaying);
    }
    if (value.isBuffering && !_wasBuffering) view.bufferingStart();
    if (!value.isBuffering && _wasBuffering) view.bufferingEnd();
    if (value.isPlaying && moved && !value.isBuffering) {
      final first = view.videoStartupMs == null;
      view.playing();
      if (first) client.flush();
    }
    if (!value.isPlaying && _wasPlaying && !value.isCompleted) {
      view.pause();
      client.flush();
    }
    if (value.isCompleted && !view.ended) {
      view.completed();
      client.flush();
    }
    final size = value.size;
    if (size.width > 0) view.rendition(null, size.width.round(), size.height.round());
    view.playhead(position.inMilliseconds.toDouble());
    _lastPosition = position;
    _lastPositionAt = now;
    _wasPlaying = value.isPlaying;
    _wasBuffering = value.isBuffering;
  }

  /// Stop watching: ends the open view and sends it.
  void release() {
    controller.removeListener(_changed);
    final open = _view;
    if (open != null && !open.ended) open.end();
    client.flush();
  }
}

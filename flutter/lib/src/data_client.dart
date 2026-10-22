import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'view_tracker.dart';

const sdkName = 'unifiedplay-data-flutter';
const sdkVersion = '1.1.0';
const _beaconPath = '/api/v1/data/beacons';
const _deviceKey = 'unifiedplay-data-device';
// A beacon carries at most this much, far under the backend's 64 KB; the rest goes with the next ones.
const _maxViews = 10;
const _maxEvents = 25;

class DataConfig {
  const DataConfig({
    required this.key,
    this.apiBase = 'https://backend.unifiedplay.com',
    this.beaconDomain,
    this.appVersion = '',
    this.userId,
    this.viewerPlan,
    this.viewerPlanStatus,
    this.viewerPlanCategory,
    this.interval = const Duration(seconds: 10),
    this.device = const {},
  });

  /// Your data key (up_data_…) from the Console's Video data page.
  final String key;

  /// Where beacons go. Defaults to UnifiedPlay.
  final String apiBase;

  /// Your own beacon host (data.example.com), set up in the Console: beacons go to
  /// https://{beaconDomain}, which blockers of other sites' hosts let through. Wins over apiBase.
  final String? beaconDomain;
  final String appVersion;

  /// Your own id for the viewer, if you want views per viewer: an opaque id, never an email.
  final String? userId;

  /// Your own words for the viewer's plan, for breakdowns: plan ("premium"), its status ("trialing"), its category ("sports").
  final String? viewerPlan;
  final String? viewerPlanStatus;
  final String? viewerPlanCategory;
  final Duration interval;

  /// Device fields Flutter cannot tell (manufacturer, model, os_version, app_id…).
  final Map<String, String> device;
}

typedef BeaconSender = Future<({int status, bool? enabled})> Function(Uri url, String body, Map<String, String> headers);

Future<({int status, bool? enabled})> _httpSend(Uri url, String body, Map<String, String> headers) async {
  final response = await http.post(url, body: body, headers: headers);
  bool? enabled;
  if (response.statusCode < 300) {
    try {
      enabled = (jsonDecode(response.body) as Map<String, dynamic>)['enabled'] as bool?;
    } catch (_) {}
  }
  return (status: response.statusCode, enabled: enabled);
}

/// Sends the views of every monitored player in one beacon: every 10 s, and right away on key
/// moments, also when the app goes to the background.
class DataClient with WidgetsBindingObserver {
  DataClient(this.config, {BeaconSender? send, String? deviceId}) : _send = send ?? _httpSend {
    _deviceId = deviceId;
    WidgetsFlutterBinding.ensureInitialized().addObserver(this);
    if (_deviceId == null) unawaited(_loadDeviceId());
  }

  final DataConfig config;
  final BeaconSender _send;
  final _views = <ViewTracker>{};
  final _sessionId = _randomId();
  String? _deviceId;
  Timer? _timer;
  bool _inFlight = false;
  bool _again = false;

  /// Off for this session: the tenant has Video data off, or the key is wrong.
  bool disabled = false;

  static String _randomId() => List<int>.generate(16, (_) => Random.secure().nextInt(256)).map((b) => b.toRadixString(16).padLeft(2, '0')).join();

  Future<void> _loadDeviceId() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      _deviceId = prefs.getString(_deviceKey) ?? _randomId();
      await prefs.setString(_deviceKey, _deviceId!);
    } catch (_) {
      _deviceId ??= _randomId();
    }
  }

  void add(ViewTracker view) {
    if (disabled) return;
    _views.add(view);
    _timer ??= Timer.periodic(config.interval, (_) => flush());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused || state == AppLifecycleState.inactive) flush();
  }

  String get _platform => switch (defaultTargetPlatform) {
        _ when kIsWeb => 'web',
        TargetPlatform.android => 'android',
        TargetPlatform.iOS => 'ios',
        TargetPlatform.macOS => 'macos',
        TargetPlatform.windows => 'windows',
        TargetPlatform.linux => 'linux',
        TargetPlatform.fuchsia => 'other',
      };

  Uri get _url {
    final domain = config.beaconDomain?.replaceFirst(RegExp(r'^https?://'), '').split('/').first;
    final base = domain != null && domain.isNotEmpty ? 'https://$domain' : config.apiBase.replaceFirst(RegExp(r'/$'), '');
    return Uri.parse('$base$_beaconPath');
  }

  /// Sends now. One beacon at a time; a call during one sends again when it is back.
  Future<void> flush() async {
    if (disabled || _views.isEmpty) return;
    if (_inFlight) {
      _again = true;
      return;
    }
    _inFlight = true;
    final views = _views.take(_maxViews).toList();
    final snapshots = [for (final view in views) view.snapshot(maxEvents: _maxEvents)];
    final body = jsonEncode({
      'sdk': {'name': sdkName, 'version': sdkVersion},
      'session_id': _sessionId,
      'viewer': {
        'device_id': _deviceId ?? '',
        'user_id': config.userId ?? '',
        'plan': config.viewerPlan,
        'plan_status': config.viewerPlanStatus,
        'plan_category': config.viewerPlanCategory,
      },
      'device': {'os': _platform, 'app_version': config.appVersion, ...config.device},
      'views': snapshots,
    });
    try {
      final result = await _send(_url, body, {'Content-Type': 'application/json', 'X-Tenant-Key': config.key, 'X-Platform': _platform});
      // 413: too big to ever go through, so its events are dropped (the totals still go next time).
      if ((result.status < 300 && result.enabled != false) || result.status == 413) {
        for (var i = 0; i < views.length; i++) {
          views[i].sent((snapshots[i]['events'] as List).length);
          // Only once the backend has the view's end: it may have ended while this beacon was out.
          if (snapshots[i]['ended'] == true) _views.remove(views[i]);
        }
      } else if (result.status < 300 || const [400, 401, 403, 404, 422].contains(result.status)) {
        _stop();
      }
      // 429, 5xx: the events stay and go with the next beacon.
    } catch (_) {
      // Offline: the same.
    } finally {
      _inFlight = false;
      if (_views.isEmpty) {
        _timer?.cancel();
        _timer = null;
      }
      if (_again && !disabled) {
        _again = false;
        unawaited(flush());
      }
    }
  }

  void _stop() {
    disabled = true;
    _views.clear();
    _timer?.cancel();
    _timer = null;
  }
}

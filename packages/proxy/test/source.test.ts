// Dart stack parsing for request → source (CONTRACTS §9.2): pure, no sockets.
import { describe, expect, it } from 'vitest';
import {
  FRAMEWORK_PACKAGES,
  isFrameworkPackage,
  isGeneratedEntryFrame,
  parseDartStack,
  pickAppFrame,
  toSourceInfo,
} from '../src/source';
import type { StackFrame } from '../src';

const ENTRY = 'file:///Users/dev/app/.dart_tool/flutter_intercept/entry_lib__main.dart';

// Shape of a real `StackTrace.current` from the entry's openUrl, reached via package:http.
const VM_HTTP = `#0      _InterceptedHttpClient.openUrl (${ENTRY}:120:23)
#1      IOClient.send (package:http/src/io_client.dart:94:38)
#2      BaseClient._sendUnstreamed (package:http/src/base_client.dart:93:38)
#3      BaseClient.get (package:http/src/base_client.dart:28:7)
#4      get.<anonymous closure> (package:http/http.dart:46:36)
#5      _withClient (package:http/http.dart:167:20)
<asynchronous suspension>
#6      _MyHomePageState._load (package:demo_app/main.dart:42:5)
<asynchronous suspension>
#7      _MyHomePageState.build.<anonymous closure> (package:demo_app/main.dart:88)
#8      _rootRun (dart:async/zone.dart:1399:13)
`;

describe('parseDartStack', () => {
  it('parses VM frames: fn, uri, line, column; async suspensions mark the next frame', () => {
    const f = parseDartStack(VM_HTTP);
    expect(f).toHaveLength(9);
    expect(f[0]).toEqual({ fn: '_InterceptedHttpClient.openUrl', uri: ENTRY, line: 120, column: 23 });
    expect(f[1]).toEqual({ fn: 'IOClient.send', uri: 'package:http/src/io_client.dart', line: 94, column: 38 });
    expect(f[4].fn).toBe('get.<anonymous closure>');
    expect(f[6]).toEqual({ fn: '_MyHomePageState._load', uri: 'package:demo_app/main.dart', line: 42, column: 5, afterAsyncGap: true });
    // frame without a column
    expect(f[7]).toEqual({ fn: '_MyHomePageState.build.<anonymous closure>', uri: 'package:demo_app/main.dart', line: 88, afterAsyncGap: true });
    expect(f[8]).toEqual({ fn: '_rootRun', uri: 'dart:async/zone.dart', line: 1399, column: 13 });
  });

  it('handles file:/// URIs (incl. Windows drive letters and parentheses), constructors, no line', () => {
    const f = parseDartStack(
      [
        '#0      main (file:///C:/Users/dev/app/bin/main.dart:10:5)',
        '#1      new ApiClient (file:///Users/dev/my%20app (1)/lib/api.dart:7:3)',
        '#2      _Closure.call (dart:core-patch/function.dart)',
        '#3      Foo.bar (package:x/y.dart:12)',
      ].join('\n'),
    );
    expect(f).toEqual([
      { fn: 'main', uri: 'file:///C:/Users/dev/app/bin/main.dart', line: 10, column: 5 },
      { fn: 'new ApiClient', uri: 'file:///Users/dev/my%20app (1)/lib/api.dart', line: 7, column: 3 },
      { fn: '_Closure.call', uri: 'dart:core-patch/function.dart' },
      { fn: 'Foo.bar', uri: 'package:x/y.dart', line: 12 },
    ]);
  });

  it('parses stack_trace Chain / terse traces with asynchronous gaps', () => {
    const chain = [
      'package:dio/src/dio_mixin.dart 341:30           DioMixin.fetch',
      'dart:async                                      _CustomZone.run',
      '===== asynchronous gap ===========================',
      'package:shop/data/api.dart 18:22                ShopApi.products',
      'package:shop/ui/list.dart 30                    _ListState.initState.<fn>',
      '/Users/dev/shop/test/widget_test.dart 5:7       main',
      'C:\\dev\\shop\\bin\\tool.dart 3:1                  run',
      'test/helpers.dart 9:2                           helper',
    ].join('\n');
    const f = parseDartStack(chain);
    expect(f).toEqual([
      { fn: 'DioMixin.fetch', uri: 'package:dio/src/dio_mixin.dart', line: 341, column: 30 },
      { fn: '_CustomZone.run', uri: 'dart:async' },
      { fn: 'ShopApi.products', uri: 'package:shop/data/api.dart', line: 18, column: 22, afterAsyncGap: true },
      { fn: '_ListState.initState.<fn>', uri: 'package:shop/ui/list.dart', line: 30 },
      { fn: 'main', uri: 'file:///Users/dev/shop/test/widget_test.dart', line: 5, column: 7 },
      { fn: 'run', uri: 'file:///C:/dev/shop/bin/tool.dart', line: 3, column: 1 },
      { fn: 'helper', uri: 'test/helpers.dart', line: 9, column: 2 },
    ]);
  });

  it('a VM trace and a chain gap mixed; gaps before the first frame are ignored', () => {
    const f = parseDartStack(
      '<asynchronous suspension>\n#0      a (package:x/a.dart:1:1)\n===== asynchronous gap ===\n#1      b (package:x/b.dart:2:2)',
    );
    expect(f).toEqual([
      { fn: 'a', uri: 'package:x/a.dart', line: 1, column: 1 },
      { fn: 'b', uri: 'package:x/b.dart', line: 2, column: 2, afterAsyncGap: true },
    ]);
  });

  it('skips non-frame lines (AOT non-symbolic traces, headers, garbage) and never throws', () => {
    const aot = [
      '*** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***',
      "pid: 1234, tid: 5678, name 1.ui",
      "build_id: '0123abcd'",
      '    #00 abs 000000000045ab12 virt 0000000000123456 _kDartIsolateSnapshotInstructions+0x1234',
      'hello world',
      '',
    ].join('\n');
    expect(parseDartStack(aot)).toEqual([]);
    expect(parseDartStack('')).toEqual([]);
    expect(parseDartStack(undefined as unknown as string)).toEqual([]);
    expect(parseDartStack('#0 broken (no-close-paren')).toEqual([]);
  });

  it('honours maxFrames (default 30), CRLF input', () => {
    const many = Array.from({ length: 50 }, (_, i) => `#${i}      f${i} (package:x/f.dart:${i + 1}:1)`).join('\r\n');
    expect(parseDartStack(many)).toHaveLength(30);
    expect(parseDartStack(many, 5).map((f) => f.fn)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
    expect(parseDartStack(many, 0)).toEqual([]);
  });
});

describe('pickAppFrame', () => {
  const fr = (uri: string, fn = 'f'): StackFrame => ({ fn, uri, line: 1 });

  it('skips dart:, the generated entry and framework packages', () => {
    const frames = [
      fr(ENTRY, '_InterceptedHttpClient.openUrl'),
      fr('package:http/src/io_client.dart'),
      fr('package:dio/src/dio.dart'),
      fr('package:dio_smart_retry/src/retry.dart'),
      fr('package:http_parser/src/x.dart'),
      fr('dart:async/zone.dart'),
      fr('package:flutter/src/widgets/framework.dart'),
      fr('package:demo_app/main.dart'),
    ];
    expect(pickAppFrame(frames)).toBe(7);
  });

  it('prefers the app packages when given, even below other non-framework packages', () => {
    const frames = [fr('package:my_api_client/api.dart'), fr('package:demo_app/main.dart')];
    expect(pickAppFrame(frames)).toBe(0);
    expect(pickAppFrame(frames, ['demo_app'])).toBe(1);
    expect(pickAppFrame(frames, ['not_there'])).toBe(0); // falls back
  });

  it('flutter_* apps (flutter create default names) are not framework', () => {
    expect(pickAppFrame([fr('package:flutter/src/a.dart'), fr('package:flutter_application_1/main.dart')])).toBe(1);
    expect(isFrameworkPackage('flutter_application_1')).toBe(false);
    for (const p of ['dio', 'http', 'flutter', 'dio_cache_interceptor', 'http_interceptor', 'gql_http_link', 'sentry_dio']) {
      expect(isFrameworkPackage(p)).toBe(true);
    }
    expect(FRAMEWORK_PACKAGES).toContain('retrofit');
  });

  it('file:// frames that are not the entry count as app code; none → undefined', () => {
    expect(pickAppFrame([fr('dart:io'), fr('file:///Users/dev/tool/bin/main.dart')])).toBe(1);
    expect(pickAppFrame([fr('dart:io'), fr('package:dio/dio.dart')])).toBeUndefined();
    expect(pickAppFrame([])).toBeUndefined();
  });

  it('recognises the generated entry by path or name, but not an app file named entry_*.dart under lib/', () => {
    expect(isGeneratedEntryFrame(fr(ENTRY))).toBe(true);
    expect(isGeneratedEntryFrame(fr('file:///x/entry_lib__main_1a2b3c4d.dart'))).toBe(true);
    expect(isGeneratedEntryFrame(fr('C:\\app\\.dart_tool\\flutter_intercept\\entry_bin__main.dart'))).toBe(true);
    expect(isGeneratedEntryFrame(fr('package:demo_app/entry_screen.dart'))).toBe(false);
    expect(isGeneratedEntryFrame(fr('package:demo_app/x.dart', '_InterceptedHttpClient.getUrl'))).toBe(true);
  });
});

describe('toSourceInfo', () => {
  it('drops the entry frames on top and points at the app frame', () => {
    const info = toSourceInfo(VM_HTTP, ['demo_app']);
    expect(info.frames[0].fn).toBe('IOClient.send');
    expect(info.frames.some((f) => f.uri === ENTRY)).toBe(false);
    expect(info.appFrame).toBe(5);
    expect(info.frames[info.appFrame!]).toMatchObject({ fn: '_MyHomePageState._load', line: 42, column: 5 });
  });

  it('keeps ≤ 30 frames, with a deep app frame inside the window', () => {
    const deep = [
      ...Array.from({ length: 60 }, (_, i) => `#${i}      Interceptor${i}.onRequest (package:dio/src/i.dart:${i + 1}:1)`),
      '#60     Repo.load (package:shop/repo.dart:12:3)',
      ...Array.from({ length: 20 }, (_, i) => `#${61 + i}      _rootRun (dart:async/zone.dart:1:1)`),
    ].join('\n');
    const info = toSourceInfo(deep);
    expect(info.frames.length).toBe(30);
    expect(info.frames[info.appFrame!]).toMatchObject({ fn: 'Repo.load', uri: 'package:shop/repo.dart' });
    expect(info.appFrame).toBe(20);
  });

  it('no app frame → frames only', () => {
    expect(toSourceInfo('#0      x (dart:io/a.dart:1:1)')).toEqual({ frames: [{ fn: 'x', uri: 'dart:io/a.dart', line: 1, column: 1 }] });
  });
});

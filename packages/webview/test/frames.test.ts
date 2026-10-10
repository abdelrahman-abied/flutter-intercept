// CONTRACTS §11.5 frames viewer helpers (pure) + the frame-filter benchmark.
import { describe, expect, it } from 'vitest';
import {
  capText, FrameCache, frameKey, MAX_EVENT_CHARS, closeCodeText, dirArrow, filterFrames, formatRelative, frameCounts, framePrettyJson, framePreview, frameTotal, hasFrames,
  hexDump, kindTitle, type Frame,
} from '../src/frames';
import { ex } from './fixtures';

const t = (text: string, over: Partial<Frame> = {}): Frame => ({ dir: 'receive', at: 0, kind: 'text', text, size: text.length, ...over });

describe('frames helpers', () => {
  it('hasFrames / frameTotal / kindTitle', () => {
    expect(hasFrames(ex())).toBe(false);
    expect(hasFrames(ex({ kind: 'websocket' }))).toBe(true);
    expect(hasFrames(ex({ kind: 'sse' }))).toBe(true);
    const w = ex({ kind: 'websocket', state: 'pending', frames: [t('a'), t('b')], framesDropped: 3 });
    expect(frameTotal(w)).toBe(5);
    expect(frameTotal(ex())).toBe(0);
    expect(kindTitle(w)).toBe('WebSocket · 5 messages (3 oldest dropped) · open');
    expect(kindTitle(ex({ kind: 'sse', frames: [t('a')], state: 'completed' }))).toBe('Server-sent events · 1 event');
  });

  it('direction, relative time, close codes', () => {
    expect(dirArrow({ dir: 'send' })).toBe('↑');
    expect(dirArrow({ dir: 'receive' })).toBe('↓');
    expect(formatRelative(1042, 1000)).toBe('+0.042 s');
    expect(formatRelative(13_450, 1000)).toBe('+12.4 s');
    expect(formatRelative(1000 + 182_000, 1000)).toBe('+3m 02s');
    expect(formatRelative(1000 + 3_840_000, 1000)).toBe('+1h 04m');
    expect(formatRelative(0, 1000)).toBe('+0.000 s');
    expect(closeCodeText(1000)).toBe('1000 (normal closure)');
    expect(closeCodeText(1006)).toBe('1006 (abnormal closure (no close frame))');
    expect(closeCodeText(4001)).toBe('4001 (application-defined)');
    expect(closeCodeText(2999)).toBe('2999');
    expect(closeCodeText(undefined)).toBe('no status code');
  });

  it('previews', () => {
    expect(framePreview(t('{"a":\n  1}'))).toBe('{"a": 1}');
    expect(framePreview(t('x'.repeat(500))).length).toBe(160);
    expect(framePreview({ dir: 'receive', at: 0, kind: 'binary', base64: 'AAEC', size: 2048 })).toBe('binary · 2.0 kB');
    expect(framePreview({ dir: 'send', at: 0, kind: 'ping', size: 0 })).toBe('ping');
    expect(framePreview({ dir: 'send', at: 0, kind: 'pong', text: 'p', size: 1 })).toBe('pong · p');
    expect(framePreview({ dir: 'receive', at: 0, kind: 'close', closeCode: 1001, text: 'bye', size: 5 })).toBe('close 1001 (going away) · bye');
    expect(framePreview(t('data', { kind: 'event', event: 'tick' }))).toBe('data');
  });

  it('pretty JSON only for complete JSON objects / arrays', () => {
    expect(framePrettyJson(t('{"a":1}'))).toBe('{\n  "a": 1\n}');
    expect(framePrettyJson(t('[1,2]'))).toContain('\n');
    expect(framePrettyJson(t('{"a":'))).toBeUndefined();
    expect(framePrettyJson(t('42'))).toBeUndefined();
    expect(framePrettyJson(t('{"a":1}', { truncated: true }))).toBeUndefined();
    expect(framePrettyJson({})).toBeUndefined();
  });

  it('hex dump of the first bytes', () => {
    const bytes = Array.from({ length: 40 }, (_, i) => (i === 1 ? 0x41 : i));
    const b64 = btoa(String.fromCharCode(...bytes));
    const d = hexDump(b64, 32);
    expect(d.shown).toBe(32);
    const lines = d.text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith('00000000  00 41 02 03')).toBe(true);
    expect(lines[0].endsWith('.A..............')).toBe(true);
    expect(lines[1].startsWith('00000010  10 11')).toBe(true);
    expect(hexDump('@@@@').text).toBe('(not valid base64)');
  });

  it('filterFrames: words AND-ed, -word excludes, matches SSE event / id and close codes; direction filter', () => {
    const frames: Frame[] = [
      t('{"type":"price","id":1}'),
      t('{"type":"subscribe"}', { dir: 'send' }),
      t('Hello World', { kind: 'event', event: 'order.updated', id: '77' }),
      { dir: 'receive', at: 0, kind: 'close', closeCode: 1006, size: 2 },
      { dir: 'receive', at: 0, kind: 'binary', base64: 'AAAA', size: 3 },
    ];
    expect(filterFrames(frames, '')).toEqual([0, 1, 2, 3, 4]);
    expect(filterFrames(frames, 'TYPE')).toEqual([0, 1]);
    expect(filterFrames(frames, 'type -price')).toEqual([1]);
    expect(filterFrames(frames, 'order.updated')).toEqual([2]);
    expect(filterFrames(frames, '77')).toEqual([2]);
    expect(filterFrames(frames, '1006')).toEqual([3]);
    expect(filterFrames(frames, 'binary')).toEqual([4]);
    expect(filterFrames(frames, '', 'send')).toEqual([1]);
    expect(filterFrames(frames, 'type', 'receive')).toEqual([0]);
    expect(filterFrames(frames, ' - ')).toEqual([0, 1, 2, 3, 4]);
    expect(frameCounts(frames)).toEqual({ sent: 1, received: 4 });
  });
});

describe('FrameCache (REVIEW-5 #4: windows are re-sent as new objects)', () => {
  const win = (from: number, n = 200) => Array.from({ length: n }, (_, i) => t(`{"seq":${from + i}}`, { at: 1000 + from + i }));

  it('re-sent identical frames are served from the cache; only new ones are processed', () => {
    const cache = new FrameCache();
    expect(filterFrames(win(0), 'seq', 'all', cache, 0)).toHaveLength(200);
    expect(cache.computed).toBe(200);
    // the host re-sends the window: new objects, two dropped at the front, two new at the end
    const next = JSON.parse(JSON.stringify(win(2))) as Frame[];
    expect(filterFrames(next, 'seq', 'all', cache, 2)).toHaveLength(200);
    expect(cache.computed).toBe(202);
    cache.preview(5, next[3]);
    cache.preview(5, next[3]);
    expect(cache.computed).toBe(203);
  });

  it('a changed frame at the same number is recomputed (time / size are part of the key)', () => {
    const cache = new FrameCache();
    filterFrames([t('alpha', { at: 1 })], 'alpha', 'all', cache);
    expect(filterFrames([t('beta!', { at: 2 })], 'alpha', 'all', cache)).toEqual([]);
    expect(frameKey(3, { at: 9, size: 4 })).toBe('3:9:4');
  });

  it('prune keeps the cache bounded to the window', () => {
    const cache = new FrameCache();
    for (let k = 0; k < 20; k++) { const w = win(k * 50); cache.prune(w, k * 50); filterFrames(w, 'seq', 'all', cache, k * 50); }
    expect(cache.size).toBeLessThanOrEqual(200 * 2 + 16 + 200);
  });

  it('caps event / id in the search text', () => {
    const cache = new FrameCache();
    const f = t('d', { kind: 'event', event: 'a'.repeat(70_000) + 'TAIL', id: 'z' });
    expect(filterFrames([f], 'tail', 'all', cache)).toEqual([]);
    expect(filterFrames([f], 'aaa z', 'all', cache)).toEqual([0]);
    expect(capText('abcdef', 4)).toBe('abc…');
    expect(capText('abc', 4)).toBe('abc');
    expect(capText('x'.repeat(1000), MAX_EVENT_CHARS)).toHaveLength(MAX_EVENT_CHARS);
  });
});

describe('frame filter performance', () => {
  it('a 200-frame window (~2 MB) re-sent 20 times with a filter on: only new frames are lowercased', () => {
    const payload = 'Lorem Ipsum '.repeat(850); // ~10 KB per frame → ~2 MB window
    const mk = (n: number): Frame => { const text = `{"n":${n},"p":"${payload}"}`; return { dir: 'receive', at: 5000 + n, kind: 'text', text, size: text.length }; };
    const cache = new FrameCache();
    let total = 0;
    const t0 = performance.now();
    for (let u = 0; u < 20; u++) {
      const w = JSON.parse(JSON.stringify(Array.from({ length: 200 }, (_, i) => mk(u + i)))) as Frame[];
      const s = performance.now();
      cache.prune(w, u);
      filterFrames(w, 'ipsum "n":7', 'all', cache, u);
      if (u > 0) total += performance.now() - s;
    }
    const all = performance.now() - t0;
    console.info(`[frames re-send] 2 MB window × 20 updates: ${(total / 19).toFixed(2)} ms per update after the first (incl. clone ${(all / 20).toFixed(1)} ms); computed ${cache.computed}`);
    expect(cache.computed).toBe(219); // 200 + one new frame per update
    expect(total / 19).toBeLessThan(5);
  });


  it('500 frames × 100 exchanges (~1 KB each): a keystroke filters one exchange in < 5 ms, all of them in < 100 ms', () => {
    const exchanges = Array.from({ length: 100 }, (_, e) => Array.from({ length: 500 }, (_, i): Frame => {
      const text = JSON.stringify({ type: 'price', productId: i, exchange: e, payload: 'lorem ipsum dolor '.repeat(50), needle: i === 250 ? 'NeedleValue' : undefined });
      return { dir: i % 5 ? 'receive' : 'send', at: i, kind: 'text', text, size: text.length };
    }));
    const t0 = performance.now();
    const caches = exchanges.map(() => new FrameCache());
    exchanges.forEach((frames, k) => filterFrames(frames, 'needlevalue', 'all', caches[k])); // cold: lowercases (and caches) every frame once
    const cold = performance.now() - t0;
    const t1 = performance.now();
    let hits = 0;
    exchanges.forEach((frames, k) => { hits += filterFrames(frames, 'needlevalue price', 'all', caches[k]).length; });
    const warmAll = performance.now() - t1;
    const t2 = performance.now();
    const one = filterFrames(exchanges[0], 'needlev -subscribe', 'all', caches[0]);
    const warmOne = performance.now() - t2;
    console.info(`[frames bench] 50 000 frames (${(50_000 * 1e3 / 1e6).toFixed(0)} MB): cold ${cold.toFixed(1)} ms, warm all ${warmAll.toFixed(1)} ms, warm one exchange ${warmOne.toFixed(2)} ms`);
    expect(hits).toBe(100);
    expect(one).toEqual([250]);
    expect(warmOne).toBeLessThan(5);
    expect(warmAll).toBeLessThan(100);
  });
});

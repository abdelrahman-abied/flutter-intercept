// WebSocket messages / SSE events of one exchange (CONTRACTS §11.5): a virtualised list (500 frames cost the same
// as 20), a text filter, live append while the connection is open (pinned to the bottom unless the user scrolled
// up), and the selected frame as text / pretty JSON / a binary summary.
import type { JSX } from 'preact';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Exchange } from '../protocol';
import {
  capText, closeCodeText, dirArrow, dirLabel, FrameCache, filterFrames, formatRelative, frameCounts, framePrettyJson, frameTotal,
  hexDump, MAX_EVENT_CHARS, MAX_ID_CHARS, type DirFilter, type Frame,
} from '../frames';
import { formatBytes, formatTime } from '../util';
import { Button } from './bits';
import { Icon } from './Icon';
import { copyText } from './Viewers';

export const FRAME_ROW_HEIGHT = 20;
const OVERSCAN = 10;
/** Used before the first layout (and in DOM-less tests) where clientHeight is 0. */
const FALLBACK_VIEWPORT = 300;

export function FramesView({ ex }: { ex: Exchange }) {
  const frames = ex.frames ?? [];
  const dropped = ex.framesDropped ?? 0;
  const sse = ex.kind === 'sse';
  const unit = sse ? 'event' : 'message';
  const [text, setText] = useState('');
  const [dir, setDir] = useState<DirFilter>('all');
  /** Selected frame by its stable number (framesDropped + index). */
  const [selected, setSelected] = useState<number | undefined>();
  // Derived text per frame survives re-sends of the window (new objects each update): see FrameCache.
  const cache = useMemo(() => new FrameCache(), [ex.id]);
  const visible = useMemo(() => {
    cache.prune(frames, dropped);
    return filterFrames(frames, text, dir, cache, dropped);
  }, [frames, dropped, text, dir, cache]);
  const counts = useMemo(() => frameCounts(frames), [frames]);

  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  /** Pinned to the newest frame (state, not a ref: scrolling up must re-render even when scrollTop is unchanged). */
  const [following, setFollowing] = useState(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Live append: stay pinned to the newest frame unless the user scrolled up.
  const total = frameTotal(ex);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && following && el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
  }, [total, visible.length, following]);

  const onScroll = () => {
    const el = ref.current!;
    setFollowing(el.scrollTop + el.clientHeight >= el.scrollHeight - FRAME_ROW_HEIGHT / 2);
    setScrollTop(el.scrollTop);
  };

  const vh = height || FALLBACK_VIEWPORT;
  // While following, the window is anchored at the end — right even before the scroll event lands.
  const top = following ? Math.max(0, visible.length * FRAME_ROW_HEIGHT - vh) : scrollTop;
  const start = Math.max(0, Math.floor(top / FRAME_ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(visible.length, Math.ceil((top + vh) / FRAME_ROW_HEIGHT) + OVERSCAN);

  const select = setSelected;
  const selPos = selected === undefined ? -1 : visible.indexOf(selected - dropped);
  const moveTo = (pos: number) => {
    if (!visible.length) return;
    const p = Math.max(0, Math.min(visible.length - 1, pos));
    select(dropped + visible[p]);
    const el = ref.current;
    if (el && el.clientHeight) {
      const y = p * FRAME_ROW_HEIGHT;
      if (y < el.scrollTop) el.scrollTop = y;
      else if (y + FRAME_ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = y + FRAME_ROW_HEIGHT - el.clientHeight;
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown': moveTo(selPos < 0 ? 0 : selPos + 1); break;
      case 'ArrowUp': moveTo(selPos < 0 ? visible.length - 1 : selPos - 1); break;
      case 'Home': moveTo(0); break;
      case 'End': moveTo(visible.length - 1); break;
      case 'Escape': select(undefined); break;
      default: return;
    }
    e.preventDefault();
  };
  const jumpToLatest = () => setFollowing(true); // the layout effect scrolls to the end

  const rows: JSX.Element[] = [];
  for (let p = start; p < end; p++) {
    const i = visible[p];
    const f = frames[i];
    const n = dropped + i;
    rows.push(
      <FrameRow key={n} id={`fr-${ex.id}-${n}`} f={f} n={n} preview={cache.preview(n, f)} start={ex.startedAt}
        selected={n === selected} onSelect={() => select(n)} />,
    );
  }

  const close = ex.kind === 'websocket' ? lastClose(frames) : undefined;
  const sel = selected !== undefined ? frames[selected - dropped] : undefined;
  const live = ex.state === 'pending';

  return (
    <div class="frames">
      <div class="frames-head">
        <span>
          {total} {unit}{total === 1 ? '' : 's'}
          {!sse && <span class="muted"> · ↑ {counts.sent} sent · ↓ {counts.received} received</span>}
        </span>
        {live && <span class="badge live-badge" title={`The ${sse ? 'stream' : 'connection'} is open — new ${unit}s appear as they arrive`}>live</span>}
        {close && (
          <span class={`frames-close${close.closeCode === 1000 || close.closeCode === 1001 ? '' : ' warn-text'}`}>
            Closed by the {close.dir === 'send' ? 'app' : 'server'}: {closeCodeText(close.closeCode)}
          </span>
        )}
        {!close && !live && ex.state === 'error' && <span class="warn-text">Ended abnormally{ex.error ? `: ${ex.error}` : ''}</span>}
      </div>
      {dropped > 0 && (
        <div class="msg info frames-dropped" role="note">
          {dropped} earlier {unit}{dropped === 1 ? ' was' : 's were'} dropped — the proxy keeps the newest {frames.length}.
        </div>
      )}
      <div class="frames-tools">
        <input type="search" class="frames-filter" placeholder={`Filter ${unit}s (words; -word excludes)`} aria-label={`Filter ${unit}s`}
          value={text} spellcheck={false} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
        {!sse && (
          <div class="seg small" role="group" aria-label="Direction">
            {(['all', 'send', 'receive'] as const).map((d) => (
              <button key={d} type="button" class="seg-btn" aria-pressed={dir === d} onClick={() => setDir(d)}
                title={d === 'all' ? 'Both directions' : d === 'send' ? 'Sent by the app' : 'Received from the server'}>
                {d === 'all' ? 'All' : d === 'send' ? '↑ Sent' : '↓ Received'}
              </button>
            ))}
          </div>
        )}
        {(text || dir !== 'all') && <span class="muted">{visible.length} of {frames.length}</span>}
        <span class="spacer" />
        {!following && live && (
          <button type="button" class="link" onClick={jumpToLatest}>Jump to latest</button>
        )}
      </div>
      {frames.length === 0 ? (
        <div class="muted pad">{live ? `No ${unit}s yet — waiting…` : `No ${unit}s.`}</div>
      ) : (
        <div ref={ref} class="frames-scroll" tabIndex={0} role="listbox" aria-label={sse ? 'Events' : 'Messages'}
          aria-activedescendant={selected !== undefined && selPos >= 0 ? `fr-${ex.id}-${selected}` : undefined}
          onScroll={onScroll} onKeyDown={onKeyDown}>
          <div class="list-spacer" style={{ height: `${visible.length * FRAME_ROW_HEIGHT}px` }}>
            <div class="list-window" style={{ transform: `translateY(${start * FRAME_ROW_HEIGHT}px)` }}>
              {rows}
            </div>
          </div>
        </div>
      )}
      {frames.length > 0 && visible.length === 0 && <div class="muted pad">No {unit}s match the filter.</div>}
      {selected !== undefined && (
        sel ? <FrameDetail key={selected} f={sel} n={selected} start={ex.startedAt} />
          : <div class="muted pad">That {unit} was dropped (only the newest {frames.length} are kept).</div>
      )}
    </div>
  );
}

function lastClose(frames: readonly Frame[]): Frame | undefined {
  for (let i = frames.length - 1; i >= 0; i--) if (frames[i].kind === 'close') return frames[i];
  return undefined;
}

function FrameRow({ f, n, preview, start, selected, onSelect, id }: {
  f: Frame; n: number; preview: string; start: number; selected: boolean; onSelect: () => void; id?: string;
}) {
  return (
    <div id={id} role="option" aria-selected={selected} data-n={n}
      class={`frame-row dir-${f.dir} fk-${f.kind}${selected ? ' selected' : ''}`} onClick={onSelect}>
      <span class="fr-dir" title={dirLabel(f)}>{dirArrow(f)}</span>
      <span class="fr-time" title={formatTime(f.at)}>{formatRelative(f.at, start)}</span>
      <span class="fr-size">{formatBytes(f.size)}{f.truncated ? '+' : ''}</span>
      <span class="fr-preview">
        {f.event && <span class="badge mini ev-badge">{capText(f.event, 64)}</span>}
        {preview}
      </span>
    </div>
  );
}

function FrameDetail({ f, n, start }: { f: Frame; n: number; start: number }) {
  // Keyed by the frame's identity, not the object: a re-sent window must not re-format a 64 KB message.
  const same = [n, f.at, f.size, f.truncated];
  const pretty = useMemo(() => framePrettyJson(f), same);
  const [mode, setMode] = useState<'pretty' | 'raw'>('pretty');
  const hex = useMemo(() => (f.base64 !== undefined ? hexDump(f.base64) : undefined), same);
  const text = f.text ?? '';
  return (
    <div class="frame-detail" aria-label={`${f.kind === 'event' ? 'Event' : 'Message'} ${n + 1}`}>
      <div class="body-meta">
        <span class="meta-item">{dirArrow(f)} {dirLabel(f)}</span>
        <span class="meta-item">{f.kind}</span>
        <span class="meta-item" title={formatTime(f.at)}>{formatRelative(f.at, start)}</span>
        <span class="meta-item">{formatBytes(f.size)}</span>
        {f.event && <span class="meta-item">event: <code>{capText(f.event, MAX_EVENT_CHARS)}</code></span>}
        {f.id && <span class="meta-item">id: <code>{capText(f.id, MAX_ID_CHARS)}</code></span>}
        {f.kind === 'close' && <span class="meta-item">code {closeCodeText(f.closeCode)}</span>}
        {f.truncated && <span class="badge warn" title="The proxy keeps at most 64 KB of each message">truncated</span>}
        <span class="spacer" />
        {pretty !== undefined && (
          <div class="seg small" role="group" aria-label="Message view">
            <button type="button" class="seg-btn" aria-pressed={mode === 'pretty'} onClick={() => setMode('pretty')}>Pretty</button>
            <button type="button" class="seg-btn" aria-pressed={mode === 'raw'} onClick={() => setMode('raw')}>Raw</button>
          </div>
        )}
        {(f.text !== undefined || f.base64 !== undefined) && (
          <Button kind="icon" title={f.base64 !== undefined ? 'Copy as base64' : 'Copy message'}
            onClick={() => copyText(f.base64 ?? text)}><Icon name="copy" /></Button>
        )}
      </div>
      {hex ? (
        <>
          <div class="binary">binary ({f.size.toLocaleString()} bytes){hex.shown < f.size ? ` — first ${hex.shown} shown` : ''}</div>
          <pre class="code hexdump">{hex.text}</pre>
        </>
      ) : f.text !== undefined && f.text !== '' ? (
        <pre class="code">{pretty !== undefined && mode === 'pretty' ? pretty : text}</pre>
      ) : (
        <div class="muted pad">{f.kind === 'close' ? 'No close reason.' : 'Empty payload.'}</div>
      )}
    </div>
  );
}

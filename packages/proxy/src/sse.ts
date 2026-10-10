// Incremental text/event-stream parsing (CONTRACTS §11.1), per the HTML standard's "event stream
// interpretation": lines end in CRLF, LF or CR (a CRLF may be split across chunks), `data:` lines join with
// "\n", `event:` / `id:` / `retry:` fields, `:` comments, a leading BOM, one optional space after the colon,
// an event is dispatched on a blank line (and only if it had data), an unfinished event at the end of the
// stream is discarded. Chunk boundaries can fall anywhere, including inside a UTF-8 sequence. Memory is
// bounded: a line or an event's data beyond `maxData` is counted, not kept.
import { StringDecoder } from 'string_decoder';
import * as zlib from 'zlib';

export interface SseEvent {
  data: string;
  /** `event:` name (absent = the default "message"). */
  event?: string;
  /** `id:` of this event block. */
  id?: string;
  /** Full data size in UTF-8 bytes. */
  size: number;
  /** data was cut at maxData, or the event name / id at their caps. */
  truncated?: true;
}

export const SSE_DATA_CAP = 64 * 1024;
/** `event:` / `id:` values kept (REVIEW-5 #4); longer ones are cut and the event marked truncated. */
export const SSE_EVENT_NAME_CAP = 256;
export const SSE_ID_CAP = 1024;
/** Decoded bytes of a content-encoded stream parsed for events (REVIEW-5 #11); the app still gets everything. */
export const SSE_DECODED_CAP = 64 * 1024 * 1024;

export class SseParser {
  private readonly decoder = new StringDecoder('utf8');
  private readonly maxData: number;
  private readonly maxLine: number;
  private line = '';
  private lineDropped = 0;
  private pendingCR = false;
  private started = false;
  private data = '';
  private dataSize = 0;
  private dataTruncated = false;
  private hasData = false;
  private event?: string;
  private id?: string;
  /** Last `retry:` value (ms); kept for completeness, not recorded. */
  retry?: number;

  constructor(
    private readonly onEvent: (e: SseEvent) => void,
    opts: { maxData?: number } = {},
  ) {
    this.maxData = opts.maxData ?? SSE_DATA_CAP;
    this.maxLine = this.maxData + 64; // room for the field name
  }

  pushBytes(buf: Buffer): void {
    if (buf.length) this.push(this.decoder.write(buf));
  }

  /** The stream ended: an unfinished event is discarded (as browsers do). */
  end(): void {
    const rest = this.decoder.end();
    if (rest) this.push(rest);
  }

  push(text: string): void {
    let i = 0;
    if (!this.started && text.length) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) i = 1;
    }
    if (this.pendingCR && i < text.length) {
      this.pendingCR = false;
      if (text[i] === '\n') i++;
    }
    let nextLF = -2;
    let nextCR = -2;
    while (i < text.length) {
      if (nextLF !== -1 && nextLF < i) nextLF = text.indexOf('\n', i);
      if (nextCR !== -1 && nextCR < i) nextCR = text.indexOf('\r', i);
      const end = nextLF < 0 ? nextCR : nextCR < 0 ? nextLF : Math.min(nextLF, nextCR);
      if (end < 0) {
        this.append(text, i, text.length);
        return;
      }
      this.append(text, i, end);
      this.processLine();
      if (text[end] === '\r') {
        if (end + 1 < text.length) {
          i = text[end + 1] === '\n' ? end + 2 : end + 1;
        } else {
          this.pendingCR = true;
          i = end + 1;
        }
      } else i = end + 1;
    }
  }

  private append(text: string, from: number, to: number): void {
    if (to <= from) return;
    const room = this.maxLine - this.line.length;
    if (room >= to - from) this.line += text.slice(from, to);
    else {
      if (room > 0) this.line += text.slice(from, from + room);
      this.lineDropped += Buffer.byteLength(text.slice(from + Math.max(room, 0), to), 'utf8');
    }
  }

  private processLine(): void {
    const line = this.line;
    const dropped = this.lineDropped;
    this.line = '';
    this.lineDropped = 0;
    if (line === '' && dropped === 0) return this.dispatch();
    if (line[0] === ':') return; // comment
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value[0] === ' ') value = value.slice(1);
    switch (field) {
      case 'data': {
        const bytes = Buffer.byteLength(value, 'utf8') + dropped;
        if (this.hasData) {
          this.dataSize += 1; // the "\n" joining data lines
          this.appendData('\n');
        }
        this.hasData = true;
        this.dataSize += bytes;
        this.appendData(value);
        if (dropped) this.dataTruncated = true;
        break;
      }
      case 'event':
        this.event = value.length > SSE_EVENT_NAME_CAP ? value.slice(0, SSE_EVENT_NAME_CAP) : value;
        if (value.length > SSE_EVENT_NAME_CAP || dropped) this.dataTruncated = true;
        break;
      case 'id':
        if (!value.includes('\0')) {
          this.id = value.length > SSE_ID_CAP ? value.slice(0, SSE_ID_CAP) : value;
          if (value.length > SSE_ID_CAP || dropped) this.dataTruncated = true;
        }
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
      default:
        break; // unknown fields are ignored
    }
  }

  private appendData(s: string): void {
    const room = this.maxData - this.data.length;
    if (room >= s.length) this.data += s;
    else {
      if (room > 0) this.data += s.slice(0, room);
      this.dataTruncated = true;
    }
  }

  private dispatch(): void {
    const had = this.hasData;
    const e: SseEvent = { data: this.data, size: this.dataSize };
    if (this.event !== undefined && this.event !== '') e.event = this.event;
    if (this.id !== undefined) e.id = this.id;
    if (this.dataTruncated) e.truncated = true;
    this.data = '';
    this.dataSize = 0;
    this.dataTruncated = false;
    this.hasData = false;
    this.event = undefined;
    this.id = undefined;
    if (had) this.onEvent(e);
  }
}

/**
 * An SSE parser fed with the response bytes as they go to the app, decompressing them first when the
 * response has a content-encoding (gzip / deflate / br, streaming). Unsupported encodings are reported once.
 */
export class SseRecorder {
  private readonly parser: SseParser;
  private readonly inflater?: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress;
  private done?: Promise<void>;
  private failed = false;
  private decoded = 0;

  constructor(
    contentEncoding: string | undefined,
    onEvent: (e: SseEvent) => void,
    private readonly onError: (message: string) => void,
  ) {
    this.parser = new SseParser(onEvent);
    const enc = (contentEncoding ?? '').trim().toLowerCase();
    if (enc && enc !== 'identity') {
      const flush = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
      if (enc === 'gzip' || enc === 'x-gzip') this.inflater = zlib.createGunzip(flush);
      else if (enc === 'deflate') this.inflater = zlib.createInflate(flush);
      else if (enc === 'br') this.inflater = zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
      else {
        this.failed = true;
        onError(`Events not recorded: unsupported content-encoding "${enc}".`);
        return;
      }
      this.inflater.on('data', (b: Buffer) => {
        if (this.failed) return;
        this.decoded += b.length;
        if (this.decoded > SSE_DECODED_CAP) {
          // Stop decoding (a compression bomb costs CPU per decoded byte); forwarding is unaffected.
          this.fail(`Events not recorded past ${SSE_DECODED_CAP / 1024 / 1024} MB of decoded stream.`);
          this.inflater?.destroy();
          return;
        }
        this.parser.pushBytes(b);
      });
      this.inflater.on('error', (e) => this.fail(`Events not recorded past a decoding error (${e.message}).`));
    }
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.onError(message);
  }

  push(buf: Buffer): void {
    if (this.failed || !buf.length) return;
    if (this.inflater) this.inflater.write(buf);
    else this.parser.pushBytes(buf);
  }

  /** The stream ended; resolves once every event is parsed. */
  end(): Promise<void> {
    if (this.done) return this.done;
    const inflater = this.inflater;
    if (!inflater || this.failed || inflater.destroyed) {
      if (!this.failed) this.parser.end();
      return (this.done = Promise.resolve());
    }
    this.done = new Promise<void>((resolve) => {
      const finish = () => {
        if (!this.failed) this.parser.end();
        resolve();
      };
      inflater.once('end', finish);
      inflater.once('error', finish);
      inflater.end();
      inflater.resume();
    });
    return this.done;
  }
}

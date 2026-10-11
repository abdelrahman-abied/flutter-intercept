/**
 * Small persistent key/value store in the plugin's `dataDir` (what VS Code keeps in globalState / workspaceState):
 * personal rules, shared-rule and script approvals, contract route choices, "don't show again" flags, emulator
 * proxy records. One JSON file, owner-only (0600, folder 0700), written atomically (temp file + rename), writes
 * serialised. A corrupt file is moved aside and the store starts empty.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const STATE_FILE = 'state.json';

export interface Memento {
  get<T>(key: string): T | undefined;
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Promise<void>;
}

export class JsonStateStore implements Memento {
  private data: Record<string, unknown> = {};
  private writing: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(
    private readonly dir: string,
    private readonly log: (msg: string) => void = () => undefined,
  ) {
    this.file = path.join(dir, STATE_FILE);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.data = parsed as Record<string, unknown>;
      else throw new Error('not an object');
      if (process.platform !== 'win32' && (fs.statSync(this.file).mode & 0o077) !== 0) fs.chmodSync(this.file, 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        const aside = `${this.file}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(this.file, aside);
        } catch {
          // keep going with an empty store
        }
        this.log(`state: ${STATE_FILE} was unreadable (${(e as Error).message}); starting empty`);
      }
    }
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, fallback: T): T;
  get<T>(key: string, fallback?: T): T | undefined {
    const v = this.data[key];
    return v === undefined ? fallback : (structuredClone(v) as T);
  }

  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) delete this.data[key];
    else this.data[key] = structuredClone(value);
    const snapshot = JSON.stringify(this.data);
    this.writing = this.writing.then(() => this.write(snapshot)).catch((e: unknown) => this.log(`state: write failed: ${(e as Error).message}`));
    return this.writing;
  }

  /** Resolves once every pending write is on disk. */
  flush(): Promise<void> {
    return this.writing;
  }

  private async write(text: string): Promise<void> {
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.promises.writeFile(tmp, text, { mode: 0o600, flag: 'wx' });
    try {
      await fs.promises.rename(tmp, this.file);
    } catch (e) {
      await fs.promises.unlink(tmp).catch(() => undefined);
      throw e;
    }
  }
}


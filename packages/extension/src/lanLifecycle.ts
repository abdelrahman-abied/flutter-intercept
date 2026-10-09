/**
 * When the LAN listener (CONTRACTS §7) is open: from the first physical-iOS launch until the last
 * physical-iOS session ends. `onDidTerminateDebugSession` also fires for crashed sessions and for
 * apps killed on the device, so those close it too. A launch that opens the listener but never
 * becomes a session (build failed, Dart-Code aborted, user cancelled the device picker) is
 * covered by a grace timer. Proxy stop / deactivate close it via InterceptProxyHost.stop().
 */
export interface LanLifecycleOptions {
  closeLan: () => Promise<unknown>;
  /** Max time between opening the listener and the session starting (first iOS builds are slow). */
  graceMs?: number;
  log?: (msg: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class LanLifecycle {
  private readonly live = new Set<string>();
  private timer: unknown;

  constructor(private readonly opts: LanLifecycleOptions) {}

  get liveSessions(): number {
    return this.live.size;
  }

  /** The provider opened (or reused) the listener for a launch. */
  opened(): void {
    if (this.live.size > 0) return;
    this.clear();
    const set = this.opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.timer = set(() => {
      this.timer = undefined;
      if (this.live.size === 0) {
        this.opts.log?.('LAN listener opened but no physical-iOS session started: closing it');
        void this.opts.closeLan();
      }
    }, this.opts.graceMs ?? 15 * 60_000);
  }

  started(sessionId: string): void {
    this.live.add(sessionId);
    this.clear();
  }

  /** Returns true when this closed the listener (last LAN session ended). */
  ended(sessionId: string): boolean {
    if (!this.live.delete(sessionId)) return false;
    if (this.live.size > 0) return false;
    this.opts.log?.('last physical-iOS session ended: closing the LAN listener');
    void this.opts.closeLan();
    return true;
  }

  dispose(): void {
    this.clear();
    this.live.clear();
  }

  private clear(): void {
    if (this.timer !== undefined) (this.opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = undefined;
  }
}

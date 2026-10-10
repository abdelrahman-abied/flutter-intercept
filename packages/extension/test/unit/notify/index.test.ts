import { describe, expect, it } from 'vitest';
import type { Exchange } from '@flutter-intercept/proxy';
import { registerNotifications, SHOW, TURN_OFF, type NotifyDeps } from '../../../src/notify';

let seq = 0;
const fail = (over: Partial<Exchange> = {}): Exchange => ({
  id: `i${++seq}`,
  startedAt: 0,
  method: 'GET',
  url: 'https://api.example.com/users/42',
  requestHeaders: {},
  status: 500,
  state: 'completed',
  ...over,
});

const tick = () => new Promise((r) => setImmediate(r));

function harness(over: Partial<NotifyDeps> & { answer?: string } = {}) {
  let t = 0;
  const timers: { fn: () => void; at: number; id: number }[] = [];
  let nextId = 1;
  const shown: { text: string; buttons: string[] }[] = [];
  const revealed: string[] = [];
  let turnedOff = 0;
  let level: unknown = 'errors';
  let visible = false;
  const deps: NotifyDeps = {
    showMessage: (text, ...buttons) => {
      shown.push({ text, buttons });
      return Promise.resolve(over.answer);
    },
    reveal: (id) => void revealed.push(id),
    turnOff: () => {
      turnedOff++;
      level = 'off';
    },
    getLevel: () => level,
    isPanelVisible: () => visible,
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ fn, at: t + ms, id });
      return id;
    },
    clearTimeout: (h) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i !== -1) timers.splice(i, 1);
    },
    ...over,
  };
  const n = registerNotifications(deps);
  return {
    n,
    shown,
    revealed,
    timers,
    get turnedOff() {
      return turnedOff;
    },
    setLevel: (l: unknown) => (level = l),
    setVisible: (v: boolean) => (visible = v),
    /** Advances the fake clock, firing due timers. */
    advance(ms: number) {
      t += ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];
        if (!due || due.at > t) break;
        timers.shift();
        due.fn();
      }
    },
  };
}

describe('registerNotifications', () => {
  it('shows a notice with Show / Turn off buttons', () => {
    const h = harness();
    h.n.onExchange(fail());
    expect(h.shown).toEqual([{ text: 'GET /users/42 failed: 500 Internal Server Error', buttons: [SHOW, TURN_OFF] }]);
    expect(h.timers).toHaveLength(0);
  });

  it('"Show" reveals the panel on the exchange', async () => {
    const h = harness({ answer: SHOW });
    const e = fail();
    h.n.onExchange(e);
    await tick();
    expect(h.revealed).toEqual([e.id]);
  });

  it('"Turn off" sets the setting off and stops notices at once', async () => {
    const h = harness({ answer: TURN_OFF });
    h.n.onExchange(fail());
    await tick();
    expect(h.turnedOff).toBe(1);
    h.advance(60_000);
    h.n.onExchange(fail());
    expect(h.shown).toHaveLength(1);
  });

  it('groups failures inside the window and shows them when the timer fires', () => {
    const h = harness();
    h.n.onExchange(fail());
    h.advance(1000);
    h.n.onExchange(fail({ url: 'https://a.dev/a' }));
    h.n.onExchange(fail({ url: 'https://a.dev/b', status: 503 }));
    expect(h.shown).toHaveLength(1);
    expect(h.timers).toHaveLength(1); // one timer, not one per failure
    h.advance(8_999);
    expect(h.shown).toHaveLength(1);
    h.advance(1);
    expect(h.shown[1].text).toBe('2 requests failed — latest: GET /b → 503 Service Unavailable');
    expect(h.timers).toHaveLength(0);
  });

  it('nothing while the panel is visible', () => {
    const h = harness();
    h.setVisible(true);
    h.n.onExchange(fail());
    expect(h.shown).toHaveLength(0);
  });

  it('a panel shown while failures wait drops them', () => {
    const h = harness();
    h.n.onExchange(fail());
    h.n.onExchange(fail());
    h.setVisible(true);
    h.advance(20_000);
    expect(h.shown).toHaveLength(1);
    expect(h.timers).toHaveLength(0);
  });

  it('refreshLevel re-reads the setting (unknown values mean "errors")', () => {
    const h = harness();
    h.setLevel('off');
    h.n.refreshLevel();
    h.n.onExchange(fail());
    expect(h.shown).toHaveLength(0);
    h.setLevel('all');
    h.n.refreshLevel();
    h.n.onExchange(fail({ status: 404 }));
    expect(h.shown).toHaveLength(1);
    h.setLevel('bogus');
    h.n.refreshLevel();
    h.advance(20_000);
    h.n.onExchange(fail({ status: 404 }));
    expect(h.shown).toHaveLength(1);
  });

  it('dispose clears the timer and ignores later exchanges', () => {
    const h = harness();
    h.n.onExchange(fail());
    h.n.onExchange(fail());
    expect(h.timers).toHaveLength(1);
    h.n.dispose();
    expect(h.timers).toHaveLength(0);
    h.advance(60_000);
    h.n.onExchange(fail());
    expect(h.shown).toHaveLength(1);
  });

  it('never throws into the caller when a dep fails', async () => {
    const errors: unknown[] = [];
    const h = harness({
      showMessage: () => {
        throw new Error('no window');
      },
      isPanelVisible: () => {
        throw new Error('gone');
      },
      onError: (e) => errors.push(e),
    });
    expect(() => h.n.onExchange(fail())).not.toThrow();
    expect(errors.map((e) => (e as Error).message)).toEqual(['gone', 'no window']);

    const errs2: unknown[] = [];
    const h2 = harness({ answer: SHOW, reveal: () => Promise.reject(new Error('reveal failed')), onError: (e) => errs2.push(e) });
    h2.n.onExchange(fail());
    await tick();
    expect(errs2.map((e) => (e as Error).message)).toEqual(['reveal failed']);
  });
});

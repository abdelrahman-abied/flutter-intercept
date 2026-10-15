/**
 * v0.14.0 (CONTRACTS §20.3): servers that need the app's own certificate. The banner on a request / tunnel the proxy
 * passed through because of it, the "Add client certificate" popup, and the small list of certificates and learned
 * hosts opened from the status line.
 *
 * The popup never sees a path: the host's file picker answers with a one-use token and the file's base name. The
 * passphrase lives only in the popup's own field and is cleared as soon as it is sent.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useApp } from '../context';
import type { ClientCertFileRole, Exchange, Status, ViewMsg } from '../protocol';
import {
  CERT_WHY, certCovering, certHostFor, certSaveBlocker, certStaysText, FILE_ROLE_LABEL, FORMAT_ROLES, isLearnedLive, liveLearned, nextLearnedExpiry,
  LEARNED_REASON, learnedBannerText, learnedKey, learnedUntilText, type CertFormat, type LearnedRef,
} from '../certificates';
import type { CertDialog as CertDialogState } from '../state';
import { Button, useNow } from './bits';
import { Icon } from './Icon';
import { inIde } from './Toolbar';

// ---------------------------------------------------------------- banner on a request / tunnel

/** The "Try decrypting again" notice: the proxy may learn the host again on the next failure. */
const forgetNotice = (e: LearnedRef) =>
  `New connections to ${learnedKey(e)} are decrypted again. If it still ${e.reason === 'pinned'
    ? 'refuses the proxy\'s certificate' : 'asks for the app\'s certificate'}, it is passed through again.`;

/** CONTRACTS §20.3: on an exchange with `learnedPassthrough` (the request that failed, or a tunnel passed through). */
export function LearnedBanner({ ex }: { ex: Pick<Exchange, 'learnedPassthrough'> }) {
  const { state, dispatch, post } = useApp();
  const lp = ex.learnedPassthrough;
  if (!lp) return null;
  const { title, body } = learnedBannerText(lp);
  const live = isLearnedLive(lp, liveLearned(state.status.learnedPassthrough, Date.now()));
  const covered = lp.reason === 'client-certificate' ? certCovering(lp, state.status.clientCertificates) : undefined;
  return (
    <div class="msg warn learned-banner" role="note" aria-label={title}>
      <div class="learned-text">
        <strong>{title}</strong> {body}
      </div>
      {covered ? (
        <div class="learned-state">A client certificate is set up for <code>{covered}</code>: new connections use it.</div>
      ) : !live && (
        <div class="learned-state"><code>{lp.host}</code> is no longer passed through: new connections are decrypted again.</div>
      )}
      <div class="learned-actions">
        {lp.reason === 'client-certificate' && !covered && (
          <Button kind="primary" onClick={() => dispatch({ type: 'openCertDialog', host: certHostFor(lp) })}
            title="Give Flutter Intercept the app's certificate so it can show these requests">
            Add client certificate…
          </Button>
        )}
        {live && !covered && (
          <Button onClick={() => {
            post({ type: 'forgetLearnedPassthrough', host: lp.host, port: lp.port });
            dispatch({ type: 'notice', text: forgetNotice(lp) });
          }} title={`Stop passing ${learnedKey(lp)} through: the proxy decrypts its next connections again`}>
            Try decrypting again
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- modal helpers

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** Tab / Shift+Tab stay inside `root`. */
function trapTab(e: KeyboardEvent, root: HTMLElement | null) {
  if (e.key !== 'Tab' || !root) return;
  const list = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (!list.length) { e.preventDefault(); return; }
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey && (active === first || !root.contains(active))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (active === last || !root.contains(active))) { e.preventDefault(); first.focus(); }
}

// ---------------------------------------------------------------- the "Add client certificate" popup

export function CertDialog() {
  const { state } = useApp();
  const d = state.certDialog;
  return d ? <CertDialogBody key={d.id} d={d} /> : null;
}

function CertDialogBody({ d }: { d: CertDialogState }) {
  const { dispatch, post } = useApp();
  const [host, setHost] = useState(d.host);
  const [format, setFormat] = useState<CertFormat>('pfx');
  const [passphrase, setPassphrase] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    opener.current = document.activeElement as HTMLElement | null;
    // Prefilled host: start at the file; otherwise at the host.
    (d.host ? fileRef.current : hostRef.current)?.focus();
    return () => {
      const o = opener.current;
      if (o && o.isConnected) o.focus();
    };
  }, []);

  const busy = !!d.saving;
  const blocker = certSaveBlocker(host, format, d.files);
  const close = () => dispatch({ type: 'closeCertDialog' });
  const choose = (role: ClientCertFileRole) => {
    dispatch({ type: 'certPicking', role });
    post({ type: 'chooseClientCertificateFile', role });
  };
  const save = () => {
    if (blocker || busy) return;
    const h = host.trim();
    const msg: Extract<ViewMsg, { type: 'addClientCertificate' }> = { type: 'addClientCertificate', host: h };
    for (const role of FORMAT_ROLES[format]) msg[role] = d.files[role]!.token;
    if (passphrase) msg.passphrase = passphrase;
    dispatch({ type: 'certSaving', host: h });
    post(msg);
    setPassphrase(''); // never kept after sending
  };
  const titleId = `cert-dialog-title-${d.id}`;
  const fileRow = (role: ClientCertFileRole, first: boolean) => {
    const f = d.files[role];
    const labelId = `cert-file-${role}-${d.id}`;
    return (
      <div class="cert-file" key={role}>
        <span id={labelId} class="field-label">{FILE_ROLE_LABEL[role]}</span>
        <div class="cert-file-line">
          <button ref={first ? fileRef : undefined} type="button" class="btn btn-secondary" disabled={busy || !!d.picking}
            aria-describedby={labelId} onClick={() => choose(role)}>
            {d.picking === role ? 'Choosing…' : f ? 'Change…' : 'Choose file…'}
          </button>
          <span class={`cert-file-name${f ? '' : ' muted'}`} aria-label={`${FILE_ROLE_LABEL[role]}: ${f ? f.name : 'none chosen'}`}>
            {f ? f.name : 'No file chosen'}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div class="modal-backdrop">
      <div ref={ref} class="modal cert-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
          trapTab(e, ref.current);
        }}>
        <form onSubmit={(e) => { e.preventDefault(); save(); }}>
          <div class="modal-head">
            <h2 id={titleId}>Add client certificate</h2>
            <span class="spacer" />
            <Button kind="icon" title="Close (Esc)" onClick={close}><Icon name="close" /></Button>
          </div>
          <div class="modal-body">
            <section class="cert-explain" aria-label="Why and where it is kept">
              <h3>Why</h3>
              <p>{CERT_WHY}</p>
              <h3>Stays on your computer</h3>
              <p>{certStaysText(inIde())}</p>
            </section>

            <label class="field">
              <span>Server</span>
              <input ref={hostRef} value={host} spellcheck={false} autocomplete="off" disabled={busy}
                placeholder="api.example.com or *.example.com:8443"
                onInput={(e) => setHost((e.target as HTMLInputElement).value)} />
            </label>

            <fieldset class="cert-format" disabled={busy}>
              <legend class="field-label">Certificate file</legend>
              <div class="radios" role="radiogroup" aria-label="Certificate file">
                <label class="radio">
                  <input type="radio" name={`cert-format-${d.id}`} checked={format === 'pfx'} onChange={() => setFormat('pfx')} />
                  PKCS#12 (.p12 / .pfx, one file)
                </label>
                <label class="radio">
                  <input type="radio" name={`cert-format-${d.id}`} checked={format === 'pem'} onChange={() => setFormat('pem')} />
                  PEM (certificate + private key)
                </label>
              </div>
              {FORMAT_ROLES[format].map((role, i) => fileRow(role, i === 0))}
            </fieldset>

            <label class="field">
              <span>Passphrase (optional)</span>
              <input type="password" value={passphrase} autocomplete="off" disabled={busy}
                placeholder="Leave empty if the file has none"
                onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)} />
            </label>

            {d.problem && <div class="msg error cert-problem-msg" role="alert">{d.problem}</div>}
          </div>
          <div class="modal-actions">
            {blocker && !busy && <span class="hint cert-blocker">{blocker}</span>}
            <span class="spacer" />
            <Button kind="primary" type="submit" disabled={!!blocker || busy}>{busy ? 'Saving…' : 'Save'}</Button>
            <Button onClick={close}>Cancel</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- status line item + list

/** Status line: the certificates (problems first, highlighted), or a quiet entry point; opens the list. */
export function CertsStatusItem({ certs, summary, open, onToggle }: {
  certs: Status['clientCertificates'];
  summary: { text: string; title: string; problems: number } | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  const shownMax = 3;
  if (!certs?.length || !summary) {
    return (
      <button type="button" class="status-link certs-toggle" aria-expanded={open} onClick={onToggle}
        title="Client certificates for servers that ask the app to prove who it is (mutual TLS)">
        Client certificates…
      </button>
    );
  }
  // Problems first, so a broken certificate is never hidden behind "+N".
  const sorted = [...certs.filter((c) => c.problem), ...certs.filter((c) => !c.problem)];
  const shown = sorted.slice(0, shownMax);
  return (
    <button type="button" class={`status-link certs-toggle cert-status${summary.problems ? ' has-problem' : ''}`}
      aria-expanded={open} onClick={onToggle} title={`${summary.title}\n\nClick to add or remove certificates.`}>
      {summary.problems ? `Client certificates (${summary.problems} problem${summary.problems === 1 ? '' : 's'}):` : 'Client certificates:'}
      {shown.map((c, i) => (
        <span key={i} class={`cert-host${c.problem ? ' cert-problem' : ''}`} title={c.problem ? `${c.host}: ${c.problem}` : c.host}>
          {' '}{c.problem ? '✕ ' : ''}{c.host}{i < shown.length - 1 ? ',' : ''}
        </span>
      ))}
      {sorted.length > shownMax && <span class="muted"> +{sorted.length - shownMax}</span>}
    </button>
  );
}

/**
 * The learned entries still in force. The proxy sends no event when a pin expires (REVIEW-14 #6): one timer at the
 * earliest `until` re-checks, and the filtering only runs when the list changes or that timer fires.
 */
function useLiveLearned(list: Status['learnedPassthrough']): Status['learnedPassthrough'] {
  const [tick, setTick] = useState(0);
  const live = useMemo(() => liveLearned(list, Date.now()) as Status['learnedPassthrough'], [list, tick]);
  useEffect(() => {
    const next = nextLearnedExpiry(list, Date.now());
    if (next === undefined) return;
    const t = setTimeout(() => setTick((n) => n + 1), Math.min(2 ** 31 - 1, Math.max(0, next - Date.now()) + 20));
    return () => clearTimeout(t);
  }, [list, tick]);
  return live;
}

/** Status line: hosts passed through automatically (CONTRACTS §20.2); opens the list. */
export function LearnedStatusItem({ learned: all, open, onToggle }: {
  learned: Status['learnedPassthrough']; open: boolean; onToggle: () => void;
}) {
  const learned = useLiveLearned(all);
  if (!learned?.length) return null;
  const n = learned.length;
  return (
    <button type="button" class="status-link certs-toggle learned-status" aria-expanded={open} onClick={onToggle}
      title={'Flutter Intercept passes these servers through without decryption, because they need the app\'s own ' +
        `certificate or the app doesn't accept the proxy's certificate:\n${learned.map((l) => `• ${learnedKey(l)}`).join('\n')}` +
        '\n\nClick to see why, add a certificate, or try decrypting again.'}>
      Passed through: {n} host{n === 1 ? '' : 's'}
    </button>
  );
}

/** The list: configured client certificates (Remove, Add…) and the hosts passed through automatically (Forget). */
export function CertsPanel({ onClose }: { onClose: (restoreFocus: boolean) => void }) {
  const { state, dispatch, post } = useApp();
  const certs = state.status.clientCertificates ?? [];
  const all = state.status.learnedPassthrough ?? [];
  // Ticks only while the list is open and a pin has an end; expired pins drop out (no event from the proxy).
  const now = useNow(all.some((l) => l.until !== undefined));
  const learned = liveLearned(all, now) ?? [];
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => { ref.current?.querySelector<HTMLElement>('h2')?.focus(); }, []);
  const add = (host: string) => dispatch({ type: 'openCertDialog', host });

  return (
    <section ref={ref} class="certs-panel" aria-labelledby="certs-panel-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); onClose(true); }
      }}>
      <div class="certs-head">
        <h2 id="certs-panel-title" tabIndex={-1}>Client certificates</h2>
        <span class="spacer" />
        <Button onClick={() => add('')} title="Add the certificate an app uses to prove who it is to a server">
          <Icon name="plus" /> Add…
        </Button>
        <Button kind="icon" title="Close (Esc)" onClick={() => onClose(true)}><Icon name="close" /></Button>
      </div>
      {certs.length ? (
        <ul class="certs-list" aria-label="Client certificates">
          {certs.map((c) => (
            <li key={c.host} class={c.problem ? 'has-problem' : undefined}>
              <div class="certs-row">
                <code class="certs-host">{c.host}</code>
                {c.problem && <span class="certs-problem">✕ {c.problem}</span>}
                <span class="spacer" />
                {/* REVIEW-14 #4: the IDE asks to confirm (natively) before removing anything; cancelling changes nothing. */}
                <Button kind="danger" onClick={() => post({ type: 'removeClientCertificate', host: c.host })}
                  title={`Stop using the certificate for ${c.host} (asks to confirm; the file itself isn't touched)`}>
                  Remove…
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p class="hint">None yet. A server that asks the app to prove who it is with a certificate (mutual TLS) needs one here to be shown.</p>
      )}
      {learned.length > 0 && (
        <>
          <div class="certs-head certs-subhead">
            <h3>Passed through automatically</h3>
            <span class="spacer" />
            {learned.length > 1 && (
              <Button onClick={() => post({ type: 'forgetLearnedPassthrough' })} title="Decrypt new connections to all of them again">
                Try all again
              </Button>
            )}
          </div>
          <ul class="certs-list" aria-label="Passed through automatically">
            {learned.map((l) => (
              <li key={learnedKey(l)}>
                <div class="certs-row">
                  <code class="certs-host">{learnedKey(l)}</code>
                  <span class="muted">{LEARNED_REASON[l.reason]} · {learnedUntilText(l, now)}</span>
                  <span class="spacer" />
                  {l.reason === 'client-certificate' && (
                    <Button onClick={() => add(certHostFor(l))} title="Add the app's certificate for this server">Add certificate…</Button>
                  )}
                  <Button onClick={() => post({ type: 'forgetLearnedPassthrough', host: l.host, port: l.port })}
                    title="Forget it: new connections are decrypted again">
                    Forget
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

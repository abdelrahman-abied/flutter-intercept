// Stand-in for the extension's background-isolate install (CONTRACTS §13.3, src/vm/isolates.ts) for
// `flutter run --start-paused` sessions driven by scripts/e2e/run_device.sh --isolates.
//
//   node scripts/e2e/isolate_installer.mjs <vm-service http or ws URI>
//
// Every isolate paused at start whose root library is a generated entry gets `invoke flutterInterceptInstall`,
// then `resume` (flutter run without a debugger: nobody else resumes them). Other isolates are just resumed.
// Log lines: INSTALLER_READY, INSTALLER_ISOLATE <name> installed|not-entry|error <detail> ms=<n>.
// Node >= 22 (global WebSocket). No dependencies.
const arg = process.argv[2];
if (!arg) {
  console.error('usage: isolate_installer.mjs <vm-service-uri>');
  process.exit(64);
}
const uri = arg.replace(/^http/, 'ws').replace(/\/?$/, '/').replace(/\/ws\/$/, '/') + 'ws';
const ws = new WebSocket(uri);
let next = 1;
const pending = new Map();
const handled = new Set();
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);

function rpc(method, params = {}) {
  const id = String(next++);
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function handle(isolateId) {
  if (handled.has(isolateId)) return;
  const t0 = Date.now();
  let isolate;
  try {
    isolate = await rpc('getIsolate', { isolateId });
  } catch (e) {
    return;
  }
  if (isolate.pauseEvent?.kind !== 'PauseStart' || handled.has(isolateId)) return;
  handled.add(isolateId);
  let outcome = `not-entry (${(isolate.rootLib?.uri ?? '?').replace(/^.*\//, '')})`;
  try {
    // The extension matches .dart_tool/flutter_intercept/; run_device.sh --entry-dir may use another .dart_tool dir.
    if (/\/\.dart_tool\/[^/]+\/entry_[^/]*\.dart$/.test(isolate.rootLib?.uri ?? '')) {
      const r = await rpc('invoke', { isolateId, targetId: isolate.rootLib.id, selector: 'flutterInterceptInstall', argumentIds: [], disableBreakpoints: true });
      outcome = r.type === '@Error' || r.type === 'Error' ? `error ${r.message ?? ''}` : 'installed';
    }
  } catch (e) {
    outcome = `error ${e.message ?? e}`;
  }
  try {
    await rpc('resume', { isolateId });
  } catch (e) {
    outcome += ` (resume failed: ${e.message ?? e})`;
  }
  log(`INSTALLER_ISOLATE ${isolate.name} ${outcome} ms=${Date.now() - t0}`);
}

async function scan() {
  const vm = await rpc('getVM');
  for (const i of vm.isolates ?? []) await handle(i.id);
}

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message + (msg.error.data?.details ? `: ${msg.error.data.details}` : '')));
    else p.resolve(msg.result);
    return;
  }
  const event = msg.params?.event;
  if (msg.method === 'streamNotify' && event?.kind === 'PauseStart') handle(event.isolate.id);
});
ws.addEventListener('open', async () => {
  for (const s of ['Debug', 'Isolate']) {
    try {
      await rpc('streamListen', { streamId: s });
    } catch (e) {
      if (!/already subscribed/i.test(e.message)) throw e;
    }
  }
  log(`INSTALLER_READY ${uri.replace(/\/[^/]*=\/ws$/, '/<token>/ws')}`);
  await scan();
  // Safety net for a missed event (like the extension's 2 s sweep).
  setInterval(() => scan().catch(() => undefined), 2000);
});
ws.addEventListener('close', () => {
  log('INSTALLER_CLOSED');
  process.exit(0);
});
ws.addEventListener('error', (e) => {
  log(`INSTALLER_ERROR ${e.message ?? e}`);
  process.exit(1);
});

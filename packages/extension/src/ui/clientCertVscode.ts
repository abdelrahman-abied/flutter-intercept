/**
 * CONTRACTS §20.3 in VS Code: the `ClientCertPlatform` behind the shared `createClientCertUi` (clientCertUi.ts) and the
 * "Flutter Intercept: Add Client Certificate…" command, which drives the same checks and storage with native inputs.
 * Split out of `activate()` (QUALITY-2). The settings / secrets listeners in extension.ts reload the certificates after
 * a write, so the platform has no `reload`.
 */
import * as vscode from 'vscode';
import { certHostProblem, passphraseSecretKey, type ClientCertEntry } from './clientCerts';
import { createClientCertUi, type ClientCertFileRole, type ClientCertUi } from './clientCertUi';

const CERT_FILTERS: Record<ClientCertFileRole, Record<string, string[]>> = {
  pfx: { 'PKCS#12 (.p12, .pfx)': ['p12', 'pfx'], 'All files': ['*'] },
  cert: { 'PEM certificate (.pem, .crt, .cer)': ['pem', 'crt', 'cer'], 'All files': ['*'] },
  key: { 'PEM private key (.pem, .key)': ['pem', 'key'], 'All files': ['*'] },
};
const CERT_PICK_TITLE: Record<ClientCertFileRole, string> = {
  pfx: 'Client certificate (PKCS#12 .p12 / .pfx)',
  cert: 'Client certificate (PEM)',
  key: 'Private key of the client certificate (PEM)',
};

/**
 * The panel's client-certificate UI in VS Code: the native file picker, the user-level `flutterIntercept.clientCertificates`
 * (ConfigurationTarget.Global) and the passphrase in `context.secrets`.
 */
export function createVscodeClientCertUi(
  context: vscode.ExtensionContext,
  /** The user-level value of a flutterIntercept setting (never workspace / folder values). */
  userSetting: <T>(key: string) => T | undefined,
  log: (msg: string) => void,
): ClientCertUi {
  return createClientCertUi({
    pickFile: async (role) => {
      const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: CERT_FILTERS[role], title: CERT_PICK_TITLE[role], openLabel: 'Choose' });
      const uri = picked?.[0];
      if (!uri) return undefined;
      if (uri.scheme !== 'file') throw new Error('Choose a file on this computer.');
      return uri.fsPath;
    },
    readEntries: () => userSetting<unknown>('clientCertificates'),
    writeEntries: async (entries: ClientCertEntry[]) => {
      await vscode.workspace.getConfiguration('flutterIntercept').update('clientCertificates', entries.length ? entries : undefined, vscode.ConfigurationTarget.Global);
    },
    setPassphrase: async (host, value) => {
      if (value) await context.secrets.store(passphraseSecretKey(host), value);
      else await context.secrets.delete(passphraseSecretKey(host));
    },
    // REVIEW-14 #4: the previous passphrase is put back when a save fails; Remove is confirmed here, natively.
    getPassphrase: (host) => Promise.resolve(context.secrets.get(passphraseSecretKey(host))),
    confirmRemove: async (host) =>
      (await vscode.window.showWarningMessage(`Remove the client certificate for ${host}? Its passphrase is deleted too.`, { modal: true }, 'Remove')) === 'Remove',
    log,
  });
}

/** CONTRACTS §20.3: the panel's "Add client certificate…" with native inputs (same checks and storage). */
export function registerAddClientCertificateCommand(clientCertUi: ClientCertUi): vscode.Disposable {
  return vscode.commands.registerCommand('flutterIntercept.addClientCertificate', async (hostArg?: unknown) => {
    const host = await vscode.window.showInputBox({
      title: 'Add Client Certificate',
      prompt: 'Host the certificate is for (a host name pattern, optional :port), e.g. api.example.com or *.corp.example:8443',
      value: typeof hostArg === 'string' ? hostArg : '',
      ignoreFocusOut: true,
      validateInput: (v) => certHostProblem(v),
    });
    if (host === undefined) return;
    const PFX = 'PKCS#12 file (.p12 / .pfx)';
    const PEM = 'PEM certificate + private key';
    const kind = await vscode.window.showQuickPick([PFX, PEM], { title: 'Add Client Certificate', placeHolder: 'Certificate file' });
    if (!kind) return;
    const tokens: { pfx?: string; cert?: string; key?: string } = {};
    for (const role of kind === PFX ? (['pfx'] as const) : (['cert', 'key'] as const)) {
      let file: { token: string } | undefined;
      try {
        file = await clientCertUi.choose(role);
      } catch (e) {
        void vscode.window.showErrorMessage(`Flutter Intercept: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (!file) return;
      tokens[role] = file.token;
    }
    for (;;) {
      const passphrase = await vscode.window.showInputBox({ title: 'Add Client Certificate', prompt: 'Passphrase (leave empty if it has none)', password: true, ignoreFocusOut: true });
      if (passphrase === undefined) return;
      const r = await clientCertUi.add({ host, ...tokens, ...(passphrase ? { passphrase } : {}) });
      if (!r.problem) {
        void vscode.window.showInformationMessage(`Flutter Intercept: client certificate for ${host.trim().toLowerCase()} saved (user settings; the passphrase in VS Code's secret storage).`);
        return;
      }
      // A wrong / missing passphrase can be fixed here; anything else ends the flow.
      if (!/passphrase/i.test(r.problem)) {
        void vscode.window.showErrorMessage(`Flutter Intercept: ${r.problem}`);
        return;
      }
      const again = await vscode.window.showWarningMessage(`Flutter Intercept: ${r.problem}`, 'Try Again');
      if (again !== 'Try Again') return;
    }
  });
}

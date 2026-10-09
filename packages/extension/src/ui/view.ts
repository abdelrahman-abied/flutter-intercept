/**
 * Bottom-panel WebviewView hosting packages/webview (copied to dist/webview/ by build.mjs).
 * HTML template and CSP exactly as in docs/spikes/webview.md / CONTRACTS §4.
 */
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { InterceptController } from './controller';

export const VIEW_ID = 'flutterIntercept.traffic';

export function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(32);
  let out = '';
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}

export function webviewHtml(args: { cspSource: string; nonce: string; scriptUri: string; styleUri: string; inPanel: boolean }): string {
  const { cspSource, nonce: n, scriptUri, styleUri, inPanel } = args;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${n}'; img-src ${cspSource} data:; font-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Flutter Intercept</title>
</head>
<body class="${inPanel ? 'fi-panel' : ''}">
  <div id="root"></div>
  <script nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`;
}

export class TrafficViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private detach?: () => void;
  resolveCount = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: InterceptController,
  ) {}

  get resolved(): boolean {
    return !!this.view;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.resolveCount++;
    this.detach?.();
    this.view = view;
    const root = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    view.webview.html = webviewHtml({
      cspSource: view.webview.cspSource,
      nonce: nonce(),
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(root, 'webview.js')).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(root, 'webview.css')).toString(),
      inPanel: true,
    });
    const post = (msg: unknown) => void view.webview.postMessage(msg);
    this.detach = this.controller.attach(post);
    const sub = view.webview.onDidReceiveMessage((m) => void this.controller.handle(m, post));
    view.onDidDispose(() => {
      sub.dispose();
      this.detach?.();
      this.detach = undefined;
      if (this.view === view) this.view = undefined;
    });
  }

  /** Shows the panel without taking focus (used when the first intercepted session starts). */
  async reveal(preserveFocus: boolean): Promise<void> {
    if (this.view) {
      this.view.show(preserveFocus);
      return;
    }
    // `<viewId>.focus` takes `{ preserveFocus }` (VS Code's registerFocusViewAction).
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`, { preserveFocus });
  }
}

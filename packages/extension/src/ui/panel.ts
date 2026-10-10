/**
 * The traffic UI as an editor tab, optionally moved into its own window (CONTRACTS §13.1). Same bundle, CSP and
 * controller as the bottom-panel view; at most one editor copy at a time.
 */
import * as vscode from 'vscode';
import { InterceptController } from './controller';
import { nonce, webviewHtml } from './view';

export const PANEL_TYPE = 'flutterIntercept.trafficEditor';
/** VS Code ≥ 1.85 (auxiliary windows). Feature-detected: older hosts keep the editor tab. */
export const MOVE_TO_NEW_WINDOW = 'workbench.action.moveEditorToNewWindow';

export class TrafficPanel {
  private panel?: vscode.WebviewPanel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: InterceptController,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** The editor copy exists and is visible in its group (or window). */
  get visible(): boolean {
    return !!this.panel?.visible;
  }

  /** Opens (or reveals) the editor copy. */
  open(): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.reveal(undefined, false);
      return this.panel;
    }
    const root = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const panel = vscode.window.createWebviewPanel(
      PANEL_TYPE,
      'Flutter Intercept',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true },
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'traffic.svg');
    panel.webview.html = webviewHtml({
      cspSource: panel.webview.cspSource,
      nonce: nonce(),
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'webview.css')).toString(),
      inPanel: false,
    });
    const post = (msg: unknown) => void panel.webview.postMessage(msg);
    const detach = this.controller.attach(post);
    const sub = panel.webview.onDidReceiveMessage((m) => void this.controller.handle(m, post));
    panel.onDidDispose(() => {
      sub.dispose();
      detach();
      if (this.panel === panel) this.panel = undefined;
    });
    this.panel = panel;
    return panel;
  }

  /** Opens the editor copy and moves it into a window of its own; falls back to the tab on older VS Code. */
  async openInNewWindow(): Promise<void> {
    const panel = this.open();
    const commands = await vscode.commands.getCommands(true);
    if (!commands.includes(MOVE_TO_NEW_WINDOW)) {
      void vscode.window.showInformationMessage('Flutter Intercept: this VS Code version cannot open editors in a new window, so the traffic view opened as an editor tab.');
      return;
    }
    // The move command acts on the active editor: make sure it's ours.
    panel.reveal(undefined, false);
    try {
      await vscode.commands.executeCommand(MOVE_TO_NEW_WINDOW);
    } catch (e) {
      this.log(`move to new window failed: ${String(e)}`);
    }
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

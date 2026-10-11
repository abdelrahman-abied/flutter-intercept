/**
 * Sidecar for IDEs other than VS Code (CONTRACTS §15). Shared types, lead-owned. Implemented in packages/sidecar/src/**.
 *
 * Transport: newline-delimited JSON on stdin/stdout between the IDE plugin and `node sidecar.js`. Messages:
 *   request  {id: number, method: string, params?: object}     (either direction)
 *   response {id: number, result?: unknown, error?: {message: string; code?: string}}
 *   event    {event: string, data?: unknown}                   (sidecar → plugin only)
 * stderr carries human log lines only (never secrets). Plugin-originated ids are positive; sidecar-originated
 * ids are negative, so they never collide.
 */

/** User-level settings the plugin stores (application scope) and passes on `init` / `settings`. */
export interface SidecarSettings {
  enabled: boolean;
  port: number;                       // default 8899
  captureSource: boolean;
  webEnabled: boolean;
  nativeClients: 'profile' | 'proxy' | 'off';
  backgroundIsolates: 'intercept' | 'warn';
  notifications: 'errors' | 'all' | 'off';
  contractCheck: boolean;
  rewriteLocalhost: boolean;
  upstreamProxy?: string;
  upstreamProxyIgnoreCertErrors: boolean;
  tlsPassthrough: string[];
  clientCertificates: { host: string; pfx?: string; cert?: string; key?: string }[];
  agent: { access: 'readWrite' | 'readOnly' | 'off'; redactSecrets: boolean; screenshots: boolean; mcpPort: number };
  /** The IDE's own HTTP proxy, if any (like VS Code's `http.proxy`): `http://host:port`. */
  ideHttpProxy?: { url?: string; noProxy?: string[] };
}

export type DeviceKind = 'android-emulator' | 'android-device' | 'ios-simulator' | 'ios-device' | 'macos' | 'linux' | 'windows' | 'web' | 'other';

// ── plugin → sidecar requests ────────────────────────────────────────────────────────────────────────────
export interface InitParams {
  /** Plugin-owned directory for the CA, recordings index, approvals (like VS Code globalStorage / workspaceState). */
  dataDir: string;
  /** Absolute project roots (the IDE project's content roots that contain pubspec.yaml first). */
  workspaceFolders: string[];
  settings: SidecarSettings;
  theme: 'light' | 'dark' | 'high-contrast';
  ide: { name: string; version: string; pluginVersion: string };
}
export interface InitResult {
  /** Loopback URL of the traffic UI for JCEF, with its one-time token (never logged). */
  uiUrl: string;
  /** MCP endpoint for agents, when agent access isn't off. */
  mcpUrl?: string;
  version: string;
}
export interface PrepareLaunchParams {
  launchId: string;                  // plugin-chosen id, echoed in sessionStarted
  projectRoot: string;
  /** The Dart entry file the run configuration targets (absolute). */
  program: string;
  deviceId?: string;
  deviceKind: DeviceKind;
  flutterMode: 'debug' | 'profile' | 'release';
  /** The run configuration's existing additional args (to detect the user's own proxy / defines). */
  additionalArgs: string[];
}
export type PrepareLaunchResult =
  | { kind: 'rewrite'; program: string; additionalArgs: string[]; note?: string }   // run this entry with these args
  | { kind: 'skip'; reason: string };                                              // run unchanged
export interface SessionStartedParams {
  launchId: string;
  sessionId: string;
  deviceId?: string;
  /** VM service WebSocket URI when the plugin knows it (enables isolates, native profile, screenshots). Never logged. */
  vmServiceUri?: string;
  /** Flutter Web: the app's URL (flutter_tools `app.webLaunchUrl`), for screenshots of the right tab. */
  webLaunchUrl?: string;
}
export interface SessionEndedParams { sessionId: string }

export type PluginRequest =
  | { method: 'init'; params: InitParams }                     // → InitResult
  | { method: 'settings'; params: { settings: SidecarSettings } }
  | { method: 'theme'; params: { theme: InitParams['theme'] } }
  | { method: 'prepareLaunch'; params: PrepareLaunchParams }   // → PrepareLaunchResult
  | { method: 'sessionStarted'; params: SessionStartedParams }  // → { intercepted: boolean }
  | { method: 'sessionEnded'; params: SessionEndedParams }
  | { method: 'connectAgent'; params: { client: 'claude' | 'cursor' | 'gemini' | 'windsurf' | 'other' } } // → { text: string } to copy; error code `unavailable` when agent access is off
  | { method: 'command'; params: { name: 'clear' | 'toggle' | 'exportOpenApi' | 'exportPostman' | 'saveCaCertificate' } } // → { enabled } | { path } | {}
  // Added while building (sidecar report):
  | { method: 'workspaceFolders'; params: { workspaceFolders: string[] } } // a project window opened / closed
  | { method: 'uiVisible'; params: { visible: boolean } }                  // the tool window is on screen (no failure notifications then)
  | { method: 'fileSaved'; params: { path: string } }                      // → { approved: boolean } (a script file saved in the IDE is approved, like VS Code)
  | { method: 'uiUrl'; params?: undefined }                                // → { url } a fresh one-time UI URL (system-browser fallback, CONTRACTS §15.4)
  | { method: 'shutdown'; params?: undefined };

// ── sidecar → plugin requests (UI the sidecar can't do itself) ───────────────────────────────────────────
export type SidecarRequest =
  | { method: 'ui.openFile'; params: { path: string; line?: number; column?: number } }
  | { method: 'ui.openUntitled'; params: { files: { name: string; content: string; language?: string }[] } }
  | { method: 'ui.diff'; params: { title: string; left: { name: string; content: string }; right: { name: string; content: string } } }
  | { method: 'ui.clipboard'; params: { text: string } }
  | { method: 'ui.pick'; params: { title?: string; placeholder?: string; items: { label: string; description?: string; value: string }[] } } // → value | null
  | { method: 'ui.input'; params: { prompt: string; password?: boolean; value?: string } }                                                  // → string | null
  | { method: 'ui.save'; params: { defaultPath: string; filters?: Record<string, string[]> } }                                              // → path | null
  | { method: 'ui.confirm'; params: { message: string; detail?: string; buttons: string[]; modal?: boolean } }                              // → button | null
  | { method: 'ui.notify'; params: { level: 'info' | 'warning' | 'error'; message: string; buttons?: string[] } }                           // → button | null
  | { method: 'ui.reveal'; params?: { exchangeId?: string } }                                                                               // focus the tool window
  /** A client-certificate passphrase from the IDE's password store, without prompting; error / null = none. */
  | { method: 'secrets.clientCertPassphrase'; params: { host: string } };                                                                  // → string | null

// ── sidecar → plugin events ──────────────────────────────────────────────────────────────────────────────
export type SidecarEvent =
  | { event: 'ready'; data: InitResult }
  | { event: 'status'; data: { proxyRunning: boolean; port?: number; enabled: boolean; sessions: number; paused: number; lan?: boolean } }
  | { event: 'log'; data: { line: string } }  // the same lines also go to stderr: the plugin logs one of the two
  /** The user changed a setting from the UI (toggle, a notification's "Turn off"): persist it in the plugin's settings. */
  | { event: 'settingsChanged'; data: Partial<Pick<SidecarSettings, 'enabled' | 'notifications'>> };

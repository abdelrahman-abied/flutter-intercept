/**
 * App screenshots for agents (CONTRACTS §13.8). Shared types, lead-owned. Implemented in src/screenshot/**.
 */

export interface ScreenshotTarget {
  sessionId: string;
  /** Flutter device id (emulator-5554, a simulator UDID, macos, chrome, …). */
  deviceId?: string;
  /** The project root of the session (screenshots are saved under it). */
  projectRoot: string;
}

export interface Screenshot {
  /** Absolute path of the PNG under <project>/.dart_tool/flutter_intercept/screenshots/. */
  path: string;
  png: Buffer;
  width?: number;
  height?: number;
  takenAt: number;
  /** How it was taken. */
  method: 'vm-service' | 'adb' | 'simctl' | 'screencapture';
}

export interface ScreenshotDeps {
  /** VM service call through the session (Dart-Code DAP `callService`, src/vm). */
  callService?(sessionId: string, method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Runs a tool with an argument array (no shell). */
  exec(cmd: string, args: string[], opts?: { timeoutMs?: number; maxBuffer?: number }): Promise<{ stdout: Buffer; stderr: string }>;
  log(msg: string): void;
}

export type TakeScreenshot = (target: ScreenshotTarget, deps: ScreenshotDeps) => Promise<Screenshot>;

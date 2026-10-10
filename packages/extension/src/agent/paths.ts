/**
 * JSON path helpers for mutate rules and agent assertions (CONTRACTS §10.2), over the shared
 * `@flutter-intercept/proxy/jsonpath`. Pure, no `vscode`.
 */
import { parsePath, selectPath } from '@flutter-intercept/proxy/jsonpath';

export const MAX_PATH_CHARS = 1000;

/** Why `path` is not a valid path (readable), or undefined when it is. */
export function pathError(path: unknown): string | undefined {
  if (typeof path !== 'string' || !path) return 'path must be a non-empty string';
  if (path.length > MAX_PATH_CHARS) return `path must be at most ${MAX_PATH_CHARS} characters`;
  if (/[\0-\x1f]/.test(path)) return 'path must not contain control characters';
  if (!path.startsWith('$')) return 'path must start with "$" (e.g. "$.user.name")';
  try {
    parsePath(path);
  } catch (e) {
    return `invalid path ${JSON.stringify(path)}: ${(e as Error)?.message ?? String(e)}`;
  }
  return undefined;
}

/** Every value `path` selects in `root` (wildcards expanded). Throws on a bad path. */
export function select(root: unknown, path: string): { path: string; value: unknown }[] {
  return selectPath(root, path);
}

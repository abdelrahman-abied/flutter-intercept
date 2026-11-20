/**
 * YAML OpenAPI documents (CONTRACTS §21.3). Pure, no vscode.
 *
 * `js-yaml` is required on first use only, like `ws` in vm/transport.ts: it is bundled but not evaluated until a
 * YAML file is imported. JSON_SCHEMA = plain data only (no custom tags, no functions, no `!!js/*`). js-yaml keeps
 * an alias as a reference to the same object rather than a copy, so a "billion laughs" document stays small in
 * memory; whoever walks the value caps the walk (COLLECTION_LIMITS.walkNodes).
 */

interface JsYaml {
  load(text: string, opts: { schema: unknown; filename?: string; json?: boolean }): unknown;
  JSON_SCHEMA: unknown;
}

let jsYaml: JsYaml | undefined;
function lib(): JsYaml {
  return (jsYaml ??= require('js-yaml') as JsYaml);
}

/** True for a file name the importer should read as YAML. */
export function isYamlFile(name: string): boolean {
  return /\.ya?ml$/i.test(name);
}

/**
 * Parses one YAML document. A syntax error, an unknown tag or several documents in one file → `problem`, a short
 * line with the position and js-yaml's reason (never a snippet of the file: the file may hold credentials).
 */
export function parseYaml(text: string, label: string): { value?: unknown; problem?: string } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    const y = lib();
    return { value: y.load(src, { schema: y.JSON_SCHEMA, json: true }) };
  } catch (e) {
    const err = e as { reason?: unknown; mark?: { line?: unknown; column?: unknown } };
    const line = typeof err.mark?.line === 'number' ? err.mark.line + 1 : undefined;
    const column = typeof err.mark?.column === 'number' ? err.mark.column + 1 : undefined;
    const reason = typeof err.reason === 'string' && err.reason ? err.reason : 'not valid YAML';
    const at = line ? ` line ${line}${column ? `, column ${column}` : ''}` : '';
    return { problem: `${label}${at}: ${reason.slice(0, 200)}` };
  }
}

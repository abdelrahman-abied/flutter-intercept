// Bundle stub for `zod/v3` and `zod-to-json-schema` (PERF-2 #4: ~75 KB minified, evaluated at activation).
//
// Why this is unreachable for Flutter Intercept: the MCP SDK accepts Zod 3 and Zod 4 schemas. It only touches Zod 3
// (server/zod-compat.js: `z3rt.object(shape)`) and the Zod 3 → JSON Schema converter (server/zod-json-schema-compat.js:
// `zodToJsonSchema`) for a schema WITHOUT Zod 4's `_zod` marker. Every schema handed to it here is Zod 4
// (src/agent/schema.ts and the SDK's own types import `zod` / `zod/v4`). build.mjs fails the build if anything other
// than those two SDK files imports these modules, and the bundle smoke test drives the MCP server through this bundle.
//
// If that ever changes, fail loudly instead of misbehaving.
function unreachable(name) {
  return () => {
    throw new Error(
      `Flutter Intercept: ${name} (Zod 3) was stubbed out of the extension bundle; every MCP schema must be Zod 4. ` +
        'See packages/extension/stubs/zod-v3.js.',
    );
  };
}

module.exports = {
  object: unreachable('zod/v3 object()'),
  zodToJsonSchema: unreachable('zodToJsonSchema'),
};

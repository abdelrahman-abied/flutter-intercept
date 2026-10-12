/**
 * "Copy as grpcurl" for a recorded gRPC call (CONTRACTS §19.2). Pure: no `vscode`, no I/O (the schema comes in).
 *
 *     grpcurl [-plaintext | -insecure] [-import-path <dir> -proto <file>] -H 'name: value' … -d '<json>' host:port pkg.Service/Method
 *
 * - HTTP/2 gRPC and gRPC-Web calls (`grpc.web`) are both rendered as native gRPC.
 * - `-plaintext` for `http://`; `-insecure` only for a host in `flutterIntercept.grpc.decryptHosts` (an app that trusts
 *   the Flutter Intercept CA in debug usually talks to a server whose certificate isn't publicly trusted); plain TLS
 *   otherwise.
 * - `-d`: the request message decoded with the app's schema (client streaming: every request message, in grpcurl's
 *   concatenated format). Without a schema the snippet says so and leaves `-d` out.
 * - `-proto` / `-import-path` when the method came from a `.proto` file inside the workspace (paths relative to the
 *   workspace folder; the import path is the folder the package's directories start at, e.g. `protos` for
 *   `protos/demo/orders/v1/orders.proto` with `package demo.orders.v1`); otherwise a comment that the server must
 *   offer reflection.
 * - Metadata: the request headers minus pseudo / hop-by-hop / `content-type` / `te` / gRPC protocol headers and the
 *   browser's gRPC-Web headers. `-bin` values stay base64 (grpcurl decodes them).
 * - `redact` (agents): metadata and the request JSON as agents see them (host, port and method path are not secret).
 */
import * as path from 'path';
import type { Exchange } from '@flutter-intercept/proxy';
import { matchesHostPattern, parseHostPattern } from '@flutter-intercept/proxy/hosts';
import { redactGrpcMetadata } from '../agent/redact';
import { redactJsonValue } from '../agent/samples';
import { decodeGrpcMessages, grpcMethodPath, type GrpcDeps } from '../grpc/service';
import { shellQuote, snippetHeaders } from './snippets';

/** Request headers a grpcurl snippet never carries (lower-case): the protocol's, the transport's, the browser's. */
const GRPCURL_DROPPED = new Set([
  'content-type',
  'te',
  'grpc-encoding',
  'grpc-accept-encoding',
  'grpc-timeout',
  'grpc-status',
  'grpc-message',
  'grpc-status-details-bin',
  'content-encoding',
  'accept',
  'accept-encoding',
  'accept-language',
  'origin',
  'referer',
  'x-grpc-web',
  'x-user-agent',
  'user-agent',
  'cookie',
  'pragma',
  'cache-control',
]);

export interface GrpcurlOptions {
  /** The schema service (decode the request messages, find the method's `.proto`). */
  grpc?: Pick<GrpcDeps, 'codec' | 'schema'>;
  /** The workspace folder `-proto` / `-import-path` are relative to. */
  projectRoot?: string;
  /** `flutterIntercept.grpc.decryptHosts`: such hosts get `-insecure`. */
  decryptHosts?: readonly string[];
  /** Agents: URL, metadata and request JSON redacted. */
  redact?: boolean;
}

function insideRel(file: string, root: string | undefined): string | undefined {
  if (!root || !path.isAbsolute(file)) return undefined;
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : undefined;
}

function hostMatches(patterns: readonly string[] | undefined, host: string, port: number): boolean {
  for (const raw of patterns ?? []) {
    try {
      if (matchesHostPattern(parseHostPattern(raw), host, port)) return true;
    } catch {
      // an invalid pattern never matches
    }
  }
  return false;
}

/** The grpcurl command for a gRPC exchange. Throws a readable Error for anything that isn't one. */
export function toGrpcurl(e: Exchange, opts: GrpcurlOptions = {}): string {
  if (e.kind !== 'grpc') throw new Error('Copy as grpcurl works for gRPC calls only.');
  const methodPath = grpcMethodPath(e.url);
  let u: URL;
  try {
    u = new URL(e.url);
  } catch {
    throw new Error("Can't build a grpcurl command: the call has no absolute URL.");
  }
  if (!methodPath) throw new Error("Can't build a grpcurl command: the URL doesn't name a gRPC method (/package.Service/Method).");
  const notes: string[] = [];
  const args: string[] = [];
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  const host = u.hostname;
  if (u.protocol === 'http:') args.push('-plaintext');
  else if (hostMatches(opts.decryptHosts, host.replace(/^\[|\]$/g, ''), port)) args.push('-insecure');

  // -proto / -import-path for a method read from a .proto in the workspace
  let schemaMethod;
  try {
    schemaMethod = opts.grpc?.schema()?.method(methodPath);
  } catch {
    schemaMethod = undefined;
  }
  const relProto = schemaMethod?.source === 'proto' ? insideRel(schemaMethod.file, opts.projectRoot) : undefined;
  if (relProto) {
    const pkgDirs = methodPath.slice(1).split('/')[0].split('.').slice(0, -1).join('/'); // demo.orders.v1.OrderService → demo/orders/v1
    const dir = path.posix.dirname(relProto);
    let importPath = dir;
    let protoArg = path.posix.basename(relProto);
    if (pkgDirs && (dir === pkgDirs || dir.endsWith(`/${pkgDirs}`))) {
      importPath = dir === pkgDirs ? '.' : dir.slice(0, dir.length - pkgDirs.length - 1);
      protoArg = `${pkgDirs}/${protoArg}`;
    }
    args.push(`-import-path ${shellQuote(importPath)}`, `-proto ${shellQuote(protoArg)}`);
    notes.push('# Run from the workspace folder (the -proto path is relative to it).');
  } else {
    notes.push("# Without -proto, the server must support gRPC reflection (this method's schema isn't from a .proto file in the workspace).");
  }

  // metadata
  const headers = opts.redact ? redactGrpcMetadata(e.requestHeaders) : e.requestHeaders;
  for (const [name, values] of snippetHeaders(headers)) {
    if (GRPCURL_DROPPED.has(name.toLowerCase()) || /^sec-/i.test(name)) continue;
    for (const v of values) args.push(`-H ${shellQuote(`${name}: ${v}`)}`);
  }

  // -d: the request message(s) as JSON
  const decoded = decodeGrpcMessages(e, opts.grpc, { filter: (f) => f.kind === 'message' && f.dir === 'send' && !f.dropped }).messages;
  if (!decoded.length) notes.push('# No request message was recorded: add -d \'<json>\' if the method expects one.');
  else if (decoded.every((m) => m.via === 'schema' && m.json !== undefined && !m.truncated)) {
    const all = schemaMethod?.clientStreaming ? decoded : decoded.slice(0, 1);
    const text = all.map((m) => JSON.stringify(opts.redact ? redactJsonValue(m.json) : m.json)).join(' ');
    args.push(`-d ${shellQuote(text)}`);
  } else if (decoded.some((m) => m.truncated)) {
    notes.push('# The request message was larger than 64 KB when recorded, so it is not included: add -d \'<json>\' yourself.');
  } else {
    notes.push("# No protobuf schema for this method, so the request message can't be shown as JSON: add -d '<json>' yourself.");
  }
  if (e.grpc?.web) notes.push(`# Recorded as gRPC-Web (${e.grpc.web}); grpcurl speaks native gRPC to the server.`);

  const authority = u.host.includes(':') && !u.host.endsWith(']') ? u.host : `${u.host}:${port}`;
  const lines = ['grpcurl', ...args.map((a) => `  ${a}`), `  ${shellQuote(authority)} ${shellQuote(methodPath.slice(1))}`];
  return [...notes, lines.join(' \\\n')].join('\n');
}

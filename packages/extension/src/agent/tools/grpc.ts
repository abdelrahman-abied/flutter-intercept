/**
 * Agent tools: grpc (QUALITY-1 Q5: split out of api.ts). Each handler gets the shared AgentViews and its parsed input.
 */
import { GRPC_CODE_NAMES, grpcCodeName, grpcMethodFromGlob, normalizeMethodName } from '../../grpc/service';
import { ToolInput } from '../schema';
import { AgentToolError, ToolResult } from '../types';
import { streamingLabel } from '../shared';
import type { AgentViews } from '../views';
import type { ToolHandlers } from './types';

/**
 * add_grpc_mock: a `grpcMock` rule for one method. JSON messages are encoded now (so a wrong field fails this call,
 * naming the JSON path) and kept as `messagesJson` (the host re-encodes them when the schema changes); base64
 * messages are kept as they are.
 */
export function addGrpcMock(ag: AgentViews, i: ToolInput<'add_grpc_mock'>): ToolResult {
  const bad = (m: string) => new AgentToolError(m, 'invalid');
  const named = i.service !== undefined || i.method !== undefined;
  if (i.url !== undefined && named) throw bad('pass url, or service and method (not both)');
  if (i.url === undefined && !(i.service !== undefined && i.method !== undefined)) throw bad('pass url (e.g. "*/shop.v1.CartService/AddItem"), or both service and method');
  const glob = i.url ?? `*/${i.service}/${i.method}`;
  const path = grpcMethodFromGlob(glob);
  const code = i.code === undefined ? 0 : typeof i.code === 'string' ? GRPC_CODE_NAMES.indexOf(i.code as (typeof GRPC_CODE_NAMES)[number]) : i.code;
  const list = i.messages ?? [];
  const strings = list.filter((m) => typeof m === 'string') as string[];
  if (strings.length && strings.length !== list.length) throw bad('messages: pass JSON objects (encoded with the schema) or base64 strings, not both');
  let encoded: 'json' | 'base64' | undefined;
  if (list.length && !strings.length) {
    const g = ag.grpcOrThrow();
    if (!path) throw bad(`url ${JSON.stringify(glob.slice(0, 200))} doesn't name one gRPC method (…/package.Service/Method), so the message type is unknown; pass base64 messages, or a url / service + method without wildcards`);
    const schema = g.schema();
    if (!schema) throw new AgentToolError("no protobuf schema was found in the app's generated *.pb.dart files; pass the messages as base64 strings", 'state');
    const method = schema.method(path);
    if (!method) {
      const near = ag.similarMethods(schema, path);
      throw new AgentToolError(`the app's generated code has no gRPC method ${path}${near.length ? ` (did you mean ${near.join(', ')}?)` : ''}; get_grpc_schema lists the methods`, 'not_found');
    }
    list.forEach((json, n) => {
      try {
        g.codec.encodeMessage(schema, method.responseType, json);
      } catch (e) {
        throw bad(`messages[${n}] is not a valid ${method.responseType}: ${(e as Error)?.message ?? String(e)}`);
      }
    });
    encoded = 'json';
  } else if (strings.length) {
    strings.forEach((b, n) => {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b)) throw bad(`messages[${n}] is not base64 (a serialized protobuf message)`);
    });
    encoded = 'base64';
  }
  const codeText = code === 0 ? 'OK' : `${code} ${grpcCodeName(code)}`;
  const result = ag.insertRule({
    id: ag.newId(),
    enabled: true,
    name: ag.label(i.name, `gRPC mock ${path ?? glob} → ${codeText}${list.length ? ` (${list.length} message${list.length === 1 ? '' : 's'})` : ''}`),
    match: { method: 'POST', url: glob },
    action: {
      kind: 'grpcMock',
      ...(code !== 0 ? { code } : {}),
      ...(i.message !== undefined ? { message: i.message } : {}),
      ...(encoded === 'json' ? { messagesJson: list } : encoded === 'base64' ? { messages: strings } : {}),
      ...(i.delayMs !== undefined ? { delayMs: i.delayMs } : {}),
      ...(i.gapMs !== undefined ? { gapMs: i.gapMs } : {}),
    },
    ...ag.spending(i),
  });
  return { ...result, ...(path ? { method: path } : { match: glob }), code, status: grpcCodeName(code), messages: list.length };
}


export function getGrpcSchema(ag: AgentViews, i: ToolInput<'get_grpc_schema'>): ToolResult {
  const g = ag.deps.grpc;
  if (!g) return { available: false, reason: 'gRPC support is not available in this build of Flutter Intercept' };
  if (!g.enabled()) return { available: false, reason: 'gRPC support is off (setting flutterIntercept.grpc.enabled)' };
  if (i.method !== undefined && i.message !== undefined) throw new AgentToolError('pass method or message, not both', 'invalid');
  const schema = g.schema();
  const st = g.status();
  const problems = (st?.problems ?? []).slice(0, 10).map((p) => ag.scrub(p));
  if (!schema) {
    return {
      available: false,
      reason: st
        ? "no protobuf schema: no protoc-generated Dart (*.pbgrpc.dart / *.pb.dart) was found in the workspace or in packages with services (run protoc with the Dart plugin, or open the app's folder)"
        : 'the protobuf schema is still loading; retry in a moment',
      ...(problems.length ? { problems } : {}),
    };
  }
  if (i.method !== undefined) {
    const p = normalizeMethodName(i.method);
    if (!p) throw new AgentToolError(`method must look like "/package.Service/Method" (got ${JSON.stringify(i.method.slice(0, 100))})`, 'invalid');
    const m = schema.method(p);
    if (!m) {
      const near = ag.similarMethods(schema, p);
      throw new AgentToolError(`no gRPC method ${p} in the app's generated code${near.length ? ` (similar: ${near.join(', ')})` : ''}`, 'not_found');
    }
    const req = schema.message(m.requestType);
    const res = schema.message(m.responseType);
    const file = ag.schemaFile(m.file);
    return {
      available: true,
      method: m.path,
      requestType: m.requestType,
      responseType: m.responseType,
      clientStreaming: m.clientStreaming,
      serverStreaming: m.serverStreaming,
      streaming: streamingLabel(m),
      ...(file ? { file } : {}),
      ...(m.line !== undefined ? { line: m.line } : {}),
      ...(req ? { request: ag.messageView(schema, req) } : {}),
      ...(res ? { response: ag.messageView(schema, res) } : {}),
      requestSkeleton: ag.skeletonOf(g, schema, m.requestType),
      responseSkeleton: ag.skeletonOf(g, schema, m.responseType),
    };
  }
  if (i.message !== undefined) {
    const msg = ag.findMessage(schema, i.message);
    if (msg) return { available: true, message: ag.messageView(schema, msg), skeleton: ag.skeletonOf(g, schema, msg.name) };
    const en = schema.enumType(i.message.trim().replace(/^\./, ''));
    if (en) return { available: true, enum: { name: en.name, values: en.values.slice(0, 500) } };
    const n = i.message.toLowerCase();
    const near = schema.messages.filter((m) => m.name.toLowerCase().includes(n)).slice(0, 10).map((m) => m.name);
    throw new AgentToolError(`no message or enum ${JSON.stringify(i.message.slice(0, 200))} in the app's generated code${near.length ? ` (similar: ${near.join(', ')})` : ''}`, 'not_found');
  }
  const methods = schema.methods.slice(0, i.limit).map((m) => ({ path: m.path, requestType: m.requestType, responseType: m.responseType, streaming: streamingLabel(m) }));
  return {
    available: true,
    methods,
    totalMethods: schema.methods.length,
    messages: schema.messages.length,
    ...(schema.methods.length > methods.length ? { more: schema.methods.length - methods.length } : {}),
    ...(problems.length ? { problems } : {}),
  };
}

export const grpcTools: ToolHandlers = {
  add_grpc_mock: (ag, i) => addGrpcMock(ag, i),
  get_grpc_schema: (ag, i) => getGrpcSchema(ag, i),
};

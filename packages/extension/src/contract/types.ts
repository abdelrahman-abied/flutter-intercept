/**
 * Contract check — your Dart models vs the real API (CONTRACTS §10.3). Shared types, lead-owned.
 * The wire contract comes from json_serializable's generated `_$XFromJson` in `*.g.dart` (freezed delegates
 * to it), never from the hand-written model: that function is exactly what runs on the response.
 */

export type WireType =
  | { kind: 'string' | 'int' | 'double' | 'num' | 'bool' | 'dynamic' | 'datetime' | 'uri' | 'bigint' }
  | { kind: 'list'; of: WireType }
  | { kind: 'map'; of: WireType }                    // Map<String, X>
  | { kind: 'model'; name: string }                  // nested X.fromJson / _$XFromJson
  | { kind: 'enum'; name: string; values: string[] } // $enumDecode(_$XEnumMap, …): the JSON values
  | { kind: 'unknown'; text: string };               // a converter / custom fromJson we can't model: never flagged

export interface WireField {
  key: string;        // JSON key (after @JsonKey(name:) / fieldRename)
  dartName: string;
  type: WireType;
  nullable: boolean;  // `as String?` / `?? …` / a nullable conversion: null and missing are fine
  hasDefault: boolean; // @JsonKey(defaultValue) / freezed @Default: missing is fine
}

export interface WireModel {
  name: string;          // Dart class name, e.g. "User"
  generatedFile: string; // absolute path of the *.g.dart it came from
  sourceFile?: string;   // the model's own .dart file (the `part of` owner)
  sourceLine?: number;   // 1-based line of `class User` there
  fields: WireField[];
  fieldLines?: Record<string, number>; // dartName → 1-based line in sourceFile (for diagnostics)
}

/** An API method found from Retrofit / Chopper annotations. */
export interface ApiEndpoint {
  method: string;           // GET, POST, …
  pathTemplate: string;     // "/users/{id}" (baseUrl joined when known)
  baseUrl?: string;
  responseModel?: string;   // "User" for Future<User> / HttpResponse<User> / Response<User>
  responseIsList?: boolean; // Future<List<User>>
  dartMethod: string;       // "getUser"
  file: string;
  line: number;
  className?: string;       // the annotated abstract class, e.g. "UserApi"
  importUri?: string;       // "package:app/api/user_api.dart" (for generated tests)
  params?: ApiParam[];      // in declaration order; needed for mocktail fixtures
  returnType?: string;      // as declared, e.g. "Future<HttpResponse<User>>"
}

/** One parameter of a Retrofit / Chopper method. */
export interface ApiParam {
  name: string;   // Dart parameter name
  type: string;   // as written: "int", "String?", "User", "Map<String, dynamic>"
  kind: 'path' | 'query' | 'body' | 'header' | 'field' | 'other';
  key?: string;   // @Path('id') / @Query('page') name when it differs from `name`
  named?: boolean; // declared inside `{…}`
}

export type MappingVia = 'retrofit' | 'chopper' | 'source' | 'user' | 'none';

export interface ContractViolation {
  path: string;           // JSON path in the response: "$.data[3].avatar_url"
  model: string;          // the model whose field it is
  field: string;          // dartName
  key: string;            // JSON key
  expected: string;       // "String", "int?", "List<Item>", "enum Role(admin|user)"
  actual: string;         // "null", "missing", "string", "number 1.5", "unknown enum value \"guest\""
  severity: 'error' | 'warning'; // error = fromJson throws on this response; warning = suspicious (e.g. double sent as int string)
  message: string;        // "avatar_url is null in GET /users/42 → TypeError: Null is not a subtype of String"
  file?: string;          // model source file (or the .g.dart if unknown)
  line?: number;
}

export interface ContractResult {
  exchangeId: string;
  checked: boolean;
  model?: string;
  listOf?: boolean;
  via: MappingVia;
  violations: ContractViolation[];   // capped at 50
  reason?: string;                   // why not checked: "no model mapped", "not JSON", "body truncated", …
}

/** What the host (controller / agent API) uses. Implemented in src/contract/service.ts. */
export interface ContractService {
  /** Check one finished exchange. Never throws: problems come back as checked:false + reason. */
  check(exchange: import('@flutter-intercept/proxy').Exchange, opts?: { model?: string }): Promise<ContractResult>;
  /** Every model found in the workspace (for pickers). */
  models(): Promise<{ name: string; file: string }[]>;
  /** Every Retrofit / Chopper endpoint found in the workspace (for fixture generation). */
  endpoints(): Promise<ApiEndpoint[]>;
  /** Remember "METHOD urlTemplate → model" for this workspace (via 'user'). model undefined = forget. */
  remember(exchange: import('@flutter-intercept/proxy').Exchange, model: string | undefined): Promise<void>;
  /** Fires when *.g.dart / API files changed and earlier results may be stale. */
  onDidChangeModels(listener: () => void): { dispose(): void };
}

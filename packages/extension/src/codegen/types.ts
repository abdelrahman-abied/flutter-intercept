/**
 * Code generation from recorded traffic (CONTRACTS §10.4). Shared types, lead-owned. Pure modules: they
 * return file contents; the caller decides where they go (an untitled editor for the UI; the agent writes
 * files itself). Fixtures are always built from the REDACTED view.
 */

export type ModelStyle = 'freezed' | 'json_serializable' | 'plain';
export type FixtureStyle = 'http_mock_adapter' | 'mock_client' | 'mocktail';

export interface GeneratedFile {
  path: string;     // project-relative suggestion, e.g. "lib/models/user.dart", "test/fixtures/get_users_1.json"
  content: string;
}

export interface ModelGenInput {
  /** Every decoded JSON body sampled for this route (≥ 1); merged to infer optional / nullable fields. */
  samples: unknown[];
  rootName: string;       // "User"
  style: ModelStyle;
  /** Request for the doc comment, e.g. "GET https://api.example.com/users/{id}". */
  source?: string;
}

export interface FixtureGenInput {
  exchanges: import('@flutter-intercept/proxy').Exchange[]; // already redacted by the caller
  style: FixtureStyle;
  name: string;           // snake_case base name, e.g. "get_user"
  packageName?: string;   // the app's pubspec name, for imports
  /** For `mocktail`: the Retrofit interface to mock; without it the test falls back to `mock_client`. */
  api?: FixtureApi;
  /** `flutter_test` (default, Flutter apps) or `test` (pure Dart packages). */
  testPackage?: 'flutter_test' | 'test';
}

/** The Retrofit interface a `mocktail` test mocks (endpoints from ContractService.endpoints()). */
export interface FixtureApi {
  className: string; // "UserApi"
  /** Imports the test needs for the interface and its models ("package:app/api/user_api.dart"). */
  imports?: string[];
  endpoints: import('../contract/types').ApiEndpoint[];
}

export interface CodegenService {
  /** Style matching the project's pubspec (freezed > json_serializable > plain). */
  detectModelStyle(projectRoot: string): ModelStyle;
  /** Fixture style matching dev_dependencies (http_mock_adapter > mocktail > mock_client). */
  detectFixtureStyle(projectRoot: string): FixtureStyle;
  generateModels(input: ModelGenInput): GeneratedFile[];
  generateFixtureTest(input: FixtureGenInput): GeneratedFile[];
  /** "/users/42" → "/users/{id}" (numeric, uuid, hex ids …), for grouping samples of one route. */
  routeTemplate(url: string): string;
}

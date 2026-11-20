// The shop fixtures through the real parsers (Postman with its environment, OpenAPI), for the §22 tests.
import * as fs from 'fs';
import * as path from 'path';
import { mergeCollectionVars, parsePostmanEnvironment } from '../../src/mocks/environment';
import { parseOpenApi } from '../../src/mocks/openapi';
import { parsePostman, postmanCollectionVariables } from '../../src/mocks/postman';
import type { MockEndpoint } from '../../src/mocks/types';

const fixtures = path.join(__dirname, '..', 'fixtures', 'collections');
const readJson = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));

export function shopPostman(): MockEndpoint[] {
  const collection = readJson('shop.postman_collection.json');
  const env = readJson('shop.postman_environment.json');
  const vars = mergeCollectionVars({}, parsePostmanEnvironment(env).values, postmanCollectionVariables(collection));
  return parsePostman(collection, vars).endpoints;
}

export function shopOpenApi(): MockEndpoint[] {
  return parseOpenApi(readJson('shop.openapi.json'), { values: new Map(), sources: new Map() }).endpoints;
}

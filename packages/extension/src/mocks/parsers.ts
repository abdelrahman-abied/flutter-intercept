/**
 * The real parsers for the collections core (CONTRACTS §21.2–§21.4): Postman (M1) and OpenAPI (M2), in one object so
 * MockCollectionsCore stays independent of them (tests inject fakes). Pure.
 */
import type { CollectionParsers } from './core';
import { detectFormat } from './detect';
import { mergeCollectionVars, parsePostmanEnvironment } from './environment';
import { parseOpenApi } from './openapi';
import { parsePostman, postmanCollectionVariables } from './postman';
import { sanitisePostman } from './sanitise';

export const collectionParsers: CollectionParsers = {
  detectFormat,
  parsePostman,
  postmanCollectionVariables,
  parsePostmanEnvironment,
  mergeCollectionVars,
  parseOpenApi,
  sanitisePostman,
};

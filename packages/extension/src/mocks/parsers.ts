/**
 * The real parsers for the collections core (CONTRACTS §21.2–§21.4, §24.4): Postman (M1), OpenAPI (M2), Swagger 2.0,
 * Insomnia and Bruno (D), in one object so MockCollectionsCore stays independent of them (tests inject fakes). Pure.
 */
import type { CollectionParsers } from './core';
import { parseBruno } from './bruno';
import { detectFormat } from './detect';
import { mergeCollectionVars, parsePostmanEnvironment } from './environment';
import { parseInsomniaDoc } from './insomnia';
import { parseOpenApi } from './openapi';
import { parsePostman, postmanCollectionVariables } from './postman';
import { sanitisePostman } from './sanitise';
import { parseSwagger2Doc } from './swagger2';

export const collectionParsers: CollectionParsers = {
  detectFormat,
  parsePostman,
  postmanCollectionVariables,
  parsePostmanEnvironment,
  mergeCollectionVars,
  parseOpenApi,
  sanitisePostman,
  parseSwagger2Doc,
  parseInsomniaDoc,
  parseBruno,
};

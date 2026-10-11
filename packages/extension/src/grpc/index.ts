// CONTRACTS §16.3: the app's protoc-generated Dart as the gRPC contract. Pure (no vscode, no I/O): the host
// finds the files and passes their contents.

import { decodeMessage, decodeRaw, encodeMessage, skeleton } from './codec';
import { isGrpcGeneratedFile, loadGrpcSchema } from './schema';
import type { GrpcCodec } from './types';

export * from './types';
export { decodeMessage, decodeRaw, encodeMessage, isGrpcGeneratedFile, loadGrpcSchema, skeleton };

/** The same functions as one object (the `GrpcCodec` interface). */
export const grpcCodec: GrpcCodec = { loadGrpcSchema, decodeMessage, decodeRaw, encodeMessage, skeleton };

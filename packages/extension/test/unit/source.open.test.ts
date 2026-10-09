import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { opened: string[]; shown: unknown[]; revealed: unknown[] } = { opened: [], shown: [], revealed: [] };
let openError: Error | undefined;

vi.mock('vscode', () => {
  class Position {
    constructor(public line: number, public character: number) {}
  }
  class Range {
    constructor(public start: Position, public end: Position) {}
  }
  return {
    Position,
    Range,
    Uri: { file: (p: string) => ({ fsPath: p }) },
    TextEditorRevealType: { InCenter: 2 },
    workspace: {
      openTextDocument: async (uri: { fsPath: string }) => {
        if (openError) throw openError;
        calls.opened.push(uri.fsPath);
        // A 10-line document whose lines are 20 characters long.
        return { validatePosition: (p: Position) => new Position(Math.min(p.line, 9), Math.min(p.character, 20)) };
      },
    },
    window: {
      showTextDocument: async (_doc: unknown, options: unknown) => {
        calls.shown.push(options);
        return { revealRange: (range: unknown, type: unknown) => calls.revealed.push({ range, type }) };
      },
    },
  };
});

import { framePosition, openFrame } from '../../src/source/open';

// Identity realpath over a fake tree: /w is the workspace; /w/lib/out.dart is a symlink to /etc/passwd.
const realpath = (p: string) => {
  if (p === '/w/lib/out.dart') return '/etc/passwd';
  return p;
};
const opts = { allowedRoots: ['/w', '/pub/dio-5.11.1'], realpath };

describe('openFrame', () => {
  beforeEach(() => {
    calls.opened = [];
    calls.shown = [];
    calls.revealed = [];
    openError = undefined;
  });

  it('converts Dart 1-based line:column to 0-based', () => {
    expect(framePosition({ line: 15, column: 20 })).toEqual({ line: 14, character: 19 });
    expect(framePosition({ line: 1, column: 1 })).toEqual({ line: 0, character: 0 });
    expect(framePosition({})).toEqual({ line: 0, character: 0 });
    expect(framePosition({ line: 0, column: -3 })).toEqual({ line: 0, character: 0 });
  });

  it('opens the file at the frame position and reveals it in the center', async () => {
    await openFrame({ fn: 'OrdersApi.createOrder', uri: 'package:demo_app/api/orders_api.dart', line: 5, column: 12, path: '/w/app/lib/api/orders_api.dart', inProject: true }, opts);
    expect(calls.opened).toEqual(['/w/app/lib/api/orders_api.dart']);
    expect(calls.shown).toEqual([{ selection: { start: { line: 4, character: 11 }, end: { line: 4, character: 11 } }, preview: true }]);
    expect(calls.revealed).toEqual([{ range: { start: { line: 4, character: 11 }, end: { line: 4, character: 11 } }, type: 2 }]);
  });

  it('clamps a stale line (file edited since the request) to the document', async () => {
    await openFrame({ fn: 'f', uri: 'package:a/a.dart', line: 500, column: 3, path: '/w/a.dart', inProject: true }, opts);
    expect(calls.shown).toEqual([{ selection: { start: { line: 9, character: 2 }, end: { line: 9, character: 2 } }, preview: true }]);
  });

  it('throws a readable error when the frame has no file or the file cannot be opened', async () => {
    await expect(openFrame({ fn: 'Zone.run', uri: 'dart:async/zone.dart', line: 3, inProject: false }, opts)).rejects.toThrow(/No source file for Zone\.run \(dart:async\/zone\.dart\)/);
    openError = new Error('cannot open file:///w/gone.dart. Detail: Unable to read file');
    await expect(openFrame({ fn: 'f', uri: 'package:a/gone.dart', path: '/w/gone.dart', inProject: true }, opts)).rejects.toThrow(/Could not open \/w\/gone\.dart: cannot open/);
    expect(calls.shown).toHaveLength(0);
  });

  it('REVIEW-3 #3: refuses frames outside the allowed roots, symlink escapes and UNC paths, before opening anything', async () => {
    const f = (p: string) => ({ fn: 'f', uri: 'file:///x', line: 1, path: p, inProject: false });
    await expect(openFrame(f('/etc/passwd'), opts)).rejects.toThrow('This frame points outside the workspace: passwd');
    await expect(openFrame(f('/w/lib/out.dart'), opts)).rejects.toThrow('This frame points outside the workspace: out.dart');
    await expect(openFrame(f('\\\\host\\share\\a.dart'), opts)).rejects.toThrow(/outside the workspace/);
    await expect(openFrame(f('/w/a.dart'), { allowedRoots: [], realpath })).rejects.toThrow(/outside the workspace/);
    expect(calls.opened).toEqual([]);
    await openFrame(f('/pub/dio-5.11.1/lib/dio.dart'), opts);
    expect(calls.opened).toEqual(['/pub/dio-5.11.1/lib/dio.dart']);
  });
});

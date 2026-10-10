import { describe, expect, it } from 'vitest';
import { displayCommand, maskArgs, quoteCmdArg, spawnPlan } from '../src/command';

describe('maskArgs (REVIEW-7 #10)', () => {
  it('masks user dart-define values in every form, keeps ours', () => {
    expect(
      maskArgs([
        'test', '--dart-define=API_KEY=s3cret', '--dart-define', 'TOKEN=abc', '-DPASS=pw', '-D', 'X=1',
        '--dart-define=FLUTTER_INTERCEPT_PROXY=localhost:1', '--dart-define=FLUTTER_INTERCEPT_ENTRY_SHA=abc123', '--dart-define-from-file=env/ci.json', '--flavor', 'dev',
      ]),
    ).toEqual([
      'test', '--dart-define=API_KEY=***', '--dart-define', 'TOKEN=***', '-DPASS=***', '-D', 'X=***',
      '--dart-define=FLUTTER_INTERCEPT_PROXY=localhost:1', '--dart-define=FLUTTER_INTERCEPT_ENTRY_SHA=abc123', '--dart-define-from-file=env/ci.json', '--flavor', 'dev',
    ]);
  });

  it('redacts other secret-looking values', () => {
    const shown = displayCommand('flutter', ['test', '--header=Authorization: Bearer abcdef0123456789abcdef', 'https://x.test/?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln']);
    expect(shown).not.toContain('abcdef0123456789abcdef');
    expect(shown).not.toContain('eyJhbGci');
    expect(displayCommand('flutter', ['test', 'a b'])).toBe("flutter test 'a b'");
  });
});

/** One cmd.exe parsing pass: `^x` → x; an unescaped & | < > would start another command. */
function cmdPass(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '^') {
      out += s[++i] ?? '';
      continue;
    }
    if ('&|<>'.includes(c)) throw new Error(`unescaped ${c} at ${i} in ${s}`);
    out += c;
  }
  return out;
}

/** CommandLineToArgvW-style splitting (quotes, backslashes before quotes). */
function splitArgv(s: string): string[] {
  const args: string[] = [];
  let cur = '';
  let inQuotes = false;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      let n = 0;
      while (s[i] === '\\') {
        n++;
        i++;
      }
      if (s[i] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2) cur += '"';
        else {
          inQuotes = !inQuotes;
          has = true;
        }
      } else {
        cur += '\\'.repeat(n);
        i--;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = !inQuotes;
      has = true;
      continue;
    }
    if (c === ' ' && !inQuotes) {
      if (cur || has) args.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
  }
  if (cur || has) args.push(cur);
  return args;
}

describe('Windows: flutter.bat without a shell (REVIEW-7 #11)', () => {
  const tricky = ['--dart-define=API=https://x/api?a=1&b=2', 'with space', '100%PATH%', 'say "hi"', 'pipe|and<more>', 'caret^', 'trailing\\', '!bang!', ''];

  it('runs cmd.exe /d /s /c with a verbatim, fully escaped line', () => {
    const plan = spawnPlan('C:\\Program Files\\flutter\\bin\\flutter.bat', ['test', ...tricky], 'win32', 'C:\\Windows\\system32\\cmd.exe');
    expect(plan.file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(plan.windowsVerbatimArguments).toBe(true);
    const line = plan.args[3];
    expect(line.startsWith('"') && line.endsWith('"')).toBe(true);
    // cmd.exe /s strips the outer quotes and parses once (the command + arguments): no separator survives
    const once = cmdPass(line.slice(1, -1));
    const program = 'C:\\Program Files\\flutter\\bin\\flutter.bat';
    expect(once.startsWith(`${program} `)).toBe(true);
    // the batch file's %* is parsed by cmd.exe again: still no separator, and the arguments come back unchanged
    const twice = cmdPass(once.slice(program.length + 1));
    expect(splitArgv(twice)).toEqual(['test', ...tricky]);
  });

  it('an & stays inside its argument', () => {
    expect(quoteCmdArg('a&b')).toBe('^^^"a^^^&b^^^"');
    expect(splitArgv(cmdPass(cmdPass(quoteCmdArg('a&b'))))).toEqual(['a&b']);
  });

  it('refuses line breaks', () => {
    expect(() => quoteCmdArg('a\nb')).toThrow(/line breaks/);
    expect(() => spawnPlan('flutter.bat', ['x\r\ny'], 'win32')).toThrow(/line breaks/);
  });

  it('spawns executables directly everywhere else', () => {
    expect(spawnPlan('flutter', ['test', 'a&b'], 'darwin')).toEqual({ file: 'flutter', args: ['test', 'a&b'], windowsVerbatimArguments: false });
    expect(spawnPlan('C:\\sdk\\flutter.exe', ['a&b'], 'win32')).toEqual({ file: 'C:\\sdk\\flutter.exe', args: ['a&b'], windowsVerbatimArguments: false });
  });
});

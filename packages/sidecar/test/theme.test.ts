import { describe, expect, it } from 'vitest';
import { THEME_VARS } from '../../webview/src/themeVars';
import { FONT, PALETTES, themeCss } from '../src/theme';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings';

describe('IDE theme stylesheet', () => {
  for (const [name, palette] of Object.entries(PALETTES)) {
    it(`defines every variable the webview uses (${name})`, () => {
      const vars = { ...FONT, ...palette };
      expect(THEME_VARS.filter((v) => !(v in vars) || !vars[v])).toEqual([]);
      for (const v of THEME_VARS) expect(themeCss()).toContain(`${v}:`);
    });
  }

  it('uses real contrast borders only in high contrast', () => {
    expect(PALETTES['high-contrast']['--vscode-contrastBorder']).not.toBe('transparent');
    expect(PALETTES['high-contrast']['--vscode-contrastActiveBorder']).not.toBe('transparent');
    for (const t of ['light', 'dark'] as const) {
      expect(PALETTES[t]['--vscode-contrastBorder']).toBe('transparent');
      expect(PALETTES[t]['--vscode-contrastActiveBorder']).toBe('transparent');
    }
  });

  it('keys each palette off the page attribute', () => {
    const css = themeCss();
    for (const t of ['dark', 'light', 'high-contrast']) expect(css).toContain(`:root[data-fi-theme="${t}"]`);
  });
});

describe('settings', () => {
  it('fills defaults and replaces wrong types', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    const s = normalizeSettings({ port: 'x', enabled: false, nativeClients: 'bogus', agent: { access: 'readOnly', mcpPort: 70000 }, tlsPassthrough: ['a.com', 3], ideHttpProxy: { url: ' http://p:1 ' } });
    expect(s.port).toBe(8899);
    expect(s.enabled).toBe(false);
    expect(s.nativeClients).toBe('profile');
    expect(s.agent).toEqual({ access: 'readOnly', redactSecrets: true, screenshots: true, mcpPort: 47823 });
    expect(s.tlsPassthrough).toEqual(['a.com']);
    expect(s.ideHttpProxy).toEqual({ url: 'http://p:1' });
  });
});

import { describe, expect, it } from 'vitest';
import { PREFS_SCRIPT, THEME_COLOR } from '../theme';

/** Runs the real pre-paint <head> script against a minimal fake document + localStorage. */
function runPrefsScript(stored: Record<string, string> | 'throws') {
  const dataset: Record<string, string> = {};
  const metas: { name: string; content: string }[] = [];
  const document = {
    documentElement: { dataset },
    createElement: () => ({ name: '', content: '' }),
    head: { appendChild: (m: { name: string; content: string }) => metas.push(m) },
  };
  const localStorage = {
    getItem: (key: string) => {
      if (stored === 'throws') throw new Error('storage blocked');
      return stored[key] ?? null;
    },
  };
  new Function('document', 'localStorage', PREFS_SCRIPT)(document, localStorage);
  return { dataset, metas };
}

describe('pre-paint theme script', () => {
  it('defaults to dark: no data-theme, dark navy browser chrome', () => {
    const { dataset, metas } = runPrefsScript({});
    expect(dataset.theme).toBeUndefined();
    expect(metas).toEqual([{ name: 'theme-color', content: THEME_COLOR.dark }]);
  });

  it('restores a saved light theme, including the browser-chrome colour', () => {
    const { dataset, metas } = runPrefsScript({ 'wr:theme': 'light' });
    expect(dataset.theme).toBe('light');
    expect(metas).toEqual([{ name: 'theme-color', content: THEME_COLOR.light }]);
  });

  it('still sets a theme colour when storage is blocked (private mode)', () => {
    const { dataset, metas } = runPrefsScript('throws');
    expect(dataset).toEqual({});
    expect(metas).toEqual([{ name: 'theme-color', content: THEME_COLOR.dark }]);
  });

  it('theme colours match the page backgrounds in globals.css', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('app/globals.css', 'utf8');
    expect(css).toMatch(new RegExp(`:root \\{[^}]*--c-night: ${THEME_COLOR.dark};`));
    expect(css).toMatch(new RegExp(`:root\\[data-theme='light'\\] \\{[^}]*--c-night: ${THEME_COLOR.light};`));
  });
});

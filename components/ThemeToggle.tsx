'use client';

import { useSyncExternalStore } from 'react';
import { applyThemeColor, THEME_KEY, type Theme } from '@/lib/client/theme';

/** The light / dark pastel theme switch. Storage key, colours and the pre-paint script: lib/client/theme.ts. */
const EVENT = 'wr-theme';

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}
const readTheme = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

function setTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'light') root.dataset.theme = 'light';
  else delete root.dataset.theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private mode — the toggle still works for this page */
  }
  applyThemeColor(theme);
  window.dispatchEvent(new Event(EVENT));
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
    </svg>
  );
}

/** One button: switches the whole look (page background, boards, tiles, keys, text) between the pastel themes. */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, readTheme, (): Theme => 'dark');
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => setTheme(next)}
      className="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted transition hover:border-blue-ink/60 hover:text-ink"
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
      data-testid="theme-toggle"
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

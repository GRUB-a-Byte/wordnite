/**
 * The light / dark pastel theme, shared by the pre-paint <head> script (app/layout.tsx) and the
 * toggle (components/ThemeToggle.tsx). Stored in localStorage and applied to <html> as
 * data-theme="light" (dark pastel is the default; it reads better on projectors).
 */
export const THEME_KEY = 'wr:theme';

/**
 * Browser-chrome colour per theme (`<meta name="theme-color">`: the phone status bar, address bar and
 * overscroll area). Must match `--c-night` (the page background) in app/globals.css.
 */
export const THEME_COLOR = { dark: '#1f2c4d', light: '#cce7fa' } as const;
export type Theme = keyof typeof THEME_COLOR;

/**
 * Inline <head> script: re-applies the saved theme before first paint, so no frame shows the
 * wrong one. It also CREATES the theme-color tag. A server-rendered tag could only carry one
 * fixed colour (light mode got dark-navy browser chrome after every reload), and changing a
 * React-rendered tag here would mismatch on hydration. React skips unknown tags in <head>.
 */
export const PREFS_SCRIPT = `(function(){var light=false;try{light=localStorage.getItem('${THEME_KEY}')==='light'}catch(e){}if(light)document.documentElement.dataset.theme='light';var m=document.createElement('meta');m.name='theme-color';m.content=light?'${THEME_COLOR.light}':'${THEME_COLOR.dark}';document.head.appendChild(m)})()`;

/** Points the browser chrome at the theme's page colour (creating the tag if it is missing). */
export function applyThemeColor(theme: Theme): void {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = THEME_COLOR[theme];
}

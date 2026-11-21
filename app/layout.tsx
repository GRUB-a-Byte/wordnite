import type { Metadata, Viewport } from 'next';
import { MotionProvider } from '@/components/MotionProvider';
import { PREFS_SCRIPT } from '@/lib/client/theme';
import './globals.css';

export const metadata: Metadata = {
  title: 'Word Royale — head-to-head word battle',
  description: 'Solve your secret five-letter word before your opponent steals it.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  // No themeColor here: the browser-chrome colour follows the saved theme, so PREFS_SCRIPT sets it.
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Saved light/dark theme, applied before first paint (lib/client/theme.ts). */}
        <script dangerouslySetInnerHTML={{ __html: PREFS_SCRIPT }} />
      </head>
      <body className="font-[family-name:var(--font-display)] antialiased">
        <MotionProvider>{children}</MotionProvider>
      </body>
    </html>
  );
}

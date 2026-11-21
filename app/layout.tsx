import type { Metadata, Viewport } from 'next';
import { MotionProvider } from '@/components/MotionProvider';
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
  themeColor: '#070b18',
};

/** Applies persisted display preferences before paint (colour-blind palette). */
const prefsScript = `try{if(localStorage.getItem('wr:cb')==='1')document.documentElement.dataset.cb='1'}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: prefsScript }} />
      </head>
      <body className="font-[family-name:var(--font-display)] antialiased">
        <MotionProvider>{children}</MotionProvider>
      </body>
    </html>
  );
}

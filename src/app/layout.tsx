import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import 'highlight.js/styles/github-dark-dimmed.min.css';
import './globals.css';

import type { Viewport } from 'next';

export const metadata: Metadata = {
  title: 'Boardroom — DM with Claude Code',
  description: 'A single-user DM chat with Claude Code, bridged via the Claude Agent SDK.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
};

// Theme script: reads from localStorage, sets data-theme on <html>, and
// syncs to a cookie so the server can read it on the next request.
const themeScript = `(function(){try{var t=localStorage.getItem('theme');if(t){document.documentElement.setAttribute('data-theme',t);document.cookie='theme='+t+';path=/;max-age=31536000;SameSite=Lax'}}catch(e){}})()`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const theme = cookieStore.get('theme')?.value || '';

  return (
    <html lang="en" data-theme={theme || undefined} suppressHydrationWarning>
      <head>
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <meta name="theme-color" content="#F5F5F7" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

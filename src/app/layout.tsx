import type { Metadata } from 'next';
// highlight.js theme — dark dimmed works well in both modes since our code
// blocks already have dark backgrounds via --bg-elev-1.
import 'highlight.js/styles/github-dark-dimmed.min.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Boardroom — DM with Claude Code',
  description: 'A single-user DM chat with Claude Code, bridged via the Claude Agent SDK.',
};

// Inline script to apply theme before first paint (prevents flash).
const themeScript = `(function(){var t=localStorage.getItem('theme')||'light';document.documentElement.setAttribute('data-theme',t)})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
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

import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Boardroom — DM with Claude Code',
  description: 'A single-user DM chat with Claude Code, bridged via the Claude Agent SDK.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

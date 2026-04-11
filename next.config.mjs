import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['@anthropic-ai/claude-agent-sdk', 'better-sqlite3'],
  outputFileTracingRoot: __dirname,

  // Strip the X-Powered-By: Next.js header.
  poweredByHeader: false,

  // Security headers on every response.
  async headers() {
    const isDev = process.env.NODE_ENV !== 'production';

    // CSP: tighten for production, relax for dev (Next.js HMR needs eval).
    const scriptSrc = isDev
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline'";

    // WebSocket: allow any host since the terminal WS port differs from
    // the web port and the browser connects by IP/hostname directly.
    const connectSrc = "connect-src 'self' ws://*:* wss://*:*";

    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              scriptSrc,
              "style-src 'self' 'unsafe-inline'",
              connectSrc,
              "img-src 'self' data: blob:",
              "font-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
          // HSTS — only sent when the response will traverse HTTPS. Harmless
          // on plain HTTP (browsers ignore it), and correct when behind a
          // TLS-terminating reverse proxy.
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains',
          },
        ],
      },
    ];
  },
};

export default nextConfig;

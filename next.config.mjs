import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['@anthropic-ai/claude-agent-sdk', 'better-sqlite3'],
  outputFileTracingRoot: __dirname,
  // Standalone output traces only the files/modules actually imported and
  // copies them into .next/standalone. Drops the runtime from ~300MB
  // (full node_modules) to ~30MB (only what Next.js needs).
  output: 'standalone',

  // Strip the X-Powered-By: Next.js header.
  poweredByHeader: false,

  // Security headers on every response.
  async headers() {
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
              // Next.js requires inline scripts + eval for dev; unsafe-inline
              // for production RSC payloads.
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              // Allow connecting to the terminal WebSocket on any port on
              // the same host, plus the SSE stream.
              `connect-src 'self' ws://*:* wss://*:*`,
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

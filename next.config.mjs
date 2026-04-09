import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep server-only native/CLI-spawning deps out of the Webpack bundle so
  // they're required at runtime from node_modules instead.
  serverExternalPackages: ['@anthropic-ai/claude-agent-sdk', 'better-sqlite3'],
  // Pin the workspace root so Next doesn't try to walk up to some unrelated
  // lockfile sitting above the repo.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;

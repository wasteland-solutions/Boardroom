/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['@anthropic-ai/claude-agent-sdk', 'better-sqlite3'],
  experimental: {
    // Prevent turbopack from trying to bundle server-only deps
    turbo: {},
  },
};

export default nextConfig;

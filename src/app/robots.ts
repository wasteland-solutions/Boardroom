import type { MetadataRoute } from 'next';

// Disallow all crawlers — Boardroom is a private self-hosted app.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      disallow: '/',
    },
  };
}

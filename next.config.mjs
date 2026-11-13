/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Every dataset fetch and audio stream happens in the browser, so nothing here
  // needs a serverless function, an image loader, a rewrite or an edge cache
  // rule. The page prerenders to static HTML and Vercel serves it as-is.
  poweredByHeader: false,
  // The floating Next.js dev badge sat on top of the bottom dock's PATH tab on
  // phones. `false` disables the indicator entirely; the object form with
  // `buildActivity` / `appIsrStatus` is deprecated in this Next version and
  // would only earn a warning while doing the same thing.
  devIndicators: false,
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production' ? { exclude: ['error', 'warn'] } : false,
  },
  eslint: {
    dirs: ['src'],
  },
  async headers() {
    return [
      {
        // The curated corpus is immutable for a given deployment (~224 KB
        // gzipped). Let the edge hold it for a year so repeat visits pay nothing.
        source: '/manifest.json',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=0, s-maxage=31536000, stale-while-revalidate=86400',
          },
        ],
      },
      {
        // Pre-generated Persian translations (~204 KB gzipped). Fetched once per
        // page load; the same year-long edge cache keeps repeat visits off the
        // Hobby bandwidth meter. `max-age=0` on the client plus revalidation
        // means a redeploy with fresh translations still reaches everyone.
        source: '/fa.json',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=0, s-maxage=31536000, stale-while-revalidate=86400',
          },
        ],
      },
      {
        // The bundled corpus: ~4,491 WebM/Opus clips (~73 MB total, ~17 KB
        // each). Clip ids never change content, so the whole tree is immutable
        // for a year — a learner downloads each voice at most once in their
        // lifetime, and the edge absorbs every repeat.
        source: '/audio/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ];
  },
};

export default nextConfig;

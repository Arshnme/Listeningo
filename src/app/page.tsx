import AppShell from '@/components/AppShell';

/**
 * The entire product is client-side: audio streams from the Hugging Face CDN
 * directly to the browser and all progress lives in localStorage/IndexedDB.
 * This page therefore prerenders to static HTML with no server work at all,
 * which is ideal for the Vercel Hobby tier.
 */
export default function Page() {
  return <AppShell />;
}

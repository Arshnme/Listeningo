import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';

/**
 * Fonts are vendored as variable woff2 files under `app/fonts` and loaded with
 * `next/font/local`.
 *
 * `next/font/google` fetched them at build time, which made every build —
 * including the Vercel one — depend on Google being reachable and answering in
 * exactly the shape its loader expects; a single flaky response failed the
 * whole build with an opaque `next/font` error. Vendoring removes the
 * build-time network entirely. All three families are open source (OFL);
 * `scripts/fetch-fonts.mjs` re-downloads them if a refresh is ever wanted.
 */

const inter = localFont({
  src: './fonts/inter-variable.woff2',
  weight: '300 800',
  style: 'normal',
  display: 'swap',
  variable: '--font-sans',
});

const geistMono = localFont({
  src: './fonts/geist-mono-variable.woff2',
  weight: '400 600',
  style: 'normal',
  display: 'swap',
  variable: '--font-mono',
});

/**
 * Persian translation surfaces use Vazirmatn, a geometric Farsi face that holds
 * up at small sizes. Latin-only learners should never pay for it: the file is
 * the arabic-subset variable face and it is not preloaded, so it is fetched
 * only when Persian text actually needs to render.
 */
const vazirmatn = localFont({
  src: './fonts/vazirmatn-variable.woff2',
  weight: '400 700',
  style: 'normal',
  display: 'swap',
  variable: '--font-fa',
  preload: false,
});

export const metadata: Metadata = {
  title: 'Listeningo — LibriSpeech Ear Training',
  description:
    'Adaptive English listening practice built on the LibriSpeech dataset. Starts clean, auto-levels to accented and noisy audio as you master it. No login, everything stays in your browser.',
  applicationName: 'Listeningo',
  keywords: ['LibriSpeech', 'listening practice', 'dictation', 'English ear training', 'ASR dataset'],
  authors: [{ name: 'Listeningo' }],
  robots: { index: true, follow: true },
  openGraph: {
    title: 'Listeningo — LibriSpeech Ear Training',
    description:
      'A five-tier adaptive dictation trainer with the whole LibriSpeech corpus bundled locally.',
    type: 'website',
  },
};

export const viewport: Viewport = {
  themeColor: '#030303',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${geistMono.variable} ${vazirmatn.variable}`}
      suppressHydrationWarning
    >
      <body className="relative min-h-dvh font-sans">
        {/* Ambient monochrome bloom, purely decorative.
            The drift animation scales this up, so it is wrapped in a clipped
            fixed layer: a decorative glow must never contribute overflow. */}
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
        >
          <div
            className="absolute inset-x-0 top-0 h-[70vh] animate-ambient-drift opacity-90"
            style={{
              background:
                'radial-gradient(60% 55% at 50% 0%, rgba(255,255,255,0.10), rgba(255,255,255,0.02) 45%, transparent 72%)',
            }}
          />
        </div>
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  );
}

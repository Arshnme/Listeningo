/**
 * Download the app's webfonts into `src/app/fonts/` for `next/font/local`.
 *
 * Why: `next/font/google` fetches from fonts.googleapis.com during the build,
 * which makes every build — local and on Vercel — depend on Google being up and
 * on the response parsing cleanly. One flaky response fails the whole build
 * with an opaque loader error. Vendoring the woff2 files makes builds hermetic
 * and reproducible; the fonts themselves are all open source (Inter and Geist
 * Mono and Vazirmatn are all OFL), so redistribution is fine.
 *
 * What it fetches, matching the previous `next/font/google` configuration
 * exactly: Inter latin 300-800, Geist Mono latin 400-600, Vazirmatn arabic
 * 400-700.
 *
 * Usage:  node scripts/fetch-fonts.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '..', 'src', 'app', 'fonts');

// A modern browser UA makes the css2 endpoint answer with woff2 and include the
// `/* subset */` comments this script keys off.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const JOBS = [
  {
    family: 'Inter',
    query: 'Inter:wght@300;400;500;600;700;800',
    subsets: ['latin'],
    slug: 'inter',
  },
  {
    family: 'Geist Mono',
    query: 'Geist+Mono:wght@400;500;600',
    subsets: ['latin'],
    slug: 'geist-mono',
  },
  {
    family: 'Vazirmatn',
    query: 'Vazirmatn:wght@400;500;600;700',
    subsets: ['arabic'],
    slug: 'vazirmatn',
  },
];

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return response.text();
}

/** Splits a css2 response into { subset, weight, url } blocks. */
function parseBlocks(css) {
  const blocks = [];
  const pattern = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]+)\}/g;
  let match = pattern.exec(css);
  while (match) {
    const subset = match[1];
    const body = match[2] ?? '';
    const weight = (body.match(/font-weight:\s*(\d+)/) ?? [])[1] ?? '';
    const url = (body.match(/url\((https:\/\/[^)]+\.woff2)\)/) ?? [])[1] ?? '';
    const style = (body.match(/font-style:\s*(\w+)/) ?? [])[1] ?? 'normal';
    if (subset && weight && url && style === 'normal') blocks.push({ subset, weight, url });
    match = pattern.exec(css);
  }
  return blocks;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const job of JOBS) {
    const css = await fetchText(
      `https://fonts.googleapis.com/css2?family=${job.query}&display=swap`,
    );
    const blocks = parseBlocks(css).filter((block) => job.subsets.includes(block.subset));
    if (blocks.length === 0) throw new Error(`No ${job.subsets.join(',')} blocks for ${job.family}`);

    // Google serves these families as *variable* fonts: every requested weight
    // points at the same woff2 for a subset. Asserting that makes the vendored
    // layout (one file per family, declared with a weight range) safe — a
    // future response with per-weight files would fail loudly here instead of
    // silently shipping one static weight.
    const urls = [...new Set(blocks.map((block) => block.url))];
    if (urls.length !== 1) {
      throw new Error(`${job.family} is no longer served as a single variable file (${urls.length} urls)`);
    }

    const weights = [...new Set(blocks.map((block) => Number(block.weight)))].sort((a, b) => a - b);
    const file = `${job.slug}-variable.woff2`;
    const bytes = Buffer.from(
      await (await fetch(urls[0], { headers: { 'User-Agent': UA } })).arrayBuffer(),
    );
    fs.writeFileSync(path.join(OUT_DIR, file), bytes);
    console.log(
      `  ${job.family} ${job.subsets.join(',')} ${weights[0]}-${weights[weights.length - 1]} -> ${file} (${(bytes.length / 1024).toFixed(1)} KB)`,
    );
  }

  console.log(`\n[fonts] written to ${OUT_DIR}`);
}

await main();

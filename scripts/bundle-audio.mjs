/**
 * Bundle the curated corpus as local WebM/Opus audio.
 *
 * Why this exists: the app streams from the Hugging Face CDN by default, which
 * means every lesson depends on a third-party service being up, and clip
 * choices are server-resolved. This script compacts the entire shipped corpus
 * (16 kHz FLAC, ~4,491 clips) into `/public/audio/{id}.webm` — mono Opus at
 * 24 kbps, the same configuration the browser-side cache compaction uses — so
 * the whole corpus ships with the deployment, fits inside the 80 MB budget,
 * and every lesson plays genuine LibriSpeech audio with zero network calls.
 *
 * Requirements:
 *   - ffmpeg with libopus. Resolved from FFMPEG_PATH, then the optional
 *     `ffmpeg-static` dev module (npm i --no-save ffmpeg-static), then PATH.
 *   - The LibriSpeech tree: test-clean, dev-clean, test-other, dev-other.
 *     Root from LIBRISPEECH_ROOT (default: the development machine's data dir).
 *
 * Resumable: a clip whose output already exists (> 512 bytes) is skipped, so an
 * interrupted run costs nothing but the files in flight. Run it again after the
 * remaining splits have been extracted and it finishes the rest.
 *
 * Usage:  node scripts/bundle-audio.mjs [--concurrency 6] [--bitrate 24k]
 */

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');
const MANIFEST = path.join(APP_ROOT, 'public', 'manifest.json');
const OUT_DIR = path.join(APP_ROOT, 'public', 'audio');

const DEFAULT_ROOT = 'C:\\Users\\SKYIA\\Documents\\Article\\data\\LibriSpeech';
const LIBRISPEECH_ROOT = process.env.LIBRISPEECH_ROOT || DEFAULT_ROOT;

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const CONCURRENCY = Number(argValue('--concurrency', '6'));
const BITRATE = argValue('--bitrate', '24k');

function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    return require('ffmpeg-static');
  } catch {
    return 'ffmpeg';
  }
}

/**
 * LibriSpeech directory for a clip.
 *
 * `public/manifest.json` deliberately omits `splitLabel` — the client derives it
 * in `validateManifest` — so it is reconstructed here the same way.
 */
function splitLabelFor(clip) {
  if (clip.config === 'clean') return clip.split === 'test' ? 'test-clean' : 'dev-clean';
  return clip.split === 'test' ? 'test-other' : 'dev-other';
}

const ffmpeg = resolveFfmpeg();

function encodeClip(clip) {
  const out = path.join(OUT_DIR, `${clip.id}.webm`);
  if (fs.existsSync(out) && fs.statSync(out).size > 512) return Promise.resolve({ skipped: true, id: clip.id, bytes: fs.statSync(out).size });
  const source = path.join(LIBRISPEECH_ROOT, splitLabelFor(clip), clip.speakerId, clip.chapterId, `${clip.id}.flac`);
  if (!fs.existsSync(source)) return Promise.resolve({ missing: true, id: clip.id });

  return new Promise((resolve) => {
    execFile(
      ffmpeg,
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', source,
        '-ac', '1',
        '-c:a', 'libopus',
        '-b:a', BITRATE,
        '-vbr', 'on',
        '-application', 'audio',
        '-f', 'webm',
        out,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
      (error) => {
        if (error) {
          resolve({ failed: true, id: clip.id, error: error.message.split('\n')[0] });
          return;
        }
        const bytes = fs.existsSync(out) ? fs.statSync(out).size : 0;
        resolve({ id: clip.id, bytes });
      },
    );
  });
}

async function main() {
  const clips = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`[bundle] ${clips.length} clips · ffmpeg: ${ffmpeg} · bitrate ${BITRATE} · concurrency ${CONCURRENCY}`);
  console.log(`[bundle] source root: ${LIBRISPEECH_ROOT}`);

  let next = 0;
  let done = 0;
  let skipped = 0;
  let missing = 0;
  const failures = [];
  const startedAt = Date.now();

  const worker = async () => {
    while (next < clips.length) {
      const index = next;
      next += 1;
      const clip = clips[index];
      const result = await encodeClip(clip);
      if (result.skipped) skipped += 1;
      else if (result.missing) missing += 1;
      else if (result.failed) failures.push(result);
      else done += 1;
      const processed = done + skipped + missing + failures.length;
      if (processed % 200 === 0) {
        const mb = totalBytes() / (1024 * 1024);
        const rate = processed / ((Date.now() - startedAt) / 1000);
        console.log(
          `[bundle] ${processed}/${clips.length} · ${mb.toFixed(1)} MB · ` +
          `${done} encoded, ${skipped} cached, ${missing} missing, ${failures.length} failed · ` +
          `${rate.toFixed(1)}/s`,
        );
      }
    }
  };

  const totalBytes = () => {
    let sum = 0;
    for (const entry of fs.readdirSync(OUT_DIR)) {
      if (entry.endsWith('.webm')) sum += fs.statSync(path.join(OUT_DIR, entry)).size;
    }
    return sum;
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const bytes = totalBytes();
  const files = fs.readdirSync(OUT_DIR).filter((name) => name.endsWith('.webm')).length;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);

  // The generated stats file is what flips the app into bundled mode: the
  // resolution order, the Settings panel and pool growth all read it.
  fs.writeFileSync(
    path.join(APP_ROOT, 'src', 'data', 'audio-bundle.json'),
    `${JSON.stringify({ v: 1, clips: files, bytes, bitrate: BITRATE }, null, 0)}\n`,
  );

  console.log(
    `\n[bundle] finished in ${elapsed}s · ${files} files · ${(bytes / (1024 * 1024)).toFixed(1)} MB ` +
    `(avg ${(bytes / Math.max(1, files) / 1024).toFixed(1)} KB)`,
  );
  if (missing > 0) console.log(`[bundle] ${missing} clips have no local FLAC yet (extract the remaining splits, then re-run).`);
  if (failures.length > 0) {
    console.log(`[bundle] ${failures.length} failures:`);
    for (const failure of failures.slice(0, 10)) console.log(`  ✗ ${failure.id}: ${failure.error}`);
  }
  process.exitCode = failures.length > 0 ? 1 : 0;
}

await main();

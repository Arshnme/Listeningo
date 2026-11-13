/**
 * Runner for the verification suites.
 *
 * jiti executes the TypeScript sources directly, so the assertions exercise the
 * exact modules the app ships; the alias map mirrors the `@/*` path in
 * tsconfig.json.
 *
 * Usage: node scripts/run-verify.cjs   (or `npm test`)
 */

const path = require('node:path');
const createJiti = require('jiti');

const jiti = createJiti(__filename, {
  alias: {
    '@': path.join(__dirname, '..', 'src'),
  },
  interopDefault: true,
  esmResolve: true,
  cache: false,
});

// Each suite reports its own totals and sets a non-zero exit code on failure,
// so one failing suite is enough to fail the run.
jiti('./verify.ts');
jiti('./verify-path.ts');
jiti('./verify-fuzzy.ts');
jiti('./verify-translation.ts');
jiti('./verify-session-length.ts');

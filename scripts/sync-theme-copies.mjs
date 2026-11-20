// scripts/sync-theme-copies.mjs — regenerate shopify-theme/assets/print-calc-*.js
// from js/*.js.
//
// The theme copies may differ from the browser originals only in the ways the
// repo allows (CLAUDE.md): theme import paths, the staging relay URL in config
// (while a draft theme is under test), and the theme's spinner class in main.
// Run scripts/theme-build.mjs afterwards to fix the import hashes:
//
//   node scripts/sync-theme-copies.mjs [--live]
//   node scripts/theme-build.mjs shopify-theme/assets
//
// --live keeps the live relay URL (for the build that gets published).

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const live = process.argv.includes('--live');
const files = ['calculator', 'config', 'main', 'stl-parser', 'pricing-formula'];
const LIVE_LINE = "export const RELAY_BASE_URL = 'https://aqnpkvzycdjwbapfpvfl.supabase.co/functions/v1/shopify-relay';";
const STAGING = `// STAGING BUILD — points at shopify-relay-staging, not the live relay.
// This is the ONE deliberate divergence from js/config.js. It exists so a
// draft theme can exercise server-side price verification without the live
// relay being touched. REVERT THIS TO THE LIVE URL BEFORE PUBLISHING
// (node scripts/sync-theme-copies.mjs --live).
export const RELAY_BASE_URL = 'https://aqnpkvzycdjwbapfpvfl.supabase.co/functions/v1/shopify-relay-staging';`;

for (const f of files) {
  const src = join(root, 'js', `${f}.js`);
  const dst = join(root, 'shopify-theme', 'assets', `print-calc-${f}.js`);
  let s = readFileSync(src, 'utf8');
  const crlf = s.includes('\r\n');
  s = s.replace(/\r\n/g, '\n');
  // './calculator.js?v=16' → './print-calc-calculator.js?v=0000000000' (theme-build fixes the hash)
  s = s.replace(/from '\.\/([a-z-]+)\.js\?v=[^']*'/g, (_, name) => `from './print-calc-${name}.js?v=0000000000'`);
  if (f === 'config' && !live) {
    if (!s.includes(LIVE_LINE)) throw new Error('config: live relay line not found');
    s = s.replace(LIVE_LINE, STAGING);
  }
  if (f === 'main') {
    const spinner = '<div class="part-thumb"><div class="spinner"></div></div>';
    if (s.split(spinner).length !== 2) throw new Error('main: expected exactly one spinner line');
    s = s.replace(spinner, '<div class="part-thumb"><div class="pc-spinner"></div></div>');
  }
  if (crlf) s = s.replace(/\n/g, '\r\n');
  writeFileSync(dst, s);
  console.log(`wrote shopify-theme/assets/print-calc-${f}.js${f === 'config' ? (live ? ' (live relay)' : ' (staging relay)') : ''}`);
}

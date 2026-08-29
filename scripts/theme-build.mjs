// scripts/theme-build.mjs
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const HASHABLE_EXT = new Set(['.js', '.css']);
// Matches: import ... from './print-calc-x.js' or '...js?v=oldhash'
// The old hash suffix is matched as "any non-quote characters" rather than
// strictly [0-9a-f]+ so that a corrupted/non-hex stale value (e.g. a
// hand-edited placeholder) still gets recognized and replaced, not left
// behind as an unmatched tail that breaks the whole specifier.
const IMPORT_RE = /(from\s+['"]\.\/)([\w-]+\.js)(?:\?v=[^'"]*)?(['"])/g;

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) continue;
    if (HASHABLE_EXT.has(path.extname(entry))) out.push(entry);
  }
  return out.sort();
}

function contentHashes(dir, files) {
  const hashes = {};
  for (const file of files) {
    const buf = readFileSync(path.join(dir, file));
    hashes[file] = {
      sha256_10: createHash('sha256').update(buf).digest('hex').slice(0, 10),
      md5: createHash('md5').update(buf).digest('hex'),
    };
  }
  return hashes;
}

/**
 * Rewrites every `./x.js` and `./x.js?v=<oldhash>` import specifier in every
 * .js file under `dir` to carry the current sha256_10 of the imported file,
 * then returns a manifest of every hashable file's hashes. Idempotent: a
 * second run with no source changes rewrites nothing.
 *
 * Rewriting a file changes its own content hash, which matters when that
 * file is *also* imported elsewhere (e.g. main.js imports viewer.js, and
 * viewer.js imports stl-parser.js — rewriting viewer.js's import changes
 * viewer.js's hash, which invalidates the reference main.js just got). A
 * single hash-then-rewrite pass leaves such multi-level chains stale, so
 * this loops to a fixed point: keep re-hashing and rewriting until a full
 * pass makes no further changes, bounded so a circular import can't hang.
 */
export function buildManifest(dir) {
  const files = listFiles(dir);
  const jsFiles = files.filter((file) => file.endsWith('.js'));

  const rewrittenFiles = new Set();
  let changed = true;
  let iterations = 0;
  const maxIterations = jsFiles.length + 1; // generous bound: worst case is one straight import chain, plus a settling pass
  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;
    // Hashes must reflect files as they stand *before* this pass's rewrites,
    // since a file's import lines are excluded from its own content hash.
    const hashes = contentHashes(dir, files);
    for (const file of jsFiles) {
      const full = path.join(dir, file);
      const original = readFileSync(full, 'utf8');
      const updated = original.replace(IMPORT_RE, (match, pre, importedFile, quote) => {
        const target = hashes[importedFile];
        if (!target) return match; // not a theme-local file (e.g. a CDN import) — leave it
        return `${pre}${importedFile}?v=${target.sha256_10}${quote}`;
      });
      if (updated !== original) {
        writeFileSync(full, updated, 'utf8');
        rewrittenFiles.add(file);
        changed = true;
      }
    }
  }
  if (changed) {
    // Only reachable if the import graph has a cycle (a.js imports b.js
    // imports a.js) — content hashes can never stabilize in that case.
    throw new Error(
      `theme-build: import hashes did not converge after ${maxIterations} passes — check for a circular import in ${dir}`
    );
  }

  // Re-hash after rewriting, so the manifest (used for post-upload checksum
  // verification) reflects exactly what will be uploaded.
  const finalHashes = contentHashes(dir, files);
  const manifest = {
    files: finalHashes,
    rewrites: rewrittenFiles.size,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(dir, '.deploy-manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

// CLI entry point
// (process.argv[1] is whatever path Node was invoked with — often relative,
// with platform-native separators — so it must be normalized to a file://
// URL before comparing against import.meta.url; naive string concatenation
// never matches on Windows.)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] || path.join(process.cwd(), 'shopify-theme', 'assets');
  const manifest = buildManifest(dir);
  console.log(`theme-build: ${Object.keys(manifest.files).length} files hashed, ${manifest.rewrites} import(s) rewritten.`);
  console.log(`Manifest: ${path.join(dir, '.deploy-manifest.json')}`);
}

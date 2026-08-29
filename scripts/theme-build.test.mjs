// scripts/theme-build.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildManifest } from './theme-build.mjs';

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'theme-build-'));
  writeFileSync(path.join(dir, 'print-calc-icons.js'), 'export const x = 1;\n');
  writeFileSync(
    path.join(dir, 'print-calc-main.js'),
    "import { x } from './print-calc-icons.js?v=stale00000';\nconsole.log(x);\n"
  );
  return dir;
}

test('rewrites a stale import hash to match the current file content', () => {
  const dir = makeFixture();
  try {
    buildManifest(dir);
    const rewritten = readFileSync(path.join(dir, 'print-calc-main.js'), 'utf8');
    assert.ok(!rewritten.includes('?v=stale00000'), 'stale hash must be replaced');
    assert.match(rewritten, /print-calc-icons\.js\?v=[0-9a-f]{10}'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the same input produces the same hash on a second run (idempotent)', () => {
  const dir = makeFixture();
  try {
    buildManifest(dir);
    const first = readFileSync(path.join(dir, 'print-calc-main.js'), 'utf8');
    buildManifest(dir);
    const second = readFileSync(path.join(dir, 'print-calc-main.js'), 'utf8');
    assert.equal(first, second);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changing the imported file changes the hash in the importer', () => {
  const dir = makeFixture();
  try {
    buildManifest(dir);
    const before = readFileSync(path.join(dir, 'print-calc-main.js'), 'utf8');
    writeFileSync(path.join(dir, 'print-calc-icons.js'), 'export const x = 2;\n'); // content changed
    buildManifest(dir);
    const after = readFileSync(path.join(dir, 'print-calc-main.js'), 'utf8');
    assert.notEqual(before, after);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writes a manifest with sha256_10 and md5 for every .js/.css file', () => {
  const dir = makeFixture();
  try {
    const manifest = buildManifest(dir);
    assert.ok(manifest.files['print-calc-icons.js']);
    assert.match(manifest.files['print-calc-icons.js'].sha256_10, /^[0-9a-f]{10}$/);
    assert.match(manifest.files['print-calc-icons.js'].md5, /^[0-9a-f]{32}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression coverage for the multi-level convergence bug found running
// theme-build.mjs against the real theme assets: a.js imports b.js imports
// c.js. b.js is both an importer (of c.js) and an imported target (of
// a.js), so rewriting b.js's own import line changes b.js's content hash
// *after* a single hash-then-rewrite pass would already have written b.js's
// pre-rewrite hash into a.js. A single pass leaves a.js stale; only a loop
// to a fixed point converges correctly in one buildManifest() call.
function makeChainFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'theme-build-chain-'));
  writeFileSync(path.join(dir, 'c.js'), 'export const c = 1;\n');
  writeFileSync(
    path.join(dir, 'b.js'),
    "import { c } from './c.js?v=stale00000';\nexport const b = c + 1;\n"
  );
  writeFileSync(
    path.join(dir, 'a.js'),
    "import { b } from './b.js?v=stale11111';\nconsole.log(b);\n"
  );
  return dir;
}

test('a 3-level import chain converges in one call: a.js ends up referencing b.js\'s post-rewrite hash', () => {
  const dir = makeChainFixture();
  try {
    const manifest = buildManifest(dir);

    const aContent = readFileSync(path.join(dir, 'a.js'), 'utf8');
    const bMatch = aContent.match(/b\.js\?v=([0-9a-f]{10})/);
    assert.ok(bMatch, 'a.js must reference b.js by hash');

    // The bug this guards against: a single hash-then-rewrite pass would
    // record b.js's *pre-rewrite* hash into a.js, not the hash b.js ends up
    // with after its own import of c.js gets rewritten. Assert a.js's
    // recorded hash for b.js matches b.js's actual final content hash from
    // the manifest, not some stale intermediate value.
    assert.equal(bMatch[1], manifest.files['b.js'].sha256_10);

    // Also confirm b.js's own import of c.js was rewritten to a real hash.
    const bContent = readFileSync(path.join(dir, 'b.js'), 'utf8');
    const cMatch = bContent.match(/c\.js\?v=([0-9a-f]{10})/);
    assert.ok(cMatch, 'b.js must reference c.js by hash');
    assert.equal(cMatch[1], manifest.files['c.js'].sha256_10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changing c.js propagates through b.js to a.js in a single call, and a second call is a no-op', () => {
  const dir = makeChainFixture();
  try {
    buildManifest(dir);
    const bBefore = readFileSync(path.join(dir, 'b.js'), 'utf8');
    const aBefore = readFileSync(path.join(dir, 'a.js'), 'utf8');

    writeFileSync(path.join(dir, 'c.js'), 'export const c = 2;\n'); // leaf content changed
    const manifest = buildManifest(dir);

    const bAfter = readFileSync(path.join(dir, 'b.js'), 'utf8');
    const aAfter = readFileSync(path.join(dir, 'a.js'), 'utf8');
    assert.notEqual(bAfter, bBefore, 'b.js must be rewritten to reference c.js\'s new hash');
    assert.notEqual(aAfter, aBefore, 'a.js must be rewritten to reference b.js\'s new hash, since b.js\'s content changed too');

    const aHashForB = aAfter.match(/b\.js\?v=([0-9a-f]{10})/)[1];
    assert.equal(aHashForB, manifest.files['b.js'].sha256_10);

    // idempotent: a second call with no source changes makes no further edits
    buildManifest(dir);
    const aFinal = readFileSync(path.join(dir, 'a.js'), 'utf8');
    const bFinal = readFileSync(path.join(dir, 'b.js'), 'utf8');
    assert.equal(aFinal, aAfter);
    assert.equal(bFinal, bAfter);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression coverage for the bounded-iteration safety check: two files
// that import each other can never converge (rewriting either one changes
// its content hash, which invalidates the other's just-written reference,
// forever). buildManifest must fail loudly rather than hang or silently
// give up after under-converging.
function makeCircularFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'theme-build-circular-'));
  writeFileSync(
    path.join(dir, 'x.js'),
    "import { y } from './y.js?v=stale00000';\nexport const x = 1;\n"
  );
  writeFileSync(
    path.join(dir, 'y.js'),
    "import { x } from './x.js?v=stale11111';\nexport const y = 2;\n"
  );
  return dir;
}

test('a circular import throws instead of hanging or silently under-converging', () => {
  const dir = makeCircularFixture();
  try {
    assert.throws(() => buildManifest(dir), /converge|circular/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

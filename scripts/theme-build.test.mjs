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

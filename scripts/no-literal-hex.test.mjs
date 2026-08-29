// scripts/no-literal-hex.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('print-calc-style.css has no literal hex colours outside rgba()', () => {
  const css = readFileSync('shopify-theme/assets/print-calc-style.css', 'utf8');
  // Strip rgba(...) calls first — translucency is the one allowed exception.
  const withoutRgba = css.replace(/rgba\([^)]*\)/g, '');
  const hexMatches = withoutRgba.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepEqual(hexMatches, [], `found literal hex outside rgba(): ${hexMatches.join(', ')}`);
});

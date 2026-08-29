// scripts/no-literal-hex.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Every CSS file that must source its colours exclusively from
// brand-tokens.css var(--af-*) tokens (the one allowed exception is
// rgba() for translucency). Add new theme CSS files here as they're built.
const FILES = ['shopify-theme/assets/print-calc-style.css', 'shopify-theme/assets/home-nav.css', 'shopify-theme/assets/home-hero.css', 'shopify-theme/assets/home-base.css', 'shopify-theme/assets/home-marquee.css', 'shopify-theme/assets/home-craft.css'];

function readCssWithoutComments(path) {
  const css = readFileSync(path, 'utf8');
  // Strip CSS comments first so prose mentioning "rgb()" or a hex-looking
  // string (like the ones in this very file's own explanatory comments)
  // can't be mistaken for a literal colour value.
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

for (const path of FILES) {
  test(`${path} has no literal hex colours outside rgba()`, () => {
    const css = readCssWithoutComments(path);
    // Strip rgba(...) calls first — translucency is the one allowed exception.
    const withoutRgba = css.replace(/rgba\([^)]*\)/g, '');
    const hexMatches = withoutRgba.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    assert.deepEqual(hexMatches, [], `found literal hex outside rgba(): ${hexMatches.join(', ')}`);
  });

  test(`${path} has no literal rgb() colour values at use sites (must be a var() token)`, () => {
    const css = readCssWithoutComments(path);
    // A bare rgb(...) (no trailing "a") is a literal colour value sprinkled at
    // a use site, exactly the "hand-hunt every occurrence" problem this file
    // exists to prevent — it must be a custom property (var(--status-*), etc.)
    // instead, even though it isn't hex and wouldn't trip the hex regex above.
    //
    // The one legitimate exception is the top-of-file `:root { --status-*: rgb(...); }`
    // block itself — that's the single definition site these tokens exist to
    // consolidate, so strip it (and rgba() translucency) before checking the
    // rest of the file for stray literals.
    const withoutRootBlock = css.replace(/:root\s*\{[^}]*\}/, '');
    const withoutRgba = withoutRootBlock.replace(/rgba\([^)]*\)/g, '');
    const rgbMatches = withoutRgba.match(/rgb\([^)]*\)/g) || [];
    assert.deepEqual(rgbMatches, [], `found literal rgb() outside var(): ${rgbMatches.join(', ')}`);
  });
}

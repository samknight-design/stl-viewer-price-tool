# Shopify Homepage Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the finalized `option-c.html` homepage design (Arcane Flame brand: ink/flame-teal palette, Cinzel display type, upload-vs-catalogue clarity) onto the live Shopify store, safely enough that a routine content edit afterward can't silently break the site the way three past deploys did.

**Architecture:** Port `option-c.html`'s sections into Dawn-compatible Liquid sections under `shopify-theme/sections/`, each independently addable/reorderable in `templates/index.json` via the theme editor. Before any of that, harden the two things that caused every past outage (per `docs/shopify-integration-runbook.md`): the hand-maintained cache-busting query params on internal JS imports, and the manual, easy-to-skip theme-write verification sequence (processing check → checksum verify). Colours/fonts move to one CSS custom-properties file so a palette tweak can't drift between the calculator and the new homepage sections the way it did between `tokens.json` and `option-c.html` (see `arcane-flame-design-system` memory).

**Tech Stack:** Liquid (Shopify Dawn theme), vanilla CSS/JS (no bundler — matches the existing `shopify-theme/assets/print-calc-*` pattern), Node.js for the local build/verify script (built-ins only, no dependencies), Shopify Admin GraphQL API (via the Shopify MCP connector — there is no local API token, so uploads are driven interactively, not by a standalone script).

## Global Constraints

- **Never write to the live/MAIN theme.** Always duplicate or reuse a checksum-identical non-live theme, then a human publishes. (Runbook §5)
- **Never write while a theme reports `processing: true`.** Poll `theme(id:){ processing }` until `false`.
- **Verify every theme write by `files{ checksumMd5 }` against a local hash — never by reading the file back.**
- **Upload files >~2KB via `body:{ type: URL }` pointed at a commit-pinned raw GitHub URL, never `TEXT`.** Hand-pasting has corrupted files three times.
- **Every internal relative JS import must carry a `?v=<content-hash>` query param**, and that hash must be regenerated whenever the imported file's content changes — this is not optional decoration, it defeats a real CDN caching bug that already shipped once (2026-08-21).
- **No literal hex colour in component/section CSS** — reference `var(--af-*)` custom properties only. `rgba()` for translucency is the one exception (carried over from the design-system's fixed rule).
- **Radius 0, no shadows on UI chrome**, Cinzel 700-only, flame teal (not green) — per `brand.html` in `arcane-flame-design-system`.
- **`js/*.js` and `shopify-theme/assets/print-calc-*.js` must stay near-identical** (import paths + one spinner class is the only allowed diff) — verify with `diff --strip-trailing-cr`.
- Keep the relay's `DEFAULT_MINIMUM_ORDER_TOTAL` / `DEFAULT_CUSTOM_QUOTE_THRESHOLD` mirrored to the client if either changes (unrelated to this plan's scope, but any task touching `js/config.js` must check this).

---

## File Structure

```
shopify-theme/
  assets/
    brand-tokens.css          NEW — CSS custom properties, ported from brand.html's palette/type tables
    print-calc-style.css      MODIFY — replace literal hex with var(--af-*) from brand-tokens.css
    print-calc-*.js           UNCHANGED (import specifiers get their ?v= from the new build script, not hand edits)
    home-nav.css / .js        NEW — header, announcement bar, mobile burger menu
    home-hero.css             NEW — hero section incl. roundel
    home-marquee.css          NEW
    home-craft.css            NEW — detail/craft pins section
    home-services.css         NEW — "Two ways to print" cards, upload badges
    home-footer.css           NEW
  sections/
    print-calculator.liquid   UNCHANGED
    home-nav.liquid           NEW
    home-hero.liquid          NEW
    home-marquee.liquid       NEW
    home-craft.liquid         NEW
    home-services.liquid      NEW
    home-footer.liquid        NEW
  templates/
    index.json                MODIFY — homepage section order
scripts/
  theme-build.mjs              NEW — hashes assets, rewrites import ?v= params, writes deploy manifest
  theme-build.test.mjs         NEW
docs/
  shopify-integration-runbook.md   MODIFY — add §10 "Homepage deploy checklist"
```

Each `home-*.liquid` section is scoped to its own CSS/JS file so a future edit to, say, the hero touches one file pair, not a shared monolith — same "files that change together live together" boundary the calculator assets already use.

---

## Part A — Harden the deploy pipeline (do this before touching homepage content)

### Task 1: Automated import-hash rewriting (`scripts/theme-build.mjs`)

**Files:**
- Create: `scripts/theme-build.mjs`
- Create: `scripts/theme-build.test.mjs`
- Modify: `shopify-theme/assets/print-calc-main.js` (import lines only — hashes will change on first run, that's expected)

**Interfaces:**
- Produces: `buildManifest(themeAssetsDir: string) => { files: { [relPath]: { sha256_10: string, md5: string } }, rewrites: number }`, exported from `scripts/theme-build.mjs`. Later tasks (the deploy checklist in Task 3) read the manifest JSON this writes to `shopify-theme/.deploy-manifest.json`.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/theme-build.test.mjs`
Expected: FAIL — `buildManifest is not a function` (module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```js
// scripts/theme-build.mjs
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const HASHABLE_EXT = new Set(['.js', '.css']);
// Matches: import ... from './print-calc-x.js' or '...js?v=oldhash'
const IMPORT_RE = /(from\s+['"]\.\/)([\w-]+\.js)(?:\?v=[0-9a-f]+)?(['"])/g;

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
 */
export function buildManifest(dir) {
  const files = listFiles(dir);
  // Two passes: content hashes must reflect files *before* any import-line
  // rewrite in this run, since the import lines themselves are excluded
  // from what they reference (a file never hashes its own import of itself).
  const hashes = contentHashes(dir, files);

  let rewrites = 0;
  for (const file of files) {
    if (!file.endsWith('.js')) continue;
    const full = path.join(dir, file);
    const original = readFileSync(full, 'utf8');
    const updated = original.replace(IMPORT_RE, (match, pre, importedFile, quote) => {
      const target = hashes[importedFile];
      if (!target) return match; // not a theme-local file (e.g. a CDN import) — leave it
      return `${pre}${importedFile}?v=${target.sha256_10}${quote}`;
    });
    if (updated !== original) {
      writeFileSync(full, updated, 'utf8');
      rewrites++;
    }
  }

  // Re-hash after rewriting, so the manifest (used for post-upload checksum
  // verification) reflects exactly what will be uploaded.
  const finalHashes = contentHashes(dir, files);
  const manifest = { files: finalHashes, rewrites, generatedAt: new Date().toISOString() };
  writeFileSync(path.join(dir, '.deploy-manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || path.join(process.cwd(), 'shopify-theme', 'assets');
  const manifest = buildManifest(dir);
  console.log(`theme-build: ${Object.keys(manifest.files).length} files hashed, ${manifest.rewrites} import(s) rewritten.`);
  console.log(`Manifest: ${path.join(dir, '.deploy-manifest.json')}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/theme-build.test.mjs`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Run it for real against the actual theme assets and confirm no unexpected rewrites**

```bash
node scripts/theme-build.mjs shopify-theme/assets
git diff shopify-theme/assets/print-calc-main.js
```

Expected: the `?v=` hashes on `print-calc-config.js`, `print-calc-stl-parser.js`, `print-calc-viewer.js`, `print-calc-icons.js` imports may change (they were hand-maintained and may be stale) — read the diff and confirm only the hash suffixes changed, nothing else. If any hash *did* change, that means the shipped `print-calc-main.js` has been silently serving a stale sub-module — flag this to the user before proceeding, it's a live bug fix, not just tooling.

- [ ] **Step 6: Commit**

```bash
git add scripts/theme-build.mjs scripts/theme-build.test.mjs shopify-theme/assets/print-calc-main.js shopify-theme/assets/.deploy-manifest.json
git commit -m "Automate the import-hash cache-busting that was previously hand-maintained

Manually bumping ?v= params on internal imports is exactly the kind of tiny
edit that silently ships a stale sub-module (it already did, 2026-08-21).
theme-build.mjs computes each file's content hash and rewrites every
importer to match, and writes a manifest used to verify uploads by
checksum instead of by reading the file back."
```

---

### Task 2: Design tokens as one file (`brand-tokens.css`)

**Files:**
- Create: `shopify-theme/assets/brand-tokens.css`
- Modify: `shopify-theme/assets/print-calc-style.css` (replace literal hex with `var(--af-*)`)
- Modify: `shopify-theme/sections/print-calculator.liquid` (load `brand-tokens.css` before `print-calc-style.css`)
- Test: `scripts/no-literal-hex.test.mjs`

**Interfaces:**
- Produces: CSS custom properties on `:root`, named `--af-ink-900` … `--af-black`, `--af-font-display` / `--af-font-body` / `--af-font-mono`, matching exactly the token names and values in `arcane-flame-design-system/brand.html`'s colour table. Every later homepage section task (Tasks 4–9) consumes these — do not invent new token names.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/no-literal-hex.test.mjs`
Expected: FAIL — lists the 49 existing literal hex values.

- [ ] **Step 3: Create `brand-tokens.css`**, copying every value from `brand.html`'s colour table (`C:\Users\samkn\Desktop\arcane-flame-design-system\brand.html`) verbatim:

```css
/* shopify-theme/assets/brand-tokens.css
   Single source of truth for colour/type/geometry — ported from
   arcane-flame-design-system/brand.html. Change values there first,
   then copy here; do not let this drift, it's the whole point of this file. */
:root{
  --af-ink-900:#070d14; --af-ink-800:#0d1520; --af-ink-700:#131d2a;
  --af-ink-600:#182433; --af-ink-500:#213040; --af-ink-400:#2e4152;
  --af-flame-700:#084c5f; --af-flame-500:#0a6f88; --af-flame-300:#4fd6ec; --af-flame-200:#a8f0fa;
  --af-rust-500:#a25656; --af-rust-700:#7f2423;
  --af-white:#ffffff; --af-paper:#f3f3f3; --af-black:#121212;
  --af-grey-500:#8a8f98; --af-grey-600:#696d74; --af-grey-300:#d8d8d8;

  --af-font-display:'Cinzel','Trajan Pro',Georgia,serif;
  --af-font-body:'Inter',system-ui,sans-serif;
  --af-font-mono:'IBM Plex Mono',ui-monospace,monospace;

  --af-radius:0;
  --af-ease:cubic-bezier(.22,.61,.36,1);
  --af-maxw:1280px;
}
```

- [ ] **Step 4: Replace every literal hex in `print-calc-style.css`** with the matching `var(--af-*)`. Do this by hand, one value at a time — run `grep -n "#[0-9a-fA-F]\{3,8\}" shopify-theme/assets/print-calc-style.css` after each batch to track remaining count down to zero. Where a colour doesn't map cleanly to an existing token (the calculator predates the flame-teal rebrand and may use different greens/greys), pick the nearest brand token per `brand.html`'s "Use" column rather than inventing a new one — flag any genuinely new use case to the user rather than guessing.

- [ ] **Step 5: Wire `brand-tokens.css` into the section, loaded first**

```liquid
{% comment %} sections/print-calculator.liquid {% endcomment %}
<div class="print-calculator-embed">
  {% render 'print-calculator-markup' %}
</div>

{{ 'brand-tokens.css' | asset_url | stylesheet_tag }}
{{ 'print-calc-style.css' | asset_url | stylesheet_tag }}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test scripts/no-literal-hex.test.mjs`
Expected: PASS.

- [ ] **Step 7: Visual regression check** — this CSS refactor must not change how the calculator looks. Run the calculator locally (`python server.py` or `serve.bat` per the repo's existing dev setup) and screenshot the review screen, upload dropzone, and an expanded part row; compare against a screenshot taken before Step 4. Colours must be pixel-identical (same hex values, just referenced via variable now).

- [ ] **Step 8: Commit**

```bash
git add shopify-theme/assets/brand-tokens.css shopify-theme/assets/print-calc-style.css shopify-theme/sections/print-calculator.liquid scripts/no-literal-hex.test.mjs
git commit -m "Move brand colours into one tokens file, referenced by var(), not copied

print-calc-style.css had 49 literal hex values with no link back to
arcane-flame-design-system/brand.html. A future palette tweak (like the
ink-scale refinement that already happened once between tokens.json and
option-c.html) would need hand-hunting every occurrence. brand-tokens.css
is now the one file to edit."
```

---

### Task 3: Deploy checklist for the new asset set (documentation, no code)

**Files:**
- Modify: `docs/shopify-integration-runbook.md` (append §10)

**Interfaces:**
- Consumes: `shopify-theme/assets/.deploy-manifest.json` from Task 1.

- [ ] **Step 1: Append the checklist**

```markdown
## 10. Homepage deploy checklist (2026-08-29+)

Before uploading any `shopify-theme/` change:

1. `node scripts/theme-build.mjs shopify-theme/assets` — regenerates import
   hashes and `.deploy-manifest.json`. Commit the result if anything changed.
2. `node --test scripts/theme-build.test.mjs scripts/no-literal-hex.test.mjs`
   — both must pass.
3. Push to `worktree-shopify-integration` (or the active feature branch) and
   note the commit SHA.
4. Find or create a non-live theme: check `config/settings_data.json`,
   templates, layout and section checksums against the live theme first — if
   a previously-duplicated theme is still checksum-identical, reuse it
   (saves the 20–30 min duplication wait). Confirm `theme(id:){ processing }`
   is `false` before writing.
5. Upload every changed file via `themeFilesUpsert` with
   `body:{ type: URL, url: "https://raw.githubusercontent.com/samknight-design/stl-viewer-price-tool/<sha>/shopify-theme/<path>" }`.
   Never `TEXT` for anything over ~2KB.
6. Verify: re-query `files{ checksumMd5 }` for every uploaded file and diff
   against `.deploy-manifest.json`'s `md5` field (assets) or a fresh local
   `md5sum` (liquid/json files, which aren't in the JS/CSS manifest). Any
   mismatch — stop, do not tell the user it's deployed.
7. Load the theme preview (`?preview_theme_id=<id>`), confirm the
   `server-timing` `theme;desc` header matches, and visually check the
   changed section against `option-c.html` rendered locally.
8. Only then: tell the user it's ready, and that publishing is their step.
9. **After they publish**, clear any `preview_theme_id` cookie in your own
   testing browser — it pins you to the old preview and will make a
   published change look like it didn't take.
```

- [ ] **Step 2: Commit**

```bash
git add docs/shopify-integration-runbook.md
git commit -m "Document the homepage-era deploy checklist, tied to the new manifest"
```

---

## Part B — Port the homepage, one section at a time

Each task below is independently deployable and previewable — ship and verify one before starting the next, using the Part A checklist every time. Source content is copied from `Arcane Flame Website Prototype/option-c.html`, which already holds the approved, screenshot-verified markup/CSS (line numbers below are as of the version with the roundel and upload-badge fixes applied this session — re-check line numbers if the file has moved since).

For each section task, "verify" means: open the section in the Shopify theme-editor preview, screenshot it, and compare side-by-side against the equivalent region of `option-c.html` served locally (`python -m http.server` in that folder, as done earlier this session) — same layout, same copy, same colours via `var(--af-*)`, no literal hex reintroduced (extend `scripts/no-literal-hex.test.mjs`'s file list to cover each new CSS file as it's created).

### Task 4: Header, announcement bar, nav (`home-nav.liquid`)
**Files:** Create `shopify-theme/sections/home-nav.liquid`, `shopify-theme/assets/home-nav.css`, `shopify-theme/assets/home-nav.js` (burger menu toggle only — no pricing logic, keep it out of `print-calc-*`).
**Source:** `option-c.html` CSS lines 76–96 (`.site-head` … `.burger`) and body lines 402–433 (`<header class="site-head">` block). Replace the static nav links with Liquid `{% for link in section.settings.menu.links %}` bound to a `link_list` setting, so nav items are merchant-editable without a code deploy — this is itself a "doesn't break with a tiny edit" win, since adding a nav item currently would otherwise require a theme file upload.
**Schema:** expose `menu` (link_list) and `announcement_text` (richtext) as section settings.
**Definition of done:** section renders fixed header, scroll-solid transition (`.nav.solid` class toggle in `home-nav.js`), and mobile burger reveals the same links.

### Task 5: Hero with roundel (`home-hero.liquid`)
**Files:** Create `shopify-theme/sections/home-hero.liquid`, `shopify-theme/assets/home-hero.css`.
**Source:** CSS lines 106–176 (`.hero` … roundel block) and body lines 436–475 (hero markup through the roundel `<div class="roundel">`).
**Schema:** `heading`, `subheading`, `lede` (richtext), two CTA buttons (text + url each), hero image (`image_picker`), roundel image (`image_picker`) and roundel caption text — so the roundel photo can be swapped (e.g. seasonally) without a deploy.
**Definition of done:** hero renders with float/glow animation, roundel photo badge visible and legible at desktop and mobile widths (reuse the viewport checks already run this session: 1440×900 and 375×812).

### Task 6: Shared base stylesheet (`home-base.css`) — inserted after Tasks 4–5 surfaced the gap

**Why this task exists:** Tasks 4 and 5 (nav, hero) both independently discovered that `option-c.html`'s type/button/layout classes — `.wrap`, `.display`, `.eyebrow`, `.lede`, `.btn`/`.btn--primary`/`.btn--ghost`/`.btn--dark`, `.sec`/`.sec--light`/`.sec--mid` — live in one shared global block near the top of the prototype's stylesheet, not scoped to any one section. Both tasks correctly declined to duplicate a private copy into their own section CSS and flagged it instead. Every remaining homepage section (marquee, craft, services, footer) uses these same classes, so this must land before Task 7 (renumbered marquee) or the same gap recurs a third and fourth time with no guarantee of a consistent fix.

**Files:**
- Create `shopify-theme/assets/home-base.css`
- Modify `shopify-theme/sections/home-nav.liquid` — add `{{ 'home-base.css' | asset_url | stylesheet_tag }}` (loaded after `brand-tokens.css`, before `home-nav.css`)
- Modify `shopify-theme/sections/home-hero.liquid` — same addition

**Source:** `Arcane Flame Website Prototype/option-c.html` — locate by content, not by the line numbers below (they're approximate and this file has shifted since earlier tasks read it): the base reset (`*{margin:0;padding:0;box-sizing:border-box;min-width:0}`), `html`/`body` base rules, `.wrap`, the `/* ---------- type ---------- */` block (`.display`, `.eyebrow`, `.lede` and their `.on-light` variants), and the `/* ---------- buttons ---------- */` block (`.btn`, `.btn--primary`, `.btn--primary:hover`, `.btn--ghost`, `.btn--ghost:hover`, `.btn--dark`, `.btn--dark:hover`, `.btn .arw`). Also port the `/* ---------- generic section ---------- */` block (`.sec`, `.sec--light`, `.sec--mid`, `.sec__head`) since Tasks 8 and 9 (craft, services) both use it. Every colour via `var(--af-*)` from `brand-tokens.css`, same rule as every prior task.

**Definition of done:**
- `home-base.css` contains exactly these shared classes and nothing section-specific (no `.hero__*`, `.nav__*`, etc. — those stay in their own files).
- Re-run Task 4 and Task 5's verification harnesses with `home-base.css` now linked: nav links and hero heading/eyebrow/lede/buttons render in the correct typography and button styling (Cinzel display font, correct button gradients/borders) instead of unstyled browser defaults — this is the actual proof the gap is closed, not just that the file exists.
- Add `shopify-theme/assets/home-base.css` to `scripts/no-literal-hex.test.mjs`'s `FILES` array; all files in that array still pass.

### Task 7: Marquee (`home-marquee.liquid`)
**Files:** Create `shopify-theme/sections/home-marquee.liquid`, `shopify-theme/assets/home-marquee.css`.
**Source:** locate `.marquee`/`.marquee__track`/`@keyframes slide` and the `<div class="marquee">` block by content (search, don't trust old line numbers — they've already drifted once this session).
**Schema:** repeatable `block` type `marquee_item` (text field) so the scrolling claims list is merchant-editable.
**Definition of done:** track scrolls continuously via the existing `@keyframes slide`, no visible seam at the loop point (test with the item list at both the current 8 items and with 3, to make sure `width:max-content` doesn't break the seamless loop at low item counts — this was not tested in the prototype).

### Task 8: Craft/detail section (`home-craft.liquid`)
**Files:** Create `shopify-theme/sections/home-craft.liquid`, `shopify-theme/assets/home-craft.css`.
**Source:** locate the `.craft`/`.craft__fig`/`.craft__ring`/`.pin*`/`.spec` block and the `<section class="sec" id="detail">` body markup by content.
**Schema:** image, heading, body richtext, spec `dt`/`dd` pairs as a repeatable block, and the 3 hotspot pins as a repeatable block (`left`/`top` percent fields + label text) so pins can be repositioned without editing CSS.
**Definition of done:** hover/tap reveals each pin label; spec grid renders with `--af-font-mono` figures; loads `home-base.css` for `.sec`/`.eyebrow`/`.lede` (do not redefine them locally).

### Task 9: Services / "Two ways to print" (`home-services.liquid`) — carries this session's upload-clarity fix
**Files:** Create `shopify-theme/sections/home-services.liquid`, `shopify-theme/assets/home-services.css`.
**Source:** locate the `.svc*` block (including this session's `.svc__frame` / `.svc__badge` additions) and the `<section class="sec sec--mid" id="services">` body markup (including the "Uploaded STL / not a stock model" badge and dashed drop-frame) by content.
**Schema:** two repeatable `service_card` blocks — eyebrow, heading, body, image, tag list (repeatable sub-field), CTA link/text. **Do not let a merchant edit away the upload badge or the sub-heading clarifying line** — hardcode those two elements in the section Liquid rather than exposing them as removable settings, since this task exists specifically to fix a "looks like a catalogue" confusion the user flagged twice; a well-meaning content edit shouldn't be able to silently reintroduce it.
**Definition of done:** both cards show the solid flame badge with the upload-cloud icon and dashed frame, CTAs read "Upload for a [material] quote →", and the sub-heading under "Pick your material" is present. Loads `home-base.css` for `.sec--mid`/`.eyebrow` (do not redefine locally).

### Task 10: Footer + final CTA (`home-footer.liquid`)
**Files:** Create `shopify-theme/sections/home-footer.liquid`, `shopify-theme/assets/home-footer.css`.
**Source:** whatever final/footer CSS and body markup follows the services section in `option-c.html` (read the file's remaining content — it wasn't fully reviewed during planning — before writing this task's section, since the exact classes aren't yet confirmed).
**Definition of done:** matches the prototype visually; all footer links resolve to real Shopify page/policy URLs, not `#`.

### Task 11: Calculator marketing teaser (`home-calc-teaser.liquid`) — inserted after Task 10 found unplanned sections

**Why this task exists:** Reading past the services section (needed to scope Task 10's footer) surfaced four more full sections in `option-c.html` between "Two ways to print" and the footer that this plan never accounted for. This is the first of three added to cover them; a fourth (Reviews) is deliberately built with placeholder copy per the user's explicit call — see Task 14.

**Files:** Create `shopify-theme/sections/home-calc-teaser.liquid`, `shopify-theme/assets/home-calc-teaser.css`.
**Source:** locate `<section class="sec" id="calculator">` and its CSS (`.calc`, `.steps`, `.ui`, `.ui__bar`, `.ui__body`, `.drop`, `.frow`, `.total` — search by class name, don't trust old line numbers).
**Schema:** heading, lede (richtext), a repeatable `step` block (number, title, description — 3 by default, matching the source's 01/02/03), CTA text/url. The fake browser-chrome mockup (file rows with names/prices, the drop-zone) is decorative marketing content illustrating the real tool — hardcode it as static example content (not merchant-editable settings), same reasoning as Task 9's badge: this is illustrative UI chrome, not real data, and letting a merchant "edit" fake prices into something that reads as a real quote would be worse than leaving it fixed.
**Definition of done:** matches the prototype visually; the CTA links to the actual calculator page (`{{ pages.3d-print-calculator.url }}` — confirm this Shopify page handle against `docs/shopify-integration-runbook.md` §2, which lists `https://www.arcane-flame.com/pages/3d-print-calculator` as the calculator page), not the prototype's `#calculator` anchor (there's no matching on-page anchor once this becomes its own homepage section — the button should navigate to the real tool).

### Task 12: Shop product grid (`home-shop-grid.liquid`) — pulls real Shopify products, per user decision 2026-08-30

**User's explicit call:** the prototype hardcodes 4 fictional products with fake prices. The user decided this must pull real Shopify products, not ship illustrative fake pricing on a live commerce page.

**Files:** Create `shopify-theme/sections/home-shop-grid.liquid`, `shopify-theme/assets/home-shop-grid.css`.
**Source:** locate `<section class="sec sec--mid" id="shop">`, `.pgrid`, `.pcard`, `.pcard__img`, `.pcard__tag`, `.pcard__body`, `.attrib*` (the DM Stash licensing attribution block — keep its wording exact, this is a legally-reviewed line per this project's conventions, same rule Task 10 already applied to the footer's DM Stash line).
**Schema:** a `collection` setting (Shopify `collection` picker type) and a `products_to_show` range/number setting (default 4, matching the source). Render via `{% for product in section.settings.collection.products limit: section.settings.products_to_show %}`, pulling `product.featured_image`, `product.title`, and `product.price | money` (Shopify's real price, formatted through the store's money format — not a hardcoded "From £X.00" string). Guard the whole grid with `{% if section.settings.collection %}...{% else %}` and a clear empty-state message for when no collection is assigned yet (a fresh section placement will have this unset).
**Definition of done:** with no collection assigned, the section shows a clear "select a collection" empty state rather than a broken/empty grid; with a collection assigned, product cards show real titles/images/prices from that collection, not the prototype's fictional ones. The attribution block and its wording are hardcoded (not editable), same rule as Task 9.

### Task 13: Spend & Save discount ladder (`home-spend-save.liquid`)

**Files:** Create `shopify-theme/sections/home-spend-save.liquid`, `shopify-theme/assets/home-spend-save.css`.
**Source:** locate the `.ladder`, `.rung`, `.rung__pct`, `.rung__bar`, `.shipflag` CSS and the `<section class="sec sec--light">` containing them (the one with eyebrow "Spend more, save more").
**Schema:** a repeatable `rung` block (percent number, spend-threshold text, bar-width percent — matching the source's `--w:25%/50%/75%/100%`), free-shipping threshold text, terms disclaimer text. This section is purely illustrative marketing copy in the prototype (not wired to `print_calculator.pricing_config`, which drives actual checkout discounts) — port it as static/editable marketing content, do not attempt to wire it to the live pricing config in this task; flag in the report if the displayed percentages/thresholds don't match the actual configured discount tiers, since that would be a real content-accuracy issue worth a human decision, not something to silently reconcile or silently ignore.
**Definition of done:** matches the prototype visually; bar-width custom properties render correctly per rung.

### Task 14: Reviews section (`home-reviews.liquid`) — static placeholder content, per user decision 2026-08-30

**User's explicit call:** keep this as static placeholder content for now — do not integrate the reviews app currently installed on the live theme, since the user may replace that app. This is a deliberate, temporary placeholder, not a content gap to silently fill with invented copy.

**Files:** Create `shopify-theme/sections/home-reviews.liquid`, `shopify-theme/assets/home-reviews.css`.
**Source:** locate `.rev`, `.rcard`, `.stars` CSS and the `<section class="sec">` containing them (eyebrow "What players say").
**Schema:** a repeatable `review` block (star rating as a number/range setting, quote as richtext, attribution text). Ship the section with its current 3 blocks as defaults, **preserving the source's exact placeholder wording verbatim, including the literal words "Placeholder review copy — swap for a real one"** — do not invent real-sounding testimonial copy to replace it. The point is that this must be obviously fake to whoever next edits it, not quietly plausible.
**Definition of done:** matches the prototype visually; a code comment at the top of the liquid file states clearly that this section ships with placeholder content pending either real testimonials or a reviews-app integration decision.

### Task 15: Assemble `templates/index.json` and cut over
**Files:** Modify `shopify-theme/templates/index.json`.
**Steps:**
- [ ] Add each section from Tasks 4–14 in order, with default settings populated from `option-c.html`'s current copy.
- [ ] Run the full Part A deploy checklist once for the complete set.
- [ ] Smoke test the four order paths from the runbook (§9.6: under £5, normal, multi-model, over £150) against the preview theme — the homepage changes shouldn't touch checkout, but this is the existing regression suite and costs little to re-run before a homepage-scale publish.
- [ ] Ask the user to publish, then verify the live `server-timing` header matches and clear the preview cookie.

---

## Self-Review

**Spec coverage:** Every visual element the user has approved so far (nav, hero+roundel, marquee, craft, services w/ upload badges) has a task. Footer content wasn't reviewed this session (Task 9 says so explicitly rather than guessing at it). The deploy-fragility complaint ("doesn't break with a tiny edit") is addressed structurally by Part A, not bolted on — Tasks 1–2 remove the two specific historical failure modes (stale cache-bust hash, colour drift), Task 3 closes the human-checklist gap, and Task 8 hardcodes the upload-clarity fix so content edits can't undo it.

**Placeholder scan:** No TBD/TODO in Part A (fully coded, real tests). Part B tasks name exact source line ranges and exact new file paths rather than "similar to X" — Task 9 is the one exception, and it says explicitly *why* it can't be more specific yet (unread portion of the source file) rather than guessing.

**Type/name consistency:** `buildManifest` signature and manifest shape (Task 1) match how Task 3's checklist reads `.deploy-manifest.json`. Token names (`--af-ink-900` etc.) are defined once in Task 2 and every Part B task is told to consume them, not invent new ones.

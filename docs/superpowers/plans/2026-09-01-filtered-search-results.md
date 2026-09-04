# Filtered Search Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Prefixbox app block on the collection page with Dawn's own native, tag-driven filter sidebar, styled to match the Arcane Flame brand, so any collection (the full catalog or a focused ad/SEO landing page) gets a working "filter by scale/race/class/weapon/etc." sidebar with zero future code changes as new tag values appear.

**Architecture:** Add one new Shopify colour scheme (`scheme-6`, the brand's dark palette) so Dawn's own facets/collection/card CSS — which is already written entirely in terms of `--color-foreground`/`--color-background` — renders correctly with almost no custom CSS. Swap `templates/collection.json` to use Dawn's native `main-collection-banner` + `main-collection-product-grid` sections (currently present but disabled) instead of the Prefixbox `apps` block, set to the new scheme and `filter_type: vertical`. A small brand CSS file covers the handful of things the colour scheme doesn't reach (fonts, and the card component's colour, which is driven by a separate global `card_color_scheme` setting we deliberately don't touch sitewide).

**Tech Stack:** Shopify Liquid, theme `config/settings_data.json` (colour scheme data), Shopify Admin GraphQL API for deploy.

## Global Constraints

- Every colour/font/spacing value in new CSS must be a `var(--af-*)` token from `brand-tokens.css` — no literal hex, except the documented `rgba()` translucency exception. (`config/settings_data.json` itself is Shopify's own hex-based colour scheme format, not CSS — the no-literal-hex rule applies to `.css` files, not this JSON.)
- Deploy pipeline: commit → push to `worktree-shopify-integration` → `themeFilesUpsert` on theme `gid://shopify/OnlineStoreTheme/197825855832` (the "Product templates (mini/terrain)" preview theme already used for the product-template work — **not** the stale `174291517784` theme from earlier in this session, and not the live `197703434584` theme directly) → verify every file's `checksumMd5` against `git show <sha>:<path> | md5sum`.
- Do not modify `snippets/facets.liquid`, `sections/main-collection-product-grid.liquid`, `sections/main-collection-banner.liquid`, `snippets/card-product.liquid`, or any other Dawn-owned file — none of those files are in this repo and all must stay untouched on the live theme.
- Do not change the global `card_color_scheme` setting (currently `scheme-2`) — it's used by cards on other pages (homepage complementary products, elsewhere) outside this feature's scope. Card colouring on the collection page is done with scoped CSS instead.
- Prefixbox stays untouched on the site's top search bar. This plan only removes its `apps` block from `templates/collection.json`.
- No em dashes in any copy this plan touches (there is none — this plan adds no new customer-facing text, only structural/style changes).

---

### Task 1: Add the brand dark colour scheme

**Files:**
- Modify: `shopify-theme/config/settings_data.json`

**Interfaces:**
- Produces: a new colour scheme id `"scheme-6"` in the `current.color_schemes` object, consumed by Task 2's `templates/collection.json` (`"color_scheme": "scheme-6"` on both sections).

- [ ] **Step 1: Fetch the current live file exactly**

Query the live theme (`gid://shopify/OnlineStoreTheme/197703434584`) for `config/settings_data.json` via `graphql_query` and save its `current.color_schemes` object exactly as returned — the five existing schemes (`scheme-1` through `scheme-5`) must not change in any way. Only a new `scheme-6` key is added alongside them.

- [ ] **Step 2: Add `scheme-6`**

Insert this object into `current.color_schemes`, after `"scheme-5"`:

```json
"scheme-6": {
  "settings": {
    "background": "#070d14",
    "background_gradient": "",
    "text": "#ffffff",
    "button": "#0a6f88",
    "button_label": "#ffffff",
    "secondary_button_label": "#ffffff",
    "shadow": "#070d14"
  }
}
```

These values are `--af-ink-900` (background), `--af-white` (text), `--af-flame-500` (button — the same hex Shopify's own `scheme-5` already uses for its background, so it's a value already proven to exist in the live theme's colour picker), `--af-white` (button label), `--af-white` (secondary button label), `--af-ink-900` (shadow).

- [ ] **Step 3: Write the full modified file**

Take the exact JSON fetched in Step 1, add `scheme-6` as shown, and save the complete file (still valid JSON, still containing the auto-generated-file header comment Shopify writes at the top — copy that verbatim from the fetched content, don't invent it) to `shopify-theme/config/settings_data.json` in this repo.

- [ ] **Step 4: Validate JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('shopify-theme/config/settings_data.json','utf8').replace(/\/\*[\s\S]*?\*\//,'')); console.log('valid json')"
```

(The leading `/* ... */` comment block is stripped before parsing since it isn't valid JSON on its own — Shopify's own file has this same structure.)

- [ ] **Step 5: Commit**

```bash
git add shopify-theme/config/settings_data.json
git commit -m "feat: add scheme-6 brand dark colour scheme

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Swap `templates/collection.json` to Dawn's native filtering

**Files:**
- Modify: `shopify-theme/templates/collection.json`

**Interfaces:**
- Consumes: `scheme-6` from Task 1.
- Consumes: Dawn's native `main-collection-banner` and `main-collection-product-grid` section types (already exist on the live theme, confirmed present and currently `"disabled": true`).

- [ ] **Step 1: Fetch the current live file exactly**

Query the live theme for `templates/collection.json` and note its current structure: three sections (`banner`, `product-grid`, and an `apps` block hosting the Prefixbox `prefixbox-category` block), in that `order`.

- [ ] **Step 2: Write the replacement file**

```json
{
  "sections": {
    "banner": {
      "type": "main-collection-banner",
      "settings": {
        "show_collection_description": true,
        "show_collection_image": false,
        "color_scheme": "scheme-6"
      }
    },
    "product-grid": {
      "type": "main-collection-product-grid",
      "settings": {
        "products_per_page": 16,
        "columns_desktop": 4,
        "color_scheme": "scheme-6",
        "image_ratio": "adapt",
        "image_shape": "default",
        "show_secondary_image": false,
        "show_vendor": false,
        "show_rating": false,
        "quick_add": "none",
        "enable_filtering": true,
        "filter_type": "vertical",
        "enable_sorting": true,
        "columns_mobile": "2",
        "padding_top": 36,
        "padding_bottom": 36
      }
    }
  },
  "order": ["banner", "product-grid"]
}
```

This drops the `apps` block entirely (removing Prefixbox from this page only) and removes `"disabled": true` from both remaining sections so they actually render. `filter_type: "vertical"` is Dawn's sidebar-filter layout — the "side" filter system asked for.

- [ ] **Step 3: Validate JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('shopify-theme/templates/collection.json','utf8')); console.log('valid json')"
```

- [ ] **Step 4: Commit**

```bash
git add shopify-theme/templates/collection.json
git commit -m "feat: replace Prefixbox collection block with Dawn's native filter sidebar

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Brand CSS for typography and card colouring

**Files:**
- Create: `shopify-theme/assets/collection-brand-override.css`
- Create: `shopify-theme/sections/collection-brand-hook.liquid`
- Modify: `shopify-theme/templates/collection.json` (add the `brand-hook` section from Task 2's version)
- Modify: `scripts/no-literal-hex.test.mjs` (register the new CSS file, if not already listed)

This task does not touch `shopify-theme/sections/product-mini-details.liquid` or any other product-template file — this is a new, separate stylesheet with no relation to the product templates.

Since this stylesheet has no natural section of its own to be linked from (Dawn's `main-collection-banner.liquid` and `main-collection-product-grid.liquid` are not in this repo and must not be modified), it needs a tiny loader section, following the exact pattern already used for `product-terrain-hook.liquid`.

- [ ] **Step 1: Write the loader section**

```liquid
{% comment %}
  Loads collection-brand-override.css on collection pages, which have no
  other custom section to carry that stylesheet reference. Renders no
  visible markup. Same pattern as product-terrain-hook.liquid.
{% endcomment %}

{{ 'brand-tokens.css' | asset_url | stylesheet_tag }}
{{ 'collection-brand-override.css' | asset_url | stylesheet_tag }}

{% schema %}
{
  "name": "Collection brand CSS hook",
  "tag": "div",
  "settings": []
}
{% endschema %}
```

Save as `shopify-theme/sections/collection-brand-hook.liquid`.

- [ ] **Step 2: Add it to the template**

Edit `shopify-theme/templates/collection.json` (from Task 2) to add a third section:

```json
    "brand-hook": {
      "type": "collection-brand-hook"
    }
```

and update `"order"` to `["banner", "product-grid", "brand-hook"]`.

- [ ] **Step 3: Write the CSS**

```css
/* shopify-theme/assets/collection-brand-override.css

   Most of this page's colouring comes from scheme-6 (config/settings_data.json,
   Task 1), which Dawn's own collection/facets/card CSS already derives
   correctly from --color-foreground/--color-background - see
   assets/component-facets.css and assets/component-card.css, both entirely
   scheme-variable-driven with no compound-class specificity fight like the
   one product-brand-override.css had to work around on <product-info>.

   This file covers only what the colour scheme can't: typography, and the
   card component's own colour, which is controlled by a *global*
   card_color_scheme setting (currently scheme-2, used by cards elsewhere
   on the site) that this feature deliberately does not change - so cards
   are re-skinned here instead, scoped to .product-grid-container only. */

.collection-hero__title {
  font-family: var(--af-font-display);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .04em;
}

.collection-hero__description {
  font-family: var(--af-font-body);
  color: var(--af-grey-500);
}

.facets__heading,
.facets__summary,
.facet-filters__label,
.product-count__text {
  font-family: var(--af-font-body);
}

/* ---------- card re-skin, scoped to this page only ---------- */
.product-grid-container .card--card,
.product-grid-container .card--standard .card__inner {
  background: var(--af-ink-800) !important;
  border-color: rgba(255, 255, 255, .1) !important;
}
.product-grid-container .card__inner.color-scheme-1 {
  background: transparent !important;
}
.product-grid-container .card__heading {
  font-family: var(--af-font-body);
  color: var(--af-white) !important;
}
.product-grid-container .card-information > * {
  color: var(--af-grey-500) !important;
}
.product-grid-container .card-information > .price {
  font-family: var(--af-font-mono);
  color: var(--af-flame-300) !important;
}
```

The `!important` uses follow the same rule established on the product page: they only appear where Dawn's own rule reads `rgb(var(--color-foreground))`/`rgba(var(--color-shadow),...)` from the *global* `card_color_scheme` (scheme-2, light) rather than from this page's own `scheme-6`, since cards intentionally don't inherit the section's colour scheme in Dawn's architecture.

- [ ] **Step 4: Run the hex-literal test**

```bash
node scripts/no-literal-hex.test.mjs
```

If `collection-brand-override.css` isn't in the script's `FILES` list yet, add it there (same one-line addition pattern used for every prior new CSS file in this project).

- [ ] **Step 5: Commit**

```bash
git add shopify-theme/sections/collection-brand-hook.liquid shopify-theme/assets/collection-brand-override.css shopify-theme/templates/collection.json scripts/no-literal-hex.test.mjs
git commit -m "feat: brand CSS for the collection/filter page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Deploy and verify

**Files:** none created — deployment of files from Tasks 1-3.

- [ ] **Step 1: Push the branch**

```bash
git push origin worktree-shopify-integration
```

- [ ] **Step 2: Upload all 4 files via `themeFilesUpsert`**

Target theme: `gid://shopify/OnlineStoreTheme/197825855832`. For each file, `body: { type: URL, value: "https://raw.githubusercontent.com/<owner>/<repo>/<commit-sha>/<path>" }` with `<commit-sha>` being the HEAD of `worktree-shopify-integration` after Task 3's commit:
- `shopify-theme/config/settings_data.json`
- `shopify-theme/templates/collection.json`
- `shopify-theme/sections/collection-brand-hook.liquid`
- `shopify-theme/assets/collection-brand-override.css`

- [ ] **Step 3: Verify checksums**

Compare each returned `checksumMd5` against `git show <sha>:<path> | md5sum`. `templates/collection.json` may come back with a different checksum after Shopify's own auto-reformatting (as seen with the product templates) — if so, re-fetch the live content and confirm it's semantically identical before treating it as verified, rather than assuming a mismatch is an error.

- [ ] **Step 4: Verify live in the browser**

Open `https://<store-domain>/collections/dm-stash-ttrpg-miniatures?preview_theme_id=197825855832` (a real, already-populated collection) in the Browser pane. Confirm: dark `scheme-6` background on both the collection banner and product grid, product cards render with the dark re-skin (not Dawn's default light `scheme-2` card look), the filter sidebar appears on the left with `enable_filtering`/`enable_sorting` both present, no console errors, and — since this collection's products don't yet carry any `category:value` tags (per the spec, retagging the catalog is a separate future task) — the filter sidebar may legitimately show no filter groups yet, which is expected and not a bug to chase.

- [ ] **Step 5: Record in the ledger**

Append an entry to `.superpowers/sdd/progress.md` noting the collection page is live on the preview theme, verified, with the commit SHAs from Tasks 1-3, and noting explicitly that filter groups won't appear until products carry `category:value` tags and the Search & Discovery admin filter configuration (out of scope per the spec) is done.

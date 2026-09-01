# Product Page Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two branded Shopify product page templates (`product.mini`, `product.terrain`) covering every DM Stash resin/PLA product shape, on the unpublished "Arcane Flame Brand Theme".

**Architecture:** Reuse Dawn's native `main-product` section (its block system, `product-form`/`variant-selects`/`quantity-input` custom elements, and AJAX cart JS) rather than rewriting cart/variant behaviour — re-skin it with a brand CSS override targeting its real class names. Add one new custom section (`product-mini-details`) for lore/stat-block/assembly-explainer/trio-links content that Dawn has no equivalent for. Terrain products use `main-product` alone. New DM-Stash-style data (Race, Class, Miniature Type, Tabletop Size, lore, trio grouping) lives in six product metafields.

**Tech Stack:** Shopify Liquid, Shopify Admin GraphQL API (metafield definitions), the theme's existing `brand-tokens.css` design tokens.

## Global Constraints

- Every colour/font/spacing value must come from `brand-tokens.css` (`var(--af-*)`) — no literal hex, matching the existing `scripts/no-literal-hex.test.mjs` convention. The one documented exception is `rgba()` translucency with no token equivalent.
- All copy in code comments and any placeholder/test-product copy must avoid em dashes, per the voice rules in `C:\Users\samkn\Desktop\arcane-flame-design-system\brand.html`.
- Deploy pipeline: commit → push to `worktree-shopify-integration` → `themeFilesUpsert` on theme `gid://shopify/OnlineStoreTheme/174291517784` ("Arcane Flame Brand Theme", UNPUBLISHED) with `body:{type:URL, value: raw.githubusercontent.com/<owner>/<repo>/<commit-sha>/<path>}` → verify every file's `checksumMd5` against `git show <sha>:<path> | md5sum` (never against local working-tree md5sum, due to CRLF conversion on Windows checkout).
- Every new/modified `.liquid` or `.css` file must set its own stacking context (`position:relative;z-index:0`) if it introduces absolutely-positioned decorative elements — see `home-base.css`'s documented `:empty{display:none}` and stacking-context gotchas before adding any empty decorative `<div>`.
- Do not modify `sections/main-product.liquid` or any other Dawn-owned file — it is not in this repo and must stay untouched on the live theme. All branding happens via a new, additive CSS file.
- Metafield namespace is `custom` for all six new fields (matches Shopify's default reserved namespace for merchant-defined fields with no app).

---

### Task 1: Create the six product metafield definitions

**Files:** none (Shopify Admin API only — no repo files)

**Interfaces:**
- Produces: six live metafield definitions on the `PRODUCT` owner type, keys `custom.race`, `custom.class`, `custom.miniature_type`, `custom.tabletop_size`, `custom.lore`, `custom.trio_group`. Task 4 (product-mini-details section) reads these via `product.metafields.custom.<key>`.

- [ ] **Step 1: Validate the six mutations**

Use the `validate_graphql_codeblocks` tool on this block before running anything:

```graphql
mutation CreateRaceDefinition {
  metafieldDefinitionCreate(definition: {
    name: "Race"
    namespace: "custom"
    key: "race"
    description: "Comma-separated race(s) shown in the mini's stat block, e.g. \"Drow, Elf\"."
    type: "single_line_text_field"
    ownerType: PRODUCT
  }) {
    createdDefinition { id namespace key }
    userErrors { field message code }
  }
}

mutation CreateClassDefinition {
  metafieldDefinitionCreate(definition: {
    name: "Class"
    namespace: "custom"
    key: "class"
    description: "Comma-separated class(es) shown in the mini's stat block, e.g. \"Fighter, Ranger, Rogue\"."
    type: "single_line_text_field"
    ownerType: PRODUCT
  }) {
    createdDefinition { id namespace key }
    userErrors { field message code }
  }
}

mutation CreateMiniatureTypeDefinition {
  metafieldDefinitionCreate(definition: {
    name: "Miniature Type"
    namespace: "custom"
    key: "miniature_type"
    description: "e.g. NPC, Monster, PC. Shown in the mini's stat block."
    type: "single_line_text_field"
    ownerType: PRODUCT
  }) {
    createdDefinition { id namespace key }
    userErrors { field message code }
  }
}

mutation CreateTabletopSizeDefinition {
  metafieldDefinitionCreate(definition: {
    name: "Tabletop Size"
    namespace: "custom"
    key: "tabletop_size"
    description: "D&D size category (Small/Medium/Large/Huge) - distinct from the mm scale variant option."
    type: "single_line_text_field"
    ownerType: PRODUCT
  }) {
    createdDefinition { id namespace key }
    userErrors { field message code }
  }
}

mutation CreateLoreDefinition {
  metafieldDefinitionCreate(definition: {
    name: "Lore"
    namespace: "custom"
    key: "lore"
    description: "Flavour/lore paragraph, separate from the main practical/SEO product description."
    type: "rich_text_field"
    ownerType: PRODUCT
  }) {
    createdDefinition { id namespace key }
    userErrors { field message code }
  }
}

mutation CreateTrioGroupDefinition {
  metafieldDefinitionCreate(definition: {
    name: "Trio Group"
    namespace: "custom"
    key: "trio_group"
    description: "Free-text key shared by trio sibling products and their full-set product, used to cross-link them."
    type: "single_line_text_field"
    ownerType: PRODUCT
  }) {
    createdDefinition { id namespace key }
    userErrors { field message code }
  }
}
```

- [ ] **Step 2: Run each mutation** via `graphql_mutation`, one at a time. For each, confirm `userErrors` is empty and note the returned `id`.

- [ ] **Step 3: Verify all six exist**

```graphql
query VerifyDefinitions {
  metafieldDefinitions(first: 20, ownerType: PRODUCT, namespace: "custom") {
    nodes { name namespace key type { name } }
  }
}
```

Expected: 6 nodes with keys `race`, `class`, `miniature_type`, `tabletop_size`, `lore`, `trio_group`.

No commit for this task (no repo files changed).

---

### Task 2: Brand override CSS for Dawn's native product section

**Files:**
- Create: `shopify-theme/assets/product-brand-override.css`

**Interfaces:**
- Consumes: `var(--af-*)` tokens from `brand-tokens.css` (already deployed; loaded by every section that needs it via `{{ 'brand-tokens.css' | asset_url | stylesheet_tag }}`).
- Produces: none consumed by later tasks — this file is linked directly from both new templates via `main-product` section block settings is not possible (Dawn's section doesn't accept a custom CSS parameter), so it must instead be linked from the **product-mini-details** section (Task 4) and, for terrain-only pages with no other custom section, from a tiny wrapper. See Step 5.

This file re-skins Dawn's existing `main-product` markup (fetched and confirmed against the live "Arcane Flame Brand Theme" — see class names below) without touching Dawn's own files.

- [ ] **Step 1: Write the CSS**

```css
/* shopify-theme/assets/product-brand-override.css

   Re-skins Dawn's native `main-product` section (sections/main-product.liquid,
   snippets/price.liquid, snippets/buy-buttons.liquid,
   snippets/product-variant-picker.liquid — all Dawn-owned, not in this repo,
   confirmed live on theme gid://shopify/OnlineStoreTheme/174291517784) to
   match the Arcane Flame brand, without touching Dawn's own files or its
   cart/variant JavaScript (product-form.js, product-info.js).

   Loaded by product-mini-details.liquid and product-terrain-hook.liquid
   (see those files) rather than by main-product.liquid itself, since Dawn's
   section has no slot for a custom stylesheet reference.

   Every value is a var(--af-*) token from brand-tokens.css. No literal hex.

   product-info's background/color use !important: Dawn applies its own
   background via a `.gradient.color-scheme-N` compound class on the same
   element (see sections/main-product.liquid), which at (0,2,0) beats this
   rule's plain-element (0,0,1) specificity. Found live: without !important
   the product page rendered with Dawn's white scheme background instead of
   ours, despite this CSS loading correctly and the --af-* tokens resolving. */

product-info {
  font-family: var(--af-font-body);
  color: var(--af-white) !important;
  background: var(--af-ink-900) !important;
  display: block;
}

product-info .product__title h1,
product-info .product__title h2.h1 {
  font-family: var(--af-font-display);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .04em;
  color: var(--af-white);
}

product-info .product__title a.product__title {
  text-decoration: none;
}

product-info .product__description.rte {
  font-family: var(--af-font-body);
  color: var(--af-grey-500);
  line-height: 1.6;
}

/* ---------- price (snippets/price.liquid classes) ---------- */
product-info .price {
  font-family: var(--af-font-mono);
  color: var(--af-white);
}
product-info .price .price-item--regular {
  color: var(--af-white);
}
product-info .price.price--on-sale .price-item--sale {
  color: var(--af-flame-300);
}
product-info .price s.price-item--regular {
  color: var(--af-grey-600);
}
product-info .badge.price__badge-sale {
  background: var(--af-flame-500);
  color: var(--af-white);
  border-radius: var(--af-radius);
}

/* ---------- variant picker (snippets/product-variant-picker.liquid) ---------- */
product-info variant-selects fieldset.product-form__input {
  border: none;
  margin: 0 0 20px;
}
product-info variant-selects .form__label {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .16em;
  text-transform: uppercase;
  color: var(--af-flame-300);
}
/* pill-style buttons (block.settings.picker_type == 'button', Dawn's default) */
product-info variant-selects .product-form__input--pill input[type="radio"] + label {
  font-family: var(--af-font-body);
  border: 1px solid rgba(255, 255, 255, .32);
  background: transparent;
  color: var(--af-white);
  border-radius: var(--af-radius);
  transition: .18s var(--af-ease);
}
product-info variant-selects .product-form__input--pill input[type="radio"]:checked + label {
  border-color: var(--af-flame-500);
  background: var(--af-flame-700);
  color: var(--af-white);
}
product-info .select .select__select {
  font-family: var(--af-font-body);
  background: var(--af-ink-800);
  color: var(--af-white);
  border: 1px solid rgba(255, 255, 255, .32);
  border-radius: var(--af-radius);
}

/* ---------- buy buttons (snippets/buy-buttons.liquid) ---------- */
product-info product-form .product-form__submit.button.button--primary {
  font-family: var(--af-font-body);
  font-weight: 600;
  letter-spacing: .09em;
  text-transform: uppercase;
  background: linear-gradient(135deg, var(--af-flame-700) 0%, var(--af-flame-500) 100%);
  color: var(--af-white);
  border: 1px solid var(--af-flame-500);
  border-radius: var(--af-radius);
  transition: .18s var(--af-ease);
}
product-info product-form .product-form__submit.button.button--primary:hover {
  background: linear-gradient(135deg, var(--af-flame-300) 0%, var(--af-flame-200) 100%);
  border-color: var(--af-flame-200);
  color: var(--af-ink-900);
}
product-info product-form .product-form__submit.button:disabled {
  background: var(--af-ink-500);
  border-color: var(--af-ink-500);
  color: var(--af-grey-600);
}

/* ---------- quantity selector ---------- */
product-info quantity-input {
  border: 1px solid rgba(255, 255, 255, .32);
  border-radius: var(--af-radius);
}
product-info .quantity__button {
  color: var(--af-white);
  background: transparent;
}
product-info .quantity__input {
  font-family: var(--af-font-mono);
  background: var(--af-ink-900);
  color: var(--af-white);
}
```

- [ ] **Step 2: Commit**

```bash
git add shopify-theme/assets/product-brand-override.css
git commit -m "feat: brand override CSS for Dawn's native product section"
```

---

### Task 3: `product-mini-details` section (lore, stat block, assembly explainer, trio links)

**Files:**
- Create: `shopify-theme/sections/product-mini-details.liquid`
- Create: `shopify-theme/assets/product-mini-details.css`

**Interfaces:**
- Consumes: `brand-tokens.css`, `home-base.css` (`.wrap`, `.sec`, `.sec--mid`, `.display`, `.eyebrow`), `product-brand-override.css` (Task 2) — all loaded by this section's own `{% stylesheet %}` links since it's the first section on the page.
- Consumes metafields from Task 1: `product.metafields.custom.race`, `.class`, `.miniature_type`, `.tabletop_size`, `.lore`, `.trio_group`.
- Produces: nothing consumed by later tasks in this plan — this is a leaf section referenced only by `templates/product.mini.json` (Task 5).

- [ ] **Step 1: Write the section**

```liquid
{% comment %}
  Lore, DM-Stash-style stat block, assembly/primer explainer, and trio
  cross-links for mini/bust products. Not used on terrain products - see
  templates/product.terrain.json, which uses main-product alone.

  Every field is optional: a blank metafield simply doesn't render its row.
  The assembly explainer only renders if this product literally has a
  variant option named "Assembly" (case-insensitive) - trio and bust
  products typically won't.
{% endcomment %}

{{ 'brand-tokens.css' | asset_url | stylesheet_tag }}
{{ 'home-base.css' | asset_url | stylesheet_tag }}
{{ 'product-brand-override.css' | asset_url | stylesheet_tag }}
{{ 'product-mini-details.css' | asset_url | stylesheet_tag }}

{%- liquid
  assign has_lore = false
  if product.metafields.custom.lore != blank
    assign has_lore = true
  endif

  assign stat_rows = ''
  assign stat_fields = 'race,class,miniature_type,tabletop_size' | split: ','

  assign has_assembly_option = false
  for option in product.options
    assign option_lower = option | downcase
    if option_lower == 'assembly'
      assign has_assembly_option = true
    endif
  endfor

  assign trio_group = product.metafields.custom.trio_group.value
  assign trio_siblings = ''
-%}

<section class="sec sec--mid pmini">
  <div class="wrap pmini__grid">

    {%- if has_lore -%}
      <div class="pmini__lore">
        <p class="eyebrow">Lore</p>
        {{ product.metafields.custom.lore | metafield_tag }}
      </div>
    {%- endif -%}

    {%- assign race = product.metafields.custom.race.value -%}
    {%- assign class_field = product.metafields.custom.class.value -%}
    {%- assign miniature_type = product.metafields.custom.miniature_type.value -%}
    {%- assign tabletop_size = product.metafields.custom.tabletop_size.value -%}

    {%- if race != blank or class_field != blank or miniature_type != blank or tabletop_size != blank -%}
      <table class="pmini__stats">
        <tbody>
          {%- if class_field != blank -%}
            <tr><th>Class</th><td>{{ class_field }}</td></tr>
          {%- endif -%}
          {%- if miniature_type != blank -%}
            <tr><th>Miniature Type</th><td>{{ miniature_type }}</td></tr>
          {%- endif -%}
          {%- if race != blank -%}
            <tr><th>Race</th><td>{{ race }}</td></tr>
          {%- endif -%}
          {%- if tabletop_size != blank -%}
            <tr><th>Tabletop Size</th><td>{{ tabletop_size }}</td></tr>
          {%- endif -%}
        </tbody>
      </table>
    {%- endif -%}

    {%- if has_assembly_option -%}
      <div class="pmini__assembly">
        <p class="eyebrow">Assembly &amp; finish</p>
        <ul class="pmini__assembly-list">
          <li><strong>In parts &amp; unprimed:</strong> arrives unassembled, bare resin, ready for your own build and paint.</li>
          <li><strong>Assembled &amp; unprimed:</strong> arrives glued together, bare resin, ready to prime and paint.</li>
          <li><strong>Assembled &amp; primed:</strong> arrives glued and primed in your choice of White, Grey, or Black, ready to paint straight away.</li>
        </ul>
      </div>
    {%- endif -%}

    {%- if trio_group != blank -%}
      {%- comment -%}
        Liquid's `where` filter does not reliably support a dotted
        metafield path as a string property accessor, and `concat`
        requires an array argument (not a single product), so this
        collects matching handles as a comma string and looks each one up
        via the `all_products[handle]` global instead. Bounded to the
        first 250 products in the catalog (Liquid's for-loop default/max
        limit), which comfortably covers this store's DM Stash catalog.
      {%- endcomment -%}
      {%- assign sibling_handles = '' -%}
      {%- for candidate in collections.all.products limit: 250 -%}
        {%- if candidate.metafields.custom.trio_group.value == trio_group and candidate.handle != product.handle -%}
          {%- assign sibling_handles = sibling_handles | append: candidate.handle | append: ',' -%}
        {%- endif -%}
      {%- endfor -%}
      {%- assign sibling_handle_list = sibling_handles | split: ',' -%}
      {%- if sibling_handle_list.size > 0 -%}
        <div class="pmini__trio">
          <p class="eyebrow">Part of this release</p>
          <ul class="pmini__trio-list">
            {%- for handle in sibling_handle_list -%}
              {%- assign sibling = all_products[handle] -%}
              <li>
                <a href="{{ sibling.url }}">
                  {%- if sibling.featured_media -%}
                    <img
                      src="{{ sibling.featured_media | image_url: width: 200 }}"
                      alt="{{ sibling.featured_media.alt | escape }}"
                      width="100"
                      height="100"
                      loading="lazy"
                    >
                  {%- endif -%}
                  <span>{{ sibling.title }}</span>
                </a>
              </li>
            {%- endfor -%}
          </ul>
        </div>
      {%- endif -%}
    {%- endif -%}

  </div>
</section>

{% schema %}
{
  "name": "Mini details (lore/stats)",
  "tag": "section",
  "settings": []
}
{% endschema %}
```

- [ ] **Step 2: Write the CSS**

```css
/* shopify-theme/assets/product-mini-details.css
   Styles for sections/product-mini-details.liquid. Every colour/font is a
   var(--af-*) token from brand-tokens.css - no literal hex. */

.pmini { position: relative; z-index: 0; }
.pmini__grid {
  display: grid;
  gap: 40px;
}
.pmini__lore p:not(.eyebrow) {
  font-family: var(--af-font-body);
  color: var(--af-grey-500);
  line-height: 1.7;
  max-width: 68ch;
  margin-top: 12px;
}
.pmini__stats {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--af-font-body);
}
.pmini__stats th,
.pmini__stats td {
  text-align: left;
  padding: 14px 18px;
  border-bottom: 1px solid rgba(255, 255, 255, .12);
}
.pmini__stats th {
  color: var(--af-flame-300);
  font-weight: 600;
  width: 40%;
}
.pmini__stats td {
  color: var(--af-white);
}
.pmini__assembly-list {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  display: grid;
  gap: 10px;
}
.pmini__assembly-list li {
  font-family: var(--af-font-body);
  color: var(--af-grey-500);
  line-height: 1.6;
}
.pmini__assembly-list strong {
  color: var(--af-white);
}
.pmini__trio-list {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}
.pmini__trio-list a {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--af-white);
  text-decoration: none;
  border: 1px solid rgba(255, 255, 255, .2);
  border-radius: var(--af-radius);
  padding: 8px 14px;
  transition: .18s var(--af-ease);
}
.pmini__trio-list a:hover {
  border-color: var(--af-flame-300);
  color: var(--af-flame-300);
}
.pmini__trio-list img {
  border-radius: var(--af-radius);
  object-fit: cover;
}
```

- [ ] **Step 3: Commit**

```bash
git add shopify-theme/sections/product-mini-details.liquid shopify-theme/assets/product-mini-details.css
git commit -m "feat: add product-mini-details section for lore/stat-block/assembly/trio content"
```

---

### Task 4: `product-terrain-hook` section (loads brand override CSS for terrain pages)

**Files:**
- Create: `shopify-theme/sections/product-terrain-hook.liquid`

**Interfaces:**
- Consumes: `product-brand-override.css` (Task 2), `brand-tokens.css`.
- Produces: nothing consumed by later tasks — referenced only by `templates/product.terrain.json` (Task 6).

Terrain pages have no lore/stat-block content, but `main-product.liquid` still needs `product-brand-override.css` linked from somewhere on the page. This tiny section renders nothing visible; it exists solely to attach that stylesheet, same pattern as every homepage section attaching its own CSS.

- [ ] **Step 1: Write the section**

```liquid
{% comment %}
  Loads product-brand-override.css for terrain/dice-tower product pages,
  which have no other custom section to carry that stylesheet reference.
  Renders no visible markup. See product-mini-details.liquid for the
  equivalent on mini/bust pages.
{% endcomment %}

{{ 'brand-tokens.css' | asset_url | stylesheet_tag }}
{{ 'product-brand-override.css' | asset_url | stylesheet_tag }}

{% schema %}
{
  "name": "Terrain brand CSS hook",
  "tag": "div",
  "settings": []
}
{% endschema %}
```

- [ ] **Step 2: Commit**

```bash
git add shopify-theme/sections/product-terrain-hook.liquid
git commit -m "feat: add product-terrain-hook section to load brand CSS on terrain pages"
```

---

### Task 5: `templates/product.mini.json`

**Files:**
- Create: `shopify-theme/templates/product.mini.json`

**Interfaces:**
- Consumes: Dawn's native `main-product` section type (blocks: `title`, `price`, `variant_picker`, `quantity_selector`, `buy_buttons`, `description`) and `product-mini-details` (Task 3), by section type name — both already exist (Dawn's on the live theme, ours from Task 3).

- [ ] **Step 1: Write the template**

```json
{
  "sections": {
    "main": {
      "type": "main-product",
      "blocks": {
        "title": { "type": "title" },
        "price": { "type": "price" },
        "variant_picker": {
          "type": "variant_picker",
          "settings": { "picker_type": "button", "swatch_shape": "none" }
        },
        "quantity_selector": { "type": "quantity_selector" },
        "buy_buttons": {
          "type": "buy_buttons",
          "settings": { "show_dynamic_checkout": true, "show_gift_card_recipient": true }
        },
        "description": { "type": "description" }
      },
      "block_order": [
        "title",
        "price",
        "variant_picker",
        "quantity_selector",
        "buy_buttons",
        "description"
      ],
      "settings": {
        "media_size": "large",
        "media_position": "left",
        "gallery_layout": "stacked",
        "mobile_thumbnails": "show",
        "enable_sticky_info": true,
        "image_zoom": "lightbox",
        "padding_top": 36,
        "padding_bottom": 20
      }
    },
    "mini-details": {
      "type": "product-mini-details"
    }
  },
  "order": ["main", "mini-details"]
}
```

- [ ] **Step 2: Commit**

```bash
git add shopify-theme/templates/product.mini.json
git commit -m "feat: add product.mini template"
```

---

### Task 6: `templates/product.terrain.json`

**Files:**
- Create: `shopify-theme/templates/product.terrain.json`

**Interfaces:**
- Consumes: Dawn's native `main-product` section and `product-terrain-hook` (Task 4).

- [ ] **Step 1: Write the template**

```json
{
  "sections": {
    "main": {
      "type": "main-product",
      "blocks": {
        "title": { "type": "title" },
        "price": { "type": "price" },
        "variant_picker": {
          "type": "variant_picker",
          "settings": { "picker_type": "button", "swatch_shape": "none" }
        },
        "quantity_selector": { "type": "quantity_selector" },
        "buy_buttons": {
          "type": "buy_buttons",
          "settings": { "show_dynamic_checkout": true, "show_gift_card_recipient": true }
        },
        "description": { "type": "description" }
      },
      "block_order": [
        "title",
        "price",
        "variant_picker",
        "quantity_selector",
        "buy_buttons",
        "description"
      ],
      "settings": {
        "media_size": "large",
        "media_position": "left",
        "gallery_layout": "stacked",
        "mobile_thumbnails": "show",
        "enable_sticky_info": true,
        "image_zoom": "lightbox",
        "padding_top": 36,
        "padding_bottom": 20
      }
    },
    "terrain-hook": {
      "type": "product-terrain-hook"
    }
  },
  "order": ["main", "terrain-hook"]
}
```

- [ ] **Step 2: Commit**

```bash
git add shopify-theme/templates/product.terrain.json
git commit -m "feat: add product.terrain template"
```

---

### Task 7: Deploy and verify on the preview theme

**Files:** none created — deployment of files from Tasks 2-6.

**Interfaces:**
- Consumes: every file from Tasks 2-6, plus their git commit SHAs.

- [ ] **Step 1: Push the branch**

```bash
git push origin worktree-shopify-integration
```

- [ ] **Step 2: Upload all 6 files via `themeFilesUpsert`**

Target theme: `gid://shopify/OnlineStoreTheme/174291517784`. For each file, use `body: { type: URL, value: "https://raw.githubusercontent.com/<owner>/<repo>/<commit-sha>/<path>" }` with `<commit-sha>` being the HEAD of `worktree-shopify-integration` after Task 6's commit. Files:
- `shopify-theme/assets/product-brand-override.css`
- `shopify-theme/sections/product-mini-details.liquid`
- `shopify-theme/assets/product-mini-details.css`
- `shopify-theme/sections/product-terrain-hook.liquid`
- `shopify-theme/templates/product.mini.json`
- `shopify-theme/templates/product.terrain.json`

- [ ] **Step 3: Verify checksums**

For each uploaded file, compare the `checksumMd5` returned by a `theme(id:) { files(filenames:) { checksumMd5 } }` query against `git show <sha>:<path> | md5sum` (not local working-tree md5sum — CRLF conversion on Windows checkout gives a false mismatch there).

- [ ] **Step 4: Create two real test products**

Using `create-product` / `update-product` tools against the same store:
1. **Test mini** — template suffix `mini`, with variant options Scale (32mm/75mm), Version (Standard/Alternate), Assembly (In parts & unprimed/Assembled & unprimed/Assembled & primed), Primer Colour (White/Grey/Black), and metafields `custom.race`, `custom.class`, `custom.miniature_type`, `custom.tabletop_size`, `custom.lore` all set to short placeholder values (no em dashes).
2. **Test terrain** — template suffix `terrain`, with a single Size or no variant option, no metafields set.

To set the `template_suffix`, use `productUpdate` (GraphQL) with `templateSuffix: "mini"` or `"terrain"` — validate the mutation with `validate_graphql_codeblocks` before running it.

- [ ] **Step 5: Verify live in the browser**

Open each test product's preview URL (theme preview link, not the live store — this theme is UNPUBLISHED) in the Browser pane. Confirm: brand fonts/colours applied to title/price/variant buttons/add-to-cart button; stat block renders only the fields that were set; assembly explainer appears on the mini (which has an Assembly option) and would not on a product without one; terrain page shows no stat block or lore section; changing variant options updates price/selection with no console errors (`read_console_messages`).

- [ ] **Step 6: Record in the ledger**

Append a short entry to `.superpowers/sdd/progress.md` (or create it if this is the first task run outside subagent-driven-development) noting both templates are live on the preview theme and verified, with the commit SHAs from Tasks 2-6.

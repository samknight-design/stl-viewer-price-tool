# Filtered search results & landing pages — design

## Context

Arcane Flame's product catalog is growing (65 products in "DM Stash TTRPG
Miniatures", 39 in "Fantasy TTRPG Miniatures", more to come, including
future 40k-style ranges). The current category/search page uses a
third-party app called **Prefixbox** (visible as an `apps` block in
`templates/collection.json`, and the source of a z-index bug fixed earlier
in the homepage build), which has no side filter sidebar and isn't
brand-restylable in any practical way.

The user wants two things, which turn out to be the same underlying
mechanism used two ways:

1. A results page where every product can be filtered by whatever
   attributes exist — scale, race, class, weapon, gender, and anything
   added later (new 40k weapon types, etc.) — without needing template
   changes when new filter values appear.
2. The ability to spin up a focused, pre-filtered landing page (e.g. "just
   dragons", "just dice towers") for ad campaigns or SEO, quickly and
   without engineering involvement each time.

## Decision: Dawn's native filtering, not Prefixbox, not a custom build

Dawn already ships a complete filter sidebar system (`sections/main-
collection-product-grid.liquid` + `snippets/facets.liquid`), currently
present in the theme but **disabled** in `templates/collection.json` in
favour of the Prefixbox app block. It renders `results.filters` — a list
Shopify itself derives from each collection's product tags (and metafields,
if configured), based on the store's Search & Discovery filter settings in
Shopify Admin.

This is a better fit than either alternative:
- **vs. Prefixbox**: Dawn's version is theme-native Liquid/CSS, fully
  restylable with the same `!important`-override pattern already used on
  product pages; Prefixbox is a hosted third-party widget with no such
  access.
- **vs. a custom-built filter UI**: Dawn's version already does everything
  asked for — tag-driven, adds new filter values automatically as new tags
  appear on products, mobile drawer included — for zero new application
  code. Building a custom equivalent would duplicate working functionality
  for no benefit.

Prefixbox stays exactly as it is on the site's top search bar (unrelated,
untouched by this work) — only the category/collection page's filtering
mechanism changes.

## Tagging convention: `category:value`

Every filterable attribute becomes a product tag in `category:value` form,
e.g. `race:elf`, `class:fighter`, `weapon:sword`, `scale:32mm`,
`gender:female`. Shopify's Search & Discovery filter settings group tags by
their prefix into named sidebar sections ("Race", "Weapon", "Scale", ...)
automatically. This is a merchant workflow decision, not a template
decision: adding a new tag value to a product (e.g. `weapon:bolter` on a
new 40k range) makes it appear as a new filter checkbox the next time that
tag exists on any product in the collection — no code change, ever.

**One manual prerequisite this spec cannot complete by API**: the specific
tags exposed as filters (and their grouping) are configured in Shopify
Admin under Settings → Search & Discovery → Filters. This is an admin-UI
task the user (or a future session with UI access) must do once to select
which `category:` prefixes become filter sections. This spec assumes that
configuration exists; it is out of scope for the implementation plan, which
only covers template/CSS work.

## Page structure

Replace `templates/collection.json`'s current setup:
- Remove the Prefixbox `apps` block.
- Enable `main-collection-banner` (title only, no image — matches the
  brand's dark/minimal aesthetic) and `main-collection-product-grid`
  (currently `"disabled": true` on both).
- Set `filter_type: "vertical"` on the product grid section — this is
  Dawn's sidebar layout (as opposed to `horizontal` pills-above-grid or
  `drawer` mobile-style-everywhere), matching "a filter system on the
  side."
- Re-skin both sections' output with a new `assets/collection-brand-
  override.css`, following the exact pattern established in `assets/
  product-brand-override.css`: target Dawn's real class names
  (`.facets-container`, `.facets__summary`, `.facet-checkbox`, `.active-
  facets__button`, `.product-grid`, `card-product`'s classes, the mobile
  `.mobile-facets__*` drawer), using `!important` only where Dawn's own
  rules use scheme-based CSS variables (`--color-foreground`, `--color-
  background`) that don't track our dark theme, exactly as required twice
  already on the product page.
- Card styling reuses `snippets/card-product.liquid` (Dawn's existing
  product card, already used elsewhere on the site) — no changes to that
  snippet, only its CSS.

## Landing pages = ordinary Shopify Collections

No new template, no new code path. A "just dragons" landing page is a
normal Shopify **automated collection** (Admin → Collections → new
collection → condition: tag contains `race:dragon`) using the same
`collection` template this spec restyles. It automatically gets:
- its own URL (`/collections/dragons` or similar, editable per collection)
- its own SEO title and meta description field in the collection editor
- the same styled, brand-consistent filter sidebar, pre-scoped to just
  that collection's matching products
- further filterable within that already-narrowed set (e.g. a "dragons"
  landing page can still be filtered by scale/weapon/etc.)

Creating a new landing page for a new ad campaign is therefore a two-minute
Admin task, not an engineering request — directly satisfying "I need this
for focused search result ads... without needing new tags to require code
changes."

## Out of scope

- Configuring which tags become filters in Shopify Admin's Search &
  Discovery settings (manual prerequisite, not implementable by this
  plan).
- Creating any specific landing-page collections (e.g. an actual "dragons"
  collection) — the mechanism is built; specific collections are a
  merchant task whenever a campaign needs one.
- Any change to Prefixbox's behaviour on the site's top search bar.
- Retagging the existing catalog with the new `category:value` convention
  — a separate, large content task the user will do as part of rebuilding
  the catalog (per the earlier decision to start the product catalog
  fresh).
- Search relevance/ranking, typo tolerance, or synonym handling (Prefixbox
  features on the search bar; Dawn's native filtering is exact-match on
  tags/metafields, which is sufficient for structured attribute filtering).

# Product page templates for DM Stash releases — design

## Context

Arcane Flame sells 3D-printed DM Stash miniatures and terrain through the
homepage built in `2026-08-29-shopify-homepage-rollout`. No product page
work has happened yet — the store currently has ~20 DRAFT placeholder
products (generic AI-written names/descriptions, £0 prices, assembly-only
variants) from an earlier experiment. Per the user, these are being
discarded; the catalog will be rebuilt from scratch, partly because a fresh
Google Merchant Center start requires it. This spec does not touch those
products.

DM Stash releases minis and terrain in a handful of recurring shapes (see
below). Each shape needs the right dropdowns and, for minis, a lore/stat
block matching DM Stash's own site convention. The user will eventually
automate product creation and template selection, but that automation is
explicitly out of scope here — this spec only needs to leave the data model
in a shape that automation can drive later (see "Automation readiness").

## Product shapes this must cover

Resin:
1. Single mini — 32mm and 75mm heroic scale.
2. Single mini with an alternate version (e.g. with/without mask) — same
   two scales.
3. A trio (usually) of distinct models from one release, sold individually
   or as a full set — same two scales.
4. Single mini, 32mm scale only (BBEGs/monsters too large at 75mm).
5. Bust — one size, no assembly.
6. Assembly/finish options, where applicable (1–4, not 5): In parts &
   unprimed / Assembled & unprimed / Assembled & primed (White, Grey, or
   Black).

PLA:
7. Terrain — one large kit in multiple parts, sold as a single product.
8. Terrain — multi-part, purchasable as individual pieces.
9. Dice tower — single product, sometimes with a variant choice.

No assembly/primer options apply to PLA products currently.

## Decision: two page templates, not one per shape

The differences between shapes 1–6 are entirely which variant options a
given product has (scale, version, assembly, primer colour) — not layout.
Dawn's stock variant picker already renders only the options a product
actually defines, so no template branching is needed to support that.

The one real layout split is **minis/busts vs. terrain/dice towers**: minis
carry a lore paragraph and a stat block (Race / Class / Miniature Type /
Tabletop Size, mirroring DM Stash's own product pages); terrain does not.
So:

- `templates/product.mini.json` — shapes 1–5 (single minis, alt-version
  minis, individual trio members, 32mm-only minis, busts).
- `templates/product.terrain.json` — shapes 7–9 (terrain, dice towers).

## Trio handling (shape 3)

Each of the 3 models in a trio is its own product using `product.mini`,
cross-linked to its siblings, plus one additional simple product (also
`product.mini`, no stat block requirement) representing the full set at its
own price. No Shopify Bundles app, no linked inventory — everything here is
print-to-order, so a bundle is just a normal product with its own
description and price. Cross-linking between trio siblings/set uses a
`custom.trio_group` metafield (free-text group key); the template looks up
other products sharing the same key and lists them. If none share the key,
that section doesn't render.

## Data model

**New metafields** (namespace `custom`, all optional — a blank field simply
doesn't render):

| Metafield | Type | Used on | Notes |
|---|---|---|---|
| `custom.race` | single line text | mini | e.g. "Drow, Elf" |
| `custom.class` | single line text | mini | e.g. "Fighter, Ranger, Rogue" |
| `custom.miniature_type` | single line text | mini | e.g. "NPC", "Monster", "PC" |
| `custom.tabletop_size` | single line text | mini | D&D size category (Small/Medium/Large/Huge) — distinct from the mm scale variant |
| `custom.lore` | rich text | mini | Flavour paragraph, separate from the main SEO/practical description |
| `custom.trio_group` | single line text | mini | Shared key linking trio siblings + set product |

**Variant options** (plain Shopify options/variants, set per product, no
metafields involved): Scale (32mm/75mm), Version (e.g. With Mask/Without
Mask), Assembly (In parts & unprimed/Assembled & unprimed/Assembled &
primed), Primer Colour (White/Grey/Black — only meaningful once "Assembled
& primed" is chosen, but Shopify variants don't support conditional
sub-options, so Primer Colour will show as its own option and merchants
create the sensible combinations, same as the old draft products already
did).

**Main product description**: practical/SEO copy (materials, printing
process, scale/size specifics) — kept separate from `custom.lore`, matching
the split visible on DM Stash's own product pages.

## Page structure

`product.mini.json`: gallery → title/price/variant pickers (whichever
options that product has) → `custom.lore` block → stat block table (only
non-blank fields render) → main description → assembly & primer explainer
(renders only if the product has an option literally named "Assembly") →
trio cross-links (only if `custom.trio_group` matches another product).

`product.terrain.json`: gallery → title/price/variant pickers (if any) →
main description (kit contents, part count, assembly needs, footprint) →
no stat block, no lore section.

Both reuse Dawn's existing header/footer and the homepage's
`brand-tokens.css` / `home-base.css` for typography and colour, so product
pages look consistent with the homepage already shipped.

## Copy & SEO

All new copy (lore, descriptions) follows the voice rules already recorded
in `brand.html` (seasoned-DM tone, SEO-anchored on "TTRPG 3D printing", no
em dashes, no unprovable claims). Title convention follows the pattern
already used in the old drafts (`"<Name> Miniature | 32mm–75mm Heroic Scale
Mini | DnD Figure"`), since that pattern is already SEO-effective. Writing
actual per-product copy is out of scope for this template work.

## Automation readiness (not built now)

This shape is deliberately automation-friendly for later: template
selection is one field (`template_suffix`) at product-creation time, and
every mini-specific field is a metafield settable via the Admin API. No
automation code is written as part of this spec.

## Rollout

Build both templates and the six metafield definitions on the existing
unpublished/preview theme (same one the homepage lives on). Create 2–3 real
test products from scratch — one mini exercising every option type (scale +
version + assembly + primer + lore + stat block), one terrain product — to
verify against real DM Stash files/photos before the user starts rebuilding
the real catalog.

## Out of scope

- Deleting or migrating the existing ~20 placeholder products.
- Any automated product-creation/upload tooling.
- Writing real product copy/lore for actual releases.
- Google Merchant Center feed configuration.
- A formal "bundle" mechanism with linked inventory.

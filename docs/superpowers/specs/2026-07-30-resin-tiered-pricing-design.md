# Resin tiered pricing & model-type design

**Date:** 2026-07-30
**Scope:** Resin pricing only (`index.html` customer flow). PLA's pay-by-part mode is explicitly out of scope — separate future spec.

## Context

The current resin pricing engine (`js/calculator.js`) is a continuous per-ml formula (`resinCostPerMl × volume × (1 + support%) × (1 + markup%)`, plus flat labour/assembly/primer add-ons). Real test files exposed two problems no tuning of that formula could fix without trade-offs:

1. Small tabletop minis (~32mm) price under £1 raw — far below a viable minimum — while any fix that raises the per-ml rate to compensate makes large display models (~75mm) price absurdly high, since volume scales as the cube of linear size.
2. There's no way to charge for "the kind of thing this is" (a mini vs. a bust vs. terrain) or for optional add-ons (a separate base, wings, a sword) — everything is priced purely by resin volume.

This spec replaces the continuous formula with **fixed price tiers by physical size**, plus a **Model Type** selector that governs which add-ons (Base, Extras) are relevant to a given upload. `admin.html`/Shopify-metaobject migration (a separate, earlier-discussed sub-project) is unaffected in approach — this new config (tiers, model types, extras) becomes additional fields in the same config object that migration will eventually move to Shopify.

## Size tier ladder

Applies to **both model bodies and separate bases**, using the same table. A model's tier is determined by its **largest single bounding-box dimension** (after scale is applied) — not all three dimensions, and not volume. Support material does not change tier (supports are a separate physical concern, not a pricing one, under this model).

| Tier | Max dimension | Price |
|---|---|---|
| XS | ≤ 15mm | £1 |
| Small | ≤ 30mm | £3 |
| Regular | ≤ 50mm | £6 |
| Large | ≤ 100mm | £15 |
| Large+ | ≤ 120mm | £21 |
| XL | ≤ 150mm | £30 |
| XL+ | ≤ 180mm | £45 |
| Max plate | fits build plate (see below) | £60 |

Tiers are admin-configurable (a list of `{maxDimensionMm, price}` pairs, ascending) — the table above is the initial seed data, not a hardcoded constant.

## Model Type & add-ons

Each upload is assigned a **Model Type** by the customer (a dropdown, admin-configurable list). A Model Type record has:
- `basesIncluded: boolean` — if true, the "Add base" add-on is hidden/disabled for this type (e.g. a Hero Forge mini already has its base modeled in); if false, "Add base" becomes available, priced on the same size-tier ladder as bodies (using the base file's own largest dimension).
- `availableExtras: string[]` — which Extras (see below) are offered for this type.

Seed Model Types: **Miniature — base included**, **Miniature — base separate**, **Display piece / bust**, **Terrain / scenery**, **Other**.

**Extras** (Wings, Sword, Shield, Banner, etc.) are a flat, admin-managed list — each a fixed add-on price (not tier-based, not size-dependent). The customer ticks which apply to a given model; each ticked extra adds its flat price to that model's total.

## What stays from the old formula

- **Assembly cost** (`calcAssemblyCost`) and **primer cost** (`calcPrimerCost`) are unchanged and continue to add on top of the new tiered subtotal — they represent real extra labour (joining parts, painting prep) orthogonal to "how big is this thing."
- **Resin material choice** (Standard/Tough/Flexible/Castable/Dental) still matters: tier prices are calibrated for Standard resin. Non-standard materials apply an admin-configurable percentage surcharge on top of the tier price (e.g. Castable +25%), rather than a full per-ml recalculation.
- **`labourBaseFee`** (currently a flat £2/model) is **dropped** for tier-priced models — the £6/£15/etc. tier prices are all-in figures (confirmed against "Hero Forge = £6" as a complete price, not a subtotal). *Flagged for your review — correct me if labour should still stack on top.*

## Two guardrails

1. **Physical fit check (hard limit, blocks pricing):** using your build plate (211.68 × 118.37 × 220mm) minus a 20% margin for supports, if a model doesn't fit in any orientation, it cannot be auto-priced. Distinct, blunter messaging than the softer review notice below — this is a "this can't be printed as uploaded" fact, not a pricing caveat.
2. **Order-value review trigger (soft, £150+):** once the cart's running total crosses £150, the order still proceeds through checkout but is flagged for manual review — independent of whether that's one expensive model or a large cart of small ones.

## Copy additions

- **Always-visible review/cancellation notice**, shown on every order (more prominent when the £150 trigger fires): orders are reviewed by hand before confirmation, and can be cancelled at that point if something needs adjusting.
- **AI-generated-file heads-up**, shown near the upload/warning area: a short, non-blocking note that AI-generated meshes often need cleanup (thin walls, no drain holes, poor overhangs) and asking the customer to flag if their file is AI-generated so it can be checked before printing.
- **Per-model notes field**: a free-text box per model group (distinct from the existing order-wide "Additional notes" on the contact form), for requests specific to that one model. Shown in the review step and included in the quote payload.

## Data model changes

New fields added to the shared config object (same object destined for the Shopify metaobject migration):
- `sizeTiers: [{ maxDimensionMm, price }]` (ascending)
- `modelTypes: [{ id, name, basesIncluded, availableExtras: [extraId] }]`
- `extras: [{ id, name, price }]`
- `materialSurcharges: { [materialId]: percentSurcharge }`
- `buildPlate: { x, y, z, supportMarginPct }`
- `customQuoteOrderThreshold: number` (£150 seed value)

Per-item/group data additions: `modelType` (selected type id), `extras` (selected extra ids), `notes` (free text) on each model group.

## Testing / verification

No automated test suite exists for this project (static site, no build step) — verification is manual, driven through the browser preview, using the same real test files already gathered this session (heart 5mm, Hero Forge 32mm, DM Stash 32mm two-part, DM Stash 75mm two-part) as regression anchors: re-quote all four after implementation and confirm each lands at its target price (80p-ish heart, £6 Hero Forge, £6+£2 DM Stash 32mm, ~£40 DM Stash 75mm-equivalent under the new tier table).

## Out of scope (future work)

- PLA pay-by-part mode (separate, ungrouped pricing flow) — own future spec.
- Actual migration of config into a Shopify metaobject (previously discussed, still pending) — this spec's new config fields are designed to slot into that migration, not to precede or block it.

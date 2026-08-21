# STL viewer / 3D print price calculator

A browser-side STL price calculator for Arcane Flame's Shopify store. The
browser parses the STL, prices it, and submits the order through a Supabase
Edge Function ("the relay") which talks to Shopify.

## Read this first

**`docs/shopify-integration-runbook.md`** is the operational source of truth:
architecture, every identifier, deploy procedures, known limitations and a
troubleshooting table. Read it before touching the Shopify integration.

The plans under `docs/superpowers/plans/` are historical. `2026-08-02-shopify-integration.md`
still documents uploading STLs to Shopify Files, which was **abandoned** (a hard
20 MB Admin API cap) and replaced with Supabase Storage. Do not rebuild from it.

## Things that will bite you

- **`js/main.js` and `shopify-theme/assets/print-calc-main.js` are near-copies.**
  Change both. Verify: `diff --strip-trailing-cr js/main.js shopify-theme/assets/print-calc-main.js`
  (only import paths and one spinner class should differ). The same applies to
  the other `js/*.js` ↔ `shopify-theme/assets/print-calc-*.js` pairs, and to
  `index.html` ↔ `shopify-theme/snippets/print-calculator-markup.liquid`.
- **Theme import specifiers must carry `?v=<content hash>`.** A module's own
  relative imports never pass through Liquid's `asset_url`, so they request a
  bare CDN URL that is cached with a long TTL — and Shopify strips unknown
  query params, so you cannot bust it by hand. A changed sub-module will keep
  serving its old copy while the Admin API reports the new checksum. This cost
  a deploy on 2026-08-21: `print-calc-icons.js` shipped and verified by
  checksum, but the storefront kept serving the previous build.
- **Theme writes to the live/MAIN theme are blocked.** Duplicate → write → a
  human publishes. Wait for `processing: false` before writing, and verify by
  `checksumMd5`, never by reading the file back. Runbook §5.
- **Pricing config lives in a Shopify metafield that overrides `js/config.js`.**
  Editing the code alone will not change live prices. Runbook §6.
- **The relay's `DEFAULT_MINIMUM_ORDER_TOTAL` / `DEFAULT_CUSTOM_QUOTE_THRESHOLD`
  must mirror `DEFAULT_CONFIG` in `js/config.js`**, or checkout rejects ordinary
  orders.
- **Relay deploys are instant and need no theme publish.** Prefer fixing things
  there when both options exist.

## Testing

```bash
cd supabase/functions/shopify-relay && deno test --allow-env
```

There is no test runner for the browser code; verify it in the real storefront.
Smoke test all four order shapes — under £5, normal, multi-model, and over the
£150 quote threshold. Each one exercised a different bug historically.

## Conventions

- Comments explain *why*, especially where the code looks odd — most oddities
  are load-bearing workarounds for a Shopify or Supabase constraint. Keep them.
- Prices are decimal strings to 2dp on the wire; totals are derived from those
  rounded figures so client and relay agree exactly.

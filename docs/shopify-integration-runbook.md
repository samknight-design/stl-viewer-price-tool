# Shopify print-calculator runbook

Operational truth for the 3D print calculator on the Arcane Flame store, as of
**2026-08-19**. This describes what is actually deployed and why, including the
things that broke and the constraints behind each fix.

> The build plans under `docs/superpowers/plans/` describe what we *intended* to
> build and are **partly wrong now** — in particular `2026-08-02-shopify-integration.md`
> documents uploading STLs to Shopify Files, which was abandoned (see
> "Uploads" below). Trust this file over those.

---

## 1. How it fits together

```
Browser (Shopify theme, or standalone index.html)
  │  parses the STL locally, prices it locally
  │
  ├─1─ GET  /config          ─────► relay ──► Shopify shop metafield (pricing)
  ├─2─ POST /files/stage     ─────► relay ──► Supabase Storage signed upload URL
  ├─3─ PUT  <signed url>     ─────────────────► Supabase Storage (raw STL bytes)
  └─4─ POST /checkout        ─────► relay ──┬─ under threshold → create priced
                                            │   Shopify variant → browser adds
                                            │   it to /cart/add.js → /checkout
                                            └─ over threshold  → create Shopify
                                                draft order + notify owner
```

The browser prices the order for display. Since 2026-09-21 the relay also
re-prices it from the uploaded geometry before anything reaches Shopify — it
pulls each STL back out of Storage, measures it, and runs the same engine the
browser runs. See §7a.

---

## 2. Identifiers

| Thing | Value |
|---|---|
| Supabase project | `aqnpkvzycdjwbapfpvfl` |
| Relay base URL | `https://aqnpkvzycdjwbapfpvfl.supabase.co/functions/v1/shopify-relay` |
| Edge function | `shopify-relay` (v54 at time of writing), `verify_jwt: false` |
| Staging function | `shopify-relay-staging` — same secrets, used by draft themes |
| Storage bucket | `quote-uploads` (public read; writes only via signed URL) |
| Shopify shop | Arcane Flame, `gid://shopify/Shop/87781310808` |
| Hidden product | `Custom 3D Print (do not edit)` — `15907078340952` |
| Pricing metafield | `print_calculator.pricing_config` (type `json`, shop-owned) |
| Live theme | `196996628824` — "LIVE - 3D Calculator (all fixes, 19 Aug)" |
| Calculator page | `https://www.arcane-flame.com/pages/3d-print-calculator` |
| Admin page | `https://samknight-design.github.io/stl-viewer-price-tool/admin.html` |
| GitHub Pages source | branch `worktree-shopify-integration`, path `/` |

### Edge function secrets

`SHOPIFY_STORE_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`,
`SHOPIFY_API_VERSION`, `PRINT_PRODUCT_ID`, `ADMIN_PASSWORD`, and optionally
`RESEND_API_KEY` / `NOTIFY_TO_EMAIL` / `RESEND_FROM_EMAIL` for owner
notification emails. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are
injected by the platform — do not set them yourself.

Manage at
`https://supabase.com/dashboard/project/aqnpkvzycdjwbapfpvfl/settings/functions`.

---

## 3. Uploads — why Supabase Storage, not Shopify Files

Shopify's Admin API hard-caps generic `FILE` staged uploads at **20 MB**. This
is enforced by the GCS policy Shopify returns (`content-length-range` tops out
at 20971520) and is *not* affected by the `fileSize` you pass to
`stagedUploadsCreate` — that field is only honoured for `VIDEO` and `MODEL_3D`,
and `MODEL_3D` rejects the `model/stl` mime type. Customer STLs routinely
exceed 20 MB, so that path can never work.

We use Supabase Storage's signed-upload-URL pattern instead: same
direct-from-browser architecture, pointed at a bucket we control. The returned
`publicUrl` is valid immediately — no finalize/resolve round trip. The cap is
the bucket's `file_size_limit` (**50 MB** on the free plan; higher on Pro).

---

## 4. Deploying the relay

Edit under `supabase/functions/shopify-relay/`, then:

```bash
cd supabase/functions/shopify-relay && deno test --allow-env
```

Deploy via the Supabase MCP `deploy_edge_function` (send **all** files —
it replaces the whole function) or the Supabase CLI. Takes effect immediately;
no theme publish needed. Verify with a real request:

```bash
curl -s https://aqnpkvzycdjwbapfpvfl.supabase.co/functions/v1/shopify-relay/config
```

---

## 5. Deploying theme changes — read this before you try

Theme files live in `shopify-theme/`:
`sections/print-calculator.liquid`, `snippets/print-calculator-markup.liquid`,
`assets/print-calc-*.js`, `assets/print-calc-style.css`.

**`assets/print-calc-main.js` is a near-copy of `js/main.js`.** Keep them in
sync; they differ only in import paths and one spinner class. Verify with:

```bash
diff --strip-trailing-cr js/main.js shopify-theme/assets/print-calc-main.js
```

Three traps, each of which shipped a broken site during the 2026-08-19 session:

1. **Writes to the live/MAIN theme are blocked.** Duplicate the theme, write to
   the copy, then a human publishes it in Shopify admin.
2. **Never write while the theme reports `processing: true`.** `themeDuplicate`
   copies asynchronously and has taken 20–30 minutes on this store. An upsert
   during that window *appears* to succeed, then the background copy job
   overwrites it. Poll `theme(id:){ processing }` until `false` first.
3. **Verify with `files { checksumMd5 }`, not a read-back.** Reading the file
   straight back returns your content even when it is about to be clobbered.
   Compare against local `md5sum` instead.

**Upload large files by URL, not by pasting text.** Hand-transcribing the 64 KB
`print-calc-main.js` into a tool call corrupted it three separate times. Push to
GitHub and point Shopify at the raw URL pinned to a commit SHA:

```
https://raw.githubusercontent.com/samknight-design/stl-viewer-price-tool/<sha>/shopify-theme/assets/print-calc-main.js
```

`themeFilesUpsert` returns an empty `upsertedThemeFiles` array for URL bodies
because the fetch is async — confirm via checksum.

**Shortcut that avoids the 25-minute duplication:** if a previously-published
theme is still around and its `config/settings_data.json`, templates, layout and
section files are checksum-identical to the live theme, write into that one
instead of duplicating. Always compare those checksums first, or you will revert
the merchant's theme-editor work.

**Preview cookies lie.** Loading `?preview_theme_id=<id>` pins *your browser* to
that theme via a cookie that survives navigation and confused an entire
debugging session. Clear it with `?preview_theme_id=` (empty). The authoritative
check for which theme is actually serving is the `server-timing` response header:
`theme;desc="<id>"`.

---

## 6. Pricing configuration

Precedence at runtime: **shop metafield > `DEFAULT_CONFIG` in `js/config.js`**.

The metafield was seeded from `DEFAULT_CONFIG` on 2026-08-19, so it now wins —
**editing `js/config.js` alone no longer changes live prices.**

- Change prices → update the metafield (`metafieldsSet` via Admin API), or use
  the admin page for the handful of fields it still supports.
- `admin.html` is **stale**: its inputs belong to the pre-2026-07-30 per-mL
  model and it cannot edit `sizeTiers`, `maxPlatePrice`, `primerTiers`,
  `extras`, `plaColors`, `customQuoteOrderThreshold` or `materialSurcharges`.
  It is safe to use — `collectForm()` mutates the loaded config rather than
  replacing it, so the tiers survive a save — but it cannot change print prices.
- Logging into the admin page **performs a save** (`js/admin.js` calls
  `saveConfig` to verify the password server-side). Check the values look right
  before logging in.

**The relay's fallbacks must mirror the browser's.** `DEFAULT_MINIMUM_ORDER_TOTAL`
and `DEFAULT_CUSTOM_QUOTE_THRESHOLD` in the relay exist because a shop with no
saved config made the two sides disagree: the browser floored sub-£5 orders to
£5 while the relay assumed no minimum, and rejected every order below the floor.
If the client defaults change, change these too.

---

## 7. Known limitations

**Prices are set by the client — CLOSED 2026-09-21.** See §7a. What remains a
customer declaration is print *intent* (scale, material, colour, primer,
assembly, extras, pre-supported), not the model's size. Pre-supported in
particular is a claim worth eyeballing when you open the file, since it removes
the support handling fee.

**Variant growth.** Every sub-threshold checkout permanently adds a variant to
`PRINT_PRODUCT_ID`. Shopify caps at 100. Test artifacts were purged on
2026-08-19 (40 → 18). Needs periodic pruning or variant reuse by price.

**One cart line per order.** Only the first line item's properties travel to the
cart, so multi-model orders lose per-model attributes on the Shopify side. The
draft-order path (over threshold) keeps everything.

**Browser performance.** Parsing, thumbnailing and rendering an 8 MB / 169k
triangle STL happens entirely client-side and can freeze the tab. Not a server
concern; no hosting tier affects it.

---

## 7a. Server-side price verification

The relay re-prices every checkout from the actual uploaded files before it
creates a variant or a draft order.

```
POST /checkout
  ├─ arithmetic check      submitted total vs submitted line items (as before)
  └─ verification          for each file: Storage ──► measure ──► re-price
                           compare against the submitted per-model prices
```

| File | Does |
|---|---|
| `stl.ts` | Streams an STL and returns volume + bounding box |
| `pricing.ts` | Port of `js/calculator.js` |
| `pricingConfig.ts` | Mirror of `DEFAULT_CONFIG` + the same metafield merge |
| `verify.ts` | Fetch, measure, re-price, compare. Only ever reports |

**`PRICE_VERIFY_MODE`** (edge function secret) decides what happens next:

- `off` — do not re-price.
- `monitor` — **default** — re-price and log a `price-verify` line, change nothing.
- `enforce` — a mismatch, or an order that could not be measured, becomes a
  draft order tagged `price-check` with both figures in the note.

Enforcement routes to manual review; it never charges a different figure from
the one the customer was shown.

**The secret is project-wide, not per-function.** Setting it to `enforce` for a
staging function also arms the live relay the moment the live relay is deployed
with this code. Set it back to `monitor` before deploying to live, watch the
logs, then arm it.

An order is reported "skipped" (unverifiable, not suspicious) when the frontend
is an older cached build that does not send per-file settings, a file has no
storage path, a file is over `DEFAULT_MAX_VERIFY_BYTES` (64 MB), or Storage
cannot be reached. Verification never throws into the checkout path — a bug in
measurement must not be able to reject a real order.

`stl.ts` streams rather than buffering: the browser's parser costs roughly 8x
the file size in memory, which would OOM a 256 MB Edge Function on a file the
50 MB bucket accepts. Measuring incrementally keeps the high-water mark at
about one chunk.

**`pricing.ts` / `pricingConfig.ts` must stay in lockstep with
`js/calculator.js` / `js/config.js`.** Drift does not fail loudly; it quietly
re-prices orders differently from the customer's screen and sends honest
checkouts to review. `pricing.test.ts` imports `js/config.js` directly and
asserts the mirror, so the parity tests fail if the two separate.

---

## 8. Troubleshooting

| Symptom | First thing to check |
|---|---|
| "Something went wrong submitting your order" | Network tab → the `/checkout` response body. It names the failing check and the numbers. |
| `400 grandTotal does not match line items` | Compare `expected` vs `received` in the response. Usually a client/relay config mismatch (§6) or rounding. |
| `400 Too many line items` | More than 50 models, or a crafted request. |
| `Add to cart failed: HTTP 422` | Freshly created variant not yet visible to the storefront cart. Retries cover ~20s; check the variant exists. |
| `500 Internal error` | `query_logs` on the Supabase project, source `function_edge_logs`. Historically a duplicate variant option value. |
| Theme change didn't appear | Check `server-timing` `theme;desc` against the MAIN theme id, and clear any `preview_theme_id` cookie (§5). |
| Prices not what you set | `GET /config` — the metafield wins over code (§6). |

Relay request history:

```sql
select timestamp, event_message from logs
where source = 'function_edge_logs'
order by timestamp desc limit 30
```

---

## 9. If you had to rebuild from scratch

1. Create the hidden Shopify product; note its id as `PRINT_PRODUCT_ID`.
2. Create the Supabase project, the `quote-uploads` bucket (public read), and
   set the secrets in §2.
3. Deploy `supabase/functions/shopify-relay` with `verify_jwt: false`.
4. Seed `print_calculator.pricing_config` from `DEFAULT_CONFIG`, or leave it
   unset — but only if the relay's fallbacks still mirror the client's (§6).
5. Copy `shopify-theme/` into the theme, point `sections/print-calculator.liquid`
   at the page template, publish.
6. Smoke test all four paths: under £5, normal, multi-model, and over the
   £150 threshold. Each exercised a different bug historically.

---

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

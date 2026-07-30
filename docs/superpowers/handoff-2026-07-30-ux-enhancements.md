# Handoff — STL Viewer Price Tool, next session

**Repo:** `C:\Users\samkn\Desktop\STL-viewer-price-tool` (static vanilla HTML/CSS/JS, no build step, no test framework). Dev server: `python server.py 8744`.

## What just landed (commit `d064df3` on `master`, 2026-07-30)

Two changes, both completed and committed:

1. **Removed the "Model Type" selector** from the group settings UI (`js/main.js`) and config (`js/config.js`). It only existed to gate which Extras checkboxes showed, and became redundant once size-tier pricing was carrying the real pricing logic. Extras (Wings/Sword/Shield/Banner) are now always available on every model group, unfiltered.

2. **Supported-vs-unsupported pricing parity.** Size tier is looked up from a model's largest measured dimension. A "pre-supported" upload's mesh already includes its support geometry (honest measured size), but a "standard" upload is bare — the shop adds supports afterwards, growing its real printed footprint beyond what the file shows. Before this fix, uploading the same model both ways could land in different (unfairly cheaper) tiers for the unsupported version.

   Fix, in `js/calculator.js`'s `calcItemCost`:
   - A standard (non pre-supported) file's tier-lookup dimensions get inflated by `config.supportSizeInflationPct` (default **8%**) — applied only for tier/build-plate-fit purposes, never to the displayed print size or resin volume.
   - A small flat `config.unsupportedHandlingFee` (default **20p**) is added to standard uploads, so pre-supported always prices at least a little cheaper than an equivalent standard upload, even when both land in the same tier.
   - Both values are plain numbers in `DEFAULT_CONFIG` (`js/config.js`) — not yet exposed in `admin.html`'s config editor UI, so tuning them today means editing the file directly (or the browser localStorage-backed export, if the admin UI is later fixed to handle them).

   This is a deliberate "gets us 90% there" approximation, per explicit user instruction — it's a step function, so two versions of the same model very close to a tier boundary can still land one tier apart. Not something to "fix" further without being asked.

Verified via direct unit-level testing of `calcItemCost` in the browser console (synthetic bare-vs-presupported dimension pairs, including one straddling a tier boundary) — confirmed same-tier landing and the pre-supported side always exactly `unsupportedHandlingFee` cheaper. Did not do a full drag-and-drop file-upload UI pass this round since the logic change was isolated to `calcItemCost`/config and the rendering paths were spot-checked for the removed Model Type UI.

## What's next: "a few more UX enhancements"

The user said the next phase is UX enhancements but gave no specifics — this needs a fresh scoping conversation with the user, not assumptions. Good opening question: ask what's bugging them about the current flow (upload → configure → review → submit) now that pricing is settled.

## Known deferred items (not urgent, not to be started unprompted)

- **Admin security**: `admin.html` currently uses a trivially-bypassable client-side password check (`config.adminPassword` in localStorage). User decided the eventual fix is to move admin config editing into Shopify itself (metaobjects, using Shopify's own staff login as auth) rather than building custom OAuth — but nothing has been implemented. Don't start this without the user raising it again.
- **PLA "pay by part" pricing mode** — resin was built first by design; PLA mode was explicitly deferred, no spec written.
- **Tier ladder calibration** — a 75mm two-part display model (DM Stash test file) currently totals £36 combined vs. the user's earlier informal "~£40" ballpark. Flagged for awareness, not a bug — only revisit if the user brings it up.
- Minor known issues from the mobile-redesign review (all low priority, logged, not blocking): a few touch targets under 44px (`.btn-sm` at 36px, scale-preset pills at 32px), the 3D-preview hover hint invisible on touch, cosmetic CSS breakpoint-convention mixing (600/768/960px, both min-width and max-width styles present).

## Useful context for this codebase

- `js/calculator.js` — pricing engine, all tier/cost math in `calcItemCost`, `calcGroupCost`, `calcOrderTotal`.
- `js/config.js` — `DEFAULT_CONFIG`, all tunable numbers (tiers, surcharges, fees, thresholds), localStorage persistence via `getConfig`/`saveConfig`/`resetConfig`.
- `js/main.js` — all UI rendering and event handling for the customer-facing page (`index.html`); no framework, direct DOM string templates + delegated event handlers.
- `admin.html`/`js/admin.js` — desktop-only admin config editor, explicitly out of scope unless the user asks; has a minimal crash-guard (try/catch) in `updatePreview()` from an earlier session fix, nothing more.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` hold the design spec and implementation plan for the tiered-pricing rewrite (2026-07-30) if deeper historical context on the pricing model's reasoning is needed.
- Dev server (`server.py`) is a `ThreadingHTTPServer` (fixed earlier this session from a blocking `socketserver.TCPServer` that hung under concurrent requests) and sends `Cache-Control: no-cache` on every response, so local testing isn't affected by the app's own `?v=N` cache-busting query strings (those only matter in production).

# Mobile-first redesign — design spec

**Date:** 2026-07-28
**Scope:** `index.html` (customer-facing quote calculator) only. `admin.html` is out of scope — it stays desktop-only.

## Context

The 3D Print Price Calculator (`www.arcane-flame.com`'s quote tool) is a static, no-build vanilla JS + Three.js app. It's desktop-first today: base CSS targets a wide layout, with `max-width` media query patches bolted on at 960px, 700px, 640px, 600px, and 480px. Some of those patches are already reasonable (the order/3D modals become bottom sheets at 600px; the header stacks at 480px) but they're inconsistent and incomplete — several controls are unusable on touch (see below).

This is the first of two sub-projects. The second — wiring real Shopify checkout (custom-priced cart line items) into the submit flow — is deliberately deferred to its own spec once this redesign is settled. Today, submitting a quote only logs the payload to `console.info` and shows a fake success screen; that does not change in this pass.

## Goals

1. Rebuild the CSS mobile-first: base styles for phones (~360–430px), then `min-width` media queries progressively enhance for tablet (768px+) and desktop (960px+) — replacing the current "desktop base + `max-width` patches" approach.
2. Fix touch-usability bugs that exist today (hover-only controls, undersized tap targets).
3. No changes to pricing/parsing logic (`calculator.js`, `stl-parser.js`, `config.js`) — this is CSS/markup/interaction only.

## Component changes

### Header
Two-row layout below tablet width: row 1 = logo + title (shrunk), row 2 = two icon-only buttons ("+" new model group, "⚙" admin), each a 44×44px minimum tap target. At tablet width+, reverts to the existing single-row layout (logo + title + text buttons).

### Drop zone
Same drag-and-drop element and file input, but copy changes on touch/narrow widths: lead with "Tap to browse your files" instead of "Drop STL files here" (drag-and-drop doesn't exist on a phone). Vertical padding shrinks on mobile so it doesn't push content far down the page.

### Order Summary → sticky bottom bar (mobile only)
Below tablet width, the sidebar `<aside class="order-summary">` is replaced by a fixed bottom bar showing item count + running total + a "Review Order →" button. Tapping it opens the existing order-review overlay (step 1 of the order flow) — no new review UI, just a new entry point. At tablet width+, reverts to the current sidebar, and the bottom bar is not rendered.

The bar must re-render whenever totals change (same recalculation path that updates the sidebar today; it now also targets the bar's DOM node on mobile).

### File cards
Keep the existing stacked layout (thumbnail over info) below 640px. Fix the ✕ remove button: change from hover-only visibility (`opacity:0` / `:hover { opacity:1 }`) to always-visible, and grow it to a 44×44px tap target on touch/mobile widths (currently 28×28px, hover-gated).

### 3D preview / order modals
Both already collapse to a bottom-sheet pattern at 600px in the current CSS — keep that visual behavior, but fold it into the new mobile-first breakpoint scheme rather than a separate late-bolted-on block. Three.js `OrbitControls` already supports touch (one-finger rotate, pinch zoom, two-finger pan) — no JS changes needed for 3D interaction itself, only container/canvas sizing inside the bottom sheet. The static-thumbnail-first pattern (tap "Load Interactive 3D Preview" to activate the canvas) stays as-is — it already matches the "static by default, full 3D on demand" behavior confirmed for this redesign.

### Touch targets generally
Audit all interactive controls (segment buttons, scale presets, quantity steppers, close buttons) against a 44px minimum on mobile widths; several are currently smaller and need padding/sizing adjustments at the mobile breakpoint.

## Data flow / risk

No changes to STL parsing, cost calculation, or config persistence — zero risk of quote-price regressions from this work. The only stateful change is the sticky bottom bar needing to reflect live totals as items/settings change, reusing the existing total-calculation/render path rather than introducing a new one.

## Testing / verification

This is a visual and interaction change with no existing test suite (vanilla JS, no build step). Verification is manual, driven through the browser preview:
- Phone width (375×812): drop a file, adjust settings, remove a file via the new ✕ button, open the 3D modal and confirm touch rotate/zoom works, tap the sticky bar to open the review step, and submit a quote.
- Tablet (768px) and desktop (1280px) widths: confirm the layout reverts to sidebar/single-row header and nothing regresses from the breakpoint restructuring.

## Out of scope (future sub-project)

Real Shopify checkout integration (custom-priced cart line items via Shopify's cart API, product/variant setup) is a separate, independent piece of work and will get its own design spec once this redesign ships.

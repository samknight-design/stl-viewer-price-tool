# Mobile-First Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the customer-facing quote calculator (`index.html`) mobile-first, fixing touch-usability bugs (hover-only controls, undersized tap targets) along the way, with zero changes to pricing/parsing logic.

**Architecture:** Pure CSS/markup/interaction-wiring changes to `index.html`, `css/style.css`, and the DOM-rendering parts of `js/main.js` (not `calculator.js`/`stl-parser.js`/`config.js`). CSS moves from "desktop base + `max-width` overrides" to "mobile base + `min-width` overrides" for the highest-risk/highest-value components: header, drop zone, main grid / order summary, and the two full-screen overlays (3D viewer modal, order form). Lower-risk existing `max-width` rules that already work correctly on mobile (file-card thumbnail stacking, group-settings stacking) are left alone — this plan does not touch every media query in the file, only the ones the design spec calls out.

**Tech Stack:** Vanilla HTML/CSS/JS (no build step, no framework), Three.js via CDN import map for the 3D viewer. No test framework exists in this repo.

## Global Constraints

- No changes to `js/calculator.js`, `js/stl-parser.js`, or `js/config.js` — pricing/parsing logic is out of scope for every task in this plan.
- `admin.html` and its CSS/JS are out of scope — desktop-only per the design spec, not touched by any task.
- No automated test suite exists (static site, no build tooling). Every task's "test" step is a manual, scripted verification in the browser preview at specific viewport widths, driven with the project's own dev server (`python server.py 8744`) — do the verification for real, don't skip it because "it's just CSS."
- Breakpoints used throughout this plan: **mobile base** (no media query — applies at all widths unless overridden), **tablet** `@media (min-width: 768px)`, **desktop** `@media (min-width: 960px)`. Header and drop zone switch at 768px; main grid / order summary switch at 960px (a 340px fixed sidebar needs the extra room — this matches the original desktop breakpoint already in the codebase, so it's a like-for-like risk).
- Three.js `OrbitControls` (used in `js/viewer.js`) already supports touch (one-finger rotate, pinch zoom, two-finger pan) out of the box — no task in this plan should add custom touch-gesture JS for the 3D viewer.

---

### Task 1: Mobile-first header, drop zone, and page shell

**Files:**
- Modify: `index.html:20-44` (header markup, drop-zone markup)
- Modify: `css/style.css:64-65` (`.app-wrap`)
- Modify: `css/style.css:68-103` (`.app-header` and related header selectors)
- Modify: `css/style.css:134-156` (`.drop-zone` and related selectors)
- Modify: `css/style.css:158-160` (`.main-grid`)
- Modify: `css/style.css:702-716` (existing `@media (max-width: 480px)` block — remove now-superseded `.app-header`, `.app-wrap`, `.drop-zone` rules)

**Interfaces:**
- Produces: `.app-header-actions` (new class replacing the header's inline `style="display:flex;gap:8px;align-items:center"` wrapper div), `.btn-label` (new class on the text span inside header action buttons, hidden on mobile), `.drop-title-desktop` / `.drop-title-touch` (new classes, CSS-only visibility toggle — no JS reads these).
- Consumes: nothing from other tasks.

- [ ] **Step 1: Update the header markup in `index.html`**

Replace:
```html
    <div style="display:flex;gap:8px;align-items:center">
      <button class="btn btn-ghost btn-sm" id="add-group-btn">+ New Model Group</button>
      <a href="admin.html" class="btn btn-ghost btn-sm">⚙ Admin</a>
    </div>
```
with:
```html
    <div class="app-header-actions">
      <button class="btn btn-ghost btn-sm" id="add-group-btn" aria-label="New Model Group">
        <span aria-hidden="true">+</span><span class="btn-label">New Model Group</span>
      </button>
      <a href="admin.html" class="btn btn-ghost btn-sm" aria-label="Admin">
        <span aria-hidden="true">⚙</span><span class="btn-label">Admin</span>
      </a>
    </div>
```

- [ ] **Step 2: Update the drop-zone markup in `index.html`**

Replace:
```html
    <div class="drop-icon">📂</div>
    <h3>Drop STL Files Here</h3>
    <p>or click to browse your files</p>
```
with:
```html
    <div class="drop-icon">📂</div>
    <h3 class="drop-title-desktop">Drop STL Files Here</h3>
    <h3 class="drop-title-touch">Tap to Browse Your Files</h3>
    <p>or click to browse your files</p>
```

- [ ] **Step 3: Rewrite `.app-wrap` mobile-first in `css/style.css`**

Replace:
```css
.app-wrap { max-width: 1280px; margin: 0 auto; padding: 0 24px 80px; }
```
with:
```css
.app-wrap { max-width: 1280px; margin: 0 auto; padding: 0 16px 60px; }
@media (min-width: 960px) {
  .app-wrap { padding: 0 24px 80px; }
}
```

- [ ] **Step 4: Rewrite the header block mobile-first in `css/style.css`**

Replace the entire header section:
```css
/* ---- Header -------------------------------------------------------- */
.app-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 28px; margin: 0 -24px;
  background: #1b2f3e;
  border-bottom: 3px solid var(--flame);
  gap: 16px;
}
.app-header-left { display: flex; align-items: center; gap: 20px; }

.app-logo-img {
  height: 52px; width: auto; display: block; flex-shrink: 0;
}
.app-logo-fallback {
  width: 44px; height: 44px;
  background: linear-gradient(135deg, #7a2e05 0%, #e8660a 60%, #ff9a40 100%);
  border-radius: var(--radius-sm);
  display: flex; align-items: center; justify-content: center;
  font-size: 1.4rem; box-shadow: 0 0 16px rgba(232,102,10,.35); flex-shrink: 0;
}
.app-title p {
  font-family: var(--heading-font);
  font-size: 1rem; letter-spacing: .04em;
  color: rgba(255,255,255,.85);
}
.app-title .app-tagline {
  font-size: .72rem; color: rgba(255,255,255,.45);
  display: block; margin-top: 1px; font-family: var(--body-font);
}

.app-header .btn-ghost {
  color: rgba(255,255,255,.75); border-color: rgba(255,255,255,.2); background: transparent;
}
.app-header .btn-ghost:hover {
  background: rgba(255,255,255,.1); color: #fff; border-color: rgba(255,255,255,.38);
}
.brand-divider { height: 0; border: none; margin-bottom: 28px; }
```
with:
```css
/* ---- Header -------------------------------------------------------- */
.app-header {
  display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
  padding: 12px 16px; margin: 0 -16px;
  background: #1b2f3e;
  border-bottom: 3px solid var(--flame);
}
.app-header-left { display: flex; align-items: center; gap: 12px; width: 100%; }

.app-logo-img {
  height: 40px; width: auto; display: block; flex-shrink: 0;
}
.app-logo-fallback {
  width: 36px; height: 36px;
  background: linear-gradient(135deg, #7a2e05 0%, #e8660a 60%, #ff9a40 100%);
  border-radius: var(--radius-sm);
  display: flex; align-items: center; justify-content: center;
  font-size: 1.2rem; box-shadow: 0 0 16px rgba(232,102,10,.35); flex-shrink: 0;
}
.app-title p {
  font-family: var(--heading-font);
  font-size: .92rem; letter-spacing: .04em;
  color: rgba(255,255,255,.85);
}
.app-title .app-tagline {
  font-size: .7rem; color: rgba(255,255,255,.45);
  display: block; margin-top: 1px; font-family: var(--body-font);
}

.app-header .btn-ghost {
  color: rgba(255,255,255,.75); border-color: rgba(255,255,255,.2); background: transparent;
}
.app-header .btn-ghost:hover {
  background: rgba(255,255,255,.1); color: #fff; border-color: rgba(255,255,255,.38);
}
.brand-divider { height: 0; border: none; margin-bottom: 28px; }

.app-header-actions { display: flex; gap: 8px; width: 100%; }
.app-header-actions .btn {
  flex: 0 0 44px; width: 44px; height: 44px; padding: 0;
  justify-content: center;
}
.app-header-actions .btn-label { display: none; }

@media (min-width: 768px) {
  .app-header {
    flex-direction: row; align-items: center; justify-content: space-between;
    padding: 14px 28px; margin: 0 -24px;
  }
  .app-header-left { width: auto; gap: 20px; }
  .app-logo-img { height: 52px; }
  .app-logo-fallback { width: 44px; height: 44px; font-size: 1.4rem; }
  .app-title p { font-size: 1rem; }
  .app-title .app-tagline { font-size: .72rem; }
  .app-header-actions { width: auto; }
  .app-header-actions .btn { flex: 0 0 auto; width: auto; height: auto; padding: 9px 18px; }
  .app-header-actions .btn-label { display: inline; margin-left: 2px; }
}
```

- [ ] **Step 5: Rewrite `.drop-zone` mobile-first in `css/style.css`**

Replace:
```css
/* ---- Drop zone ----------------------------------------------------- */
.drop-zone {
  border: 2px dashed var(--card-border);
  border-radius: var(--radius-xl); padding: 56px 24px;
  text-align: center; cursor: pointer; transition: var(--transition);
  background: var(--bg2); margin-bottom: 32px;
  user-select: none; position: relative; overflow: hidden;
}
```
with:
```css
/* ---- Drop zone ----------------------------------------------------- */
.drop-zone {
  border: 2px dashed var(--card-border);
  border-radius: var(--radius-xl); padding: 28px 16px;
  text-align: center; cursor: pointer; transition: var(--transition);
  background: var(--bg2); margin-bottom: 24px;
  user-select: none; position: relative; overflow: hidden;
}
@media (min-width: 768px) {
  .drop-zone { padding: 56px 24px; margin-bottom: 32px; }
}
.drop-title-touch { display: block; }
.drop-title-desktop { display: none; }
@media (min-width: 768px) {
  .drop-title-touch { display: none; }
  .drop-title-desktop { display: block; }
}
```
(Leave the rest of the `.drop-zone` block — `::after`, `:hover`, `.drop-icon`, `.drop-zone p`, `.drop-hint` — unchanged; only the base rule and the two new title-toggle rules are added.)

- [ ] **Step 6: Rewrite `.main-grid` mobile-first in `css/style.css`**

Replace:
```css
/* ---- Main grid ----------------------------------------------------- */
.main-grid { display: grid; grid-template-columns: 1fr 340px; gap: 28px; align-items: start; }
@media (max-width: 960px) { .main-grid { grid-template-columns: 1fr; } }
```
with:
```css
/* ---- Main grid ----------------------------------------------------- */
.main-grid { display: grid; grid-template-columns: 1fr; gap: 20px; align-items: start; }
@media (min-width: 960px) {
  .main-grid { grid-template-columns: 1fr 340px; gap: 28px; }
}
```

- [ ] **Step 7: Remove now-superseded rules from the existing mobile block**

In the `@media (max-width: 480px) { ... }` block near the end of the file, delete these three lines (they're now handled by the mobile-first base styles from Steps 3–5, and would otherwise conflict since 480px is narrower than the 768px tablet breakpoint):
```css
  .app-header { flex-direction: column; align-items: flex-start; gap: 10px; padding: 14px 18px; margin: 0 -14px; }
  .app-header > div:last-child { display: flex; width: 100%; gap: 8px; }
  .app-header > div:last-child .btn { flex: 1; justify-content: center; }
  .app-wrap { padding: 0 14px 60px; }
  .drop-zone { padding: 28px 14px; }
```
Leave the rest of that block (`.group-actions`, `.control-row`, `.review-file-row`, `.review-thumb`, `.seg-btn`, `.card-thumb`, `.viewer-themes`) untouched — those are unrelated to this task.

- [ ] **Step 8: Verify in the browser**

Start the dev server and open the preview:
```bash
python server.py 8744
```
Navigate to `http://localhost:8744/index.html`. Resize the viewport to **375×812** (phone) and confirm:
- Header shows logo+title on one row, and a second row with two 44×44px icon-only buttons (`+` and `⚙`, no visible text label).
- Drop zone heading reads "Tap to Browse Your Files".
- Order summary sidebar and file list are stacked in a single column.

Resize to **1280×800** (desktop) and confirm:
- Header is back to a single row with full-text buttons ("+ New Model Group", "⚙ Admin").
- Drop zone heading reads "Drop STL Files Here".
- The layout still renders two columns once files are added (verified fully in Task 2, since the sidebar is about to change).

- [ ] **Step 9: Commit**

```bash
git add index.html css/style.css
git commit -m "Rebuild header, drop zone, and main grid mobile-first"
```

---

### Task 2: Sticky bottom order-summary bar on mobile

**Files:**
- Modify: `index.html` (add `.mobile-summary-bar` markup after `.main-grid`)
- Modify: `css/style.css:303-309` (`.order-summary` — add hide-below-960 rule) and append new `.mobile-summary-bar` rules after that block
- Modify: `js/main.js:753-822` (`renderOrderSummary()`)
- Modify: `js/main.js:32-41` (`DOMContentLoaded` handler — wire the new button's click)

**Interfaces:**
- Consumes: `renderOrderSummary()` (existing function, called from `js/main.js:208` and `js/main.js:609` — no signature change), `openOrderForm()` (existing function defined at `js/main.js:944` — no signature change), `calcOrderTotal(activeGroups, config)` and `fmt(value, symbol)` (existing, imported from `calculator.js` at the top of `main.js` — no signature change).
- Produces: nothing new consumed by later tasks — this bar is self-contained.

- [ ] **Step 1: Add the mobile summary bar markup to `index.html`**

Immediately after the closing `</div>` of `.main-grid` (and still inside `.app-wrap`, before its own closing `</div><!-- /.app-wrap -->`), add:
```html
  <div class="mobile-summary-bar empty" id="mobile-summary-bar">
    <div class="mobile-summary-info">
      <span class="mobile-summary-count" id="mobile-summary-count">0 items</span>
      <span class="mobile-summary-total" id="mobile-summary-total">—</span>
    </div>
    <button class="btn btn-primary btn-sm" id="mobile-summary-btn">Review Order →</button>
  </div>
```
It starts with the `empty` class so it's hidden before any files are uploaded (see CSS in Step 2).

- [ ] **Step 2: Add CSS for the sticky bar and hide the sidebar on mobile**

In `css/style.css`, immediately after the existing `.order-summary { ... }` rule block (ends at line 309 in the pre-change file, right before `.summary-title`), add:
```css
@media (max-width: 959px) {
  .order-summary { display: none; }
}

.mobile-summary-bar {
  display: none;
}
@media (max-width: 959px) {
  .mobile-summary-bar {
    display: flex; align-items: center; justify-content: space-between;
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 50;
    background: var(--bg2); border-top: 2px solid var(--accent);
    padding: 10px 16px; gap: 12px;
    box-shadow: 0 -4px 16px rgba(0,0,0,.12);
  }
  .mobile-summary-bar.empty { display: none; }
  .app-wrap { padding-bottom: 84px; }
}
.mobile-summary-info { display: flex; flex-direction: column; line-height: 1.25; }
.mobile-summary-count { font-size: .7rem; color: var(--text-dim); }
.mobile-summary-total { font-size: 1.05rem; font-weight: 700; color: var(--accent); }
```

- [ ] **Step 3: Update `renderOrderSummary()` in `js/main.js` to also populate the bar**

Replace the function body (currently `js/main.js:755-822`):
```javascript
function renderOrderSummary() {
  const panel = document.getElementById('order-summary');
  if (!panel) return;
  const sym = config.currencySymbol;

  const activeGroups = groups.filter(g => g.items.some(i => i.status === 'ready'));

  if (!activeGroups.length) {
    panel.innerHTML = `<h2 class="summary-title">Order Summary</h2>
      <p class="summary-empty">Upload STL files to see pricing.</p>`;
    return;
  }
```
with:
```javascript
function renderOrderSummary() {
  const panel     = document.getElementById('order-summary');
  const mobileBar = document.getElementById('mobile-summary-bar');
  const sym = config.currencySymbol;

  const activeGroups = groups.filter(g => g.items.some(i => i.status === 'ready'));

  if (!activeGroups.length) {
    if (panel) panel.innerHTML = `<h2 class="summary-title">Order Summary</h2>
      <p class="summary-empty">Upload STL files to see pricing.</p>`;
    mobileBar?.classList.add('empty');
    return;
  }
```
Then, further down the same function, immediately before the final line `document.getElementById('request-quote-btn')?.addEventListener('click', openOrderForm);`, insert:
```javascript
  if (mobileBar) {
    mobileBar.classList.remove('empty');
    const itemCount = activeGroups.reduce(
      (n, g) => n + g.items.filter(i => i.status === 'ready').length, 0
    );
    document.getElementById('mobile-summary-count').textContent =
      `${itemCount} item${itemCount === 1 ? '' : 's'}`;
    document.getElementById('mobile-summary-total').textContent = fmt(grandTotal, sym);
  }
```
Also change the two lines that write to `panel.innerHTML` in the non-empty branch (the `panel.innerHTML = \`...\`` block that builds `.summary-title`/`.summary-groups`/etc.) to guard with `if (panel)` the same way, since `panel` is no longer assumed non-null:
```javascript
  if (panel) panel.innerHTML = `
    <h2 class="summary-title">Order Summary</h2>
    <div class="summary-groups">${groupLines}</div>
    ${minAdjust > 0 ? `
    <div class="summary-line summary-line-extra">
      <span class="sum-name" style="color:var(--text-dim)">📋 Minimum order (${fmt(config.minimumItemCost, sym)})</span><span></span>
      <span class="sum-price">+${fmt(minAdjust, sym)}</span>
    </div>` : ''}
    <div class="summary-divider"></div>
    <div class="summary-total"><span>Grand Total</span><span>${fmt(grandTotal, sym)}</span></div>
    <p class="summary-note">💡 Estimate only — final price confirmed after file review.</p>
    <button class="btn btn-primary btn-lg" id="request-quote-btn">Request a Quote →</button>
  `;
  document.getElementById('request-quote-btn')?.addEventListener('click', openOrderForm);
```

- [ ] **Step 4: Wire the mobile bar's button once at boot**

In `js/main.js`, inside the existing `document.addEventListener('DOMContentLoaded', () => { ... })` block (`js/main.js:32-41`), add one line after `setupOrderForm();`:
```javascript
  document.getElementById('mobile-summary-btn')?.addEventListener('click', openOrderForm);
```

- [ ] **Step 5: Verify in the browser**

With the dev server running (`python server.py 8744`), open `http://localhost:8744/index.html` at **375×812**:
- Confirm no bar is visible before uploading any file.
- Drop an STL file (any small test `.stl`). Once it finishes analyzing, confirm the bottom bar appears showing "1 item" and the correct total, and the sidebar (`.order-summary`) is not visible.
- Tap "Review Order →" and confirm it opens the same order-review overlay as clicking the desktop "Request a Quote →" button does.
- Remove the file and confirm the bar disappears again.

Resize to **1280×800** and confirm the bar never appears — the sidebar shows instead, exactly as before this task.

- [ ] **Step 6: Commit**

```bash
git add index.html css/style.css js/main.js
git commit -m "Add sticky mobile order-summary bar"
```

---

### Task 3: Always-visible, touch-sized file-card remove button

**Files:**
- Modify: `css/style.css:181-189` (`.card-remove-x` and its hover rules)
- Modify: `css/style.css:213-216` (`.card-filename` — padding to clear the larger button)

**Interfaces:**
- Consumes: nothing (pure CSS; the button's `data-action="remove-item"` click handling in `js/main.js` around line 524 is unchanged).
- Produces: a new `@media (max-width: 767px) { ... }` block in `css/style.css` — Task 5 will append further rules into this same block rather than creating a duplicate.

- [ ] **Step 1: Make the remove button always visible and add a mobile-sized variant**

Replace:
```css
.card-remove-x {
  position: absolute; top: 10px; right: 12px;
  background: rgba(220,38,38,.08); border: none; color: var(--red);
  cursor: pointer; width: 28px; height: 28px; border-radius: 50%;
  font-size: .8rem; display: flex; align-items: center; justify-content: center;
  opacity: 0; transition: opacity var(--transition), background var(--transition); z-index: 2;
}
.file-card:hover .card-remove-x { opacity: 1; }
.card-remove-x:hover { background: rgba(220,38,38,.2); }
```
with:
```css
.card-remove-x {
  position: absolute; top: 8px; right: 8px;
  background: rgba(220,38,38,.08); border: none; color: var(--red);
  cursor: pointer; width: 32px; height: 32px; border-radius: 50%;
  font-size: .85rem; display: flex; align-items: center; justify-content: center;
  transition: background var(--transition); z-index: 2;
}
.card-remove-x:hover, .card-remove-x:focus-visible { background: rgba(220,38,38,.2); }

@media (max-width: 767px) {
  .card-remove-x { width: 44px; height: 44px; font-size: 1rem; }
}
```
Note this deliberately drops `opacity: 0` / the `.file-card:hover` opacity rule entirely — the button is now always visible at every width (not just mobile), which also fixes keyboard-only users never being able to see/focus it before this change.

- [ ] **Step 2: Give the filename room to clear the larger button**

Replace:
```css
.card-filename {
  font-size: .95rem; font-weight: 600; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 32px;
}
```
with:
```css
.card-filename {
  font-size: .95rem; font-weight: 600; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 36px;
}
@media (max-width: 767px) {
  .card-filename { padding-right: 52px; }
}
```

- [ ] **Step 3: Verify in the browser**

With the dev server running, open `http://localhost:8744/index.html`, drop in 2–3 test STL files.
- At **1280×800**: confirm each file card's ✕ button is visible without hovering (previously it was invisible until hover — this is the fix).
- At **375×812**: confirm the ✕ button is visibly larger (44×44px) and the filename text doesn't run underneath it.
- Click/tap ✕ on one card at each width and confirm the file is removed.

- [ ] **Step 4: Commit**

```bash
git add css/style.css
git commit -m "Make file-card remove button always visible with a touch-sized target"
```

---

### Task 4: Mobile-first bottom-sheet overlays + confirm 3D touch controls

**Files:**
- Modify: `css/style.css:333-346` (`.modal-backdrop`, `.modal-panel`)
- Modify: `css/style.css:395-407` (`.order-overlay`, `.order-panel`)
- Modify: `css/style.css:692-701` (existing `@media (max-width: 600px)` block — remove, now superseded)

**Interfaces:**
- Consumes: nothing (pure CSS; no JS changes — `js/viewer.js`'s `OrbitControls` usage is unchanged and already handles touch).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Make the 3D viewer modal a bottom sheet by default, centered panel at tablet+**

Replace:
```css
.modal-backdrop {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(5,4,3,.88); backdrop-filter: blur(4px);
  display: none; align-items: center; justify-content: center; padding: 20px;
}
.modal-backdrop.open { display: flex; }

.modal-panel {
  background: #0d0b08; border: 1px solid #3a2e22; border-top: 2px solid #e8660a;
  border-radius: var(--radius-lg);
  width: 100%; max-width: 940px; height: min(90vh, 700px);
  display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 8px 40px rgba(0,0,0,.65), 0 0 24px rgba(232,102,10,.12);
}
```
with:
```css
.modal-backdrop {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(5,4,3,.88); backdrop-filter: blur(4px);
  display: none; align-items: flex-end; justify-content: center; padding: 0;
}
.modal-backdrop.open { display: flex; }

.modal-panel {
  background: #0d0b08; border: 1px solid #3a2e22; border-top: 2px solid #e8660a;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  width: 100%; max-width: 100%; height: 95vh;
  display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 8px 40px rgba(0,0,0,.65), 0 0 24px rgba(232,102,10,.12);
}
@media (min-width: 600px) {
  .modal-backdrop { align-items: center; padding: 20px; }
  .modal-panel {
    border-radius: var(--radius-lg);
    max-width: 940px; height: min(90vh, 700px);
  }
}
```

- [ ] **Step 2: Make the order-form overlay a bottom sheet by default, centered panel at tablet+**

Replace:
```css
.order-overlay {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(5,4,3,.55); backdrop-filter: blur(4px);
  display: none; align-items: center; justify-content: center; padding: 20px;
}
.order-overlay.open { display: flex; }
.order-panel {
  background: var(--bg2); border: 1px solid var(--card-border-h);
  border-top: 3px solid var(--accent);
  border-radius: var(--radius-lg); width: 100%; max-width: 640px;
  max-height: 92vh; overflow-y: auto;
  box-shadow: var(--shadow-lg), var(--glow);
}
```
with:
```css
.order-overlay {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(5,4,3,.55); backdrop-filter: blur(4px);
  display: none; align-items: flex-end; justify-content: center; padding: 0;
}
.order-overlay.open { display: flex; }
.order-panel {
  background: var(--bg2); border: 1px solid var(--card-border-h);
  border-top: 3px solid var(--accent);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  width: 100%; max-width: 100%;
  max-height: 95vh; overflow-y: auto;
  box-shadow: var(--shadow-lg), var(--glow);
}
@media (min-width: 600px) {
  .order-overlay { align-items: center; padding: 20px; }
  .order-panel { border-radius: var(--radius-lg); max-width: 640px; max-height: 92vh; }
}
```

- [ ] **Step 3: Remove the now-superseded mobile overrides**

In the `@media (max-width: 600px) { ... }` block, delete it entirely — both rules it contained (`.order-overlay`/`.order-panel` and `.modal-panel`) are now the mobile-first *base* styles from Steps 1–2:
```css
@media (max-width: 600px) {
  .order-overlay { padding: 0; align-items: flex-end; }
  .order-panel {
    max-width: 100%; max-height: 95vh;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    border-left: none; border-right: none; border-bottom: none;
  }
  .modal-panel { border-radius: var(--radius-lg) var(--radius-lg) 0 0; height: 95vh; max-height: none; }
}
```

- [ ] **Step 4: Verify bottom-sheet behavior and 3D touch controls in the browser**

With the dev server running, open `http://localhost:8744/index.html` at **375×812**:
- Drop a small STL file, tap its thumbnail to open the 3D viewer modal. Confirm it slides up as a bottom sheet filling ~95% of the viewport height, not a centered floating panel.
- Drag on the canvas and confirm the model rotates (this exercises `OrbitControls`' touch-rotate handling — no code change was made here, this step only confirms nothing regressed).
- Close it, add the file to an order, and open the order-review overlay from the sticky bar. Confirm it's also a bottom sheet.

Resize to **1280×800** and re-open both overlays — confirm they're back to centered floating panels (940px / 640px max-width respectively), matching the pre-existing desktop appearance.

- [ ] **Step 5: Commit**

```bash
git add css/style.css
git commit -m "Convert viewer and order-form overlays to mobile-first bottom sheets"
```

---

### Task 5: Touch-target sizing audit for remaining controls

**Files:**
- Modify: `css/style.css` (append a new rule block; does not modify any existing rule)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add a touch-target sizing block**

Append this new block to the end of `css/style.css` (after the existing `@media (max-width: 480px) { ... }` block, before the `/* ---- Utilities ---- */` section):
```css
/* ---- Touch target sizing ------------------------------------------- */
@media (max-width: 767px) {
  .seg-btn { min-height: 44px; }
  .btn-sm  { min-height: 36px; }
  .scale-preset { min-height: 32px; padding: 6px 12px; }
  input[type="number"], input[type="text"], input[type="email"], select {
    min-height: 40px;
  }
  .modal-header .btn-sm, .order-panel-header .btn-sm { min-width: 44px; min-height: 36px; }
}
```

- [ ] **Step 2: Verify in the browser**

With the dev server running, open `http://localhost:8744/index.html` at **375×812**, drop a file, and expand a group's settings:
- Confirm the material/support/assembly segmented buttons (`.seg-btn`) are comfortably tappable (visually taller than before).
- Confirm scale-preset pills and number inputs (scale, quantity) have a bit more vertical padding and are easier to tap without missing.
- Open the 3D modal and the order-review overlay; confirm their header close/back buttons are easy to tap.

At **1280×800**, confirm none of these controls changed size (the rule only applies below 768px).

- [ ] **Step 3: Commit**

```bash
git add css/style.css
git commit -m "Increase touch-target sizing for form controls on mobile"
```

---

### Task 6: End-to-end mobile verification pass

**Files:**
- None (verification-only task; no code changes).

**Interfaces:**
- Consumes: the complete feature set from Tasks 1–5.

- [ ] **Step 1: Full flow at phone width**

Start the dev server (`python server.py 8744`), open `http://localhost:8744/index.html`, resize to **375×812**, and walk the entire customer flow:
1. Confirm the empty state (drop zone + "Tap to Browse Your Files" heading) renders with no sticky bar visible.
2. Add 2 STL files to the default group. Confirm cards render stacked, thumbnail over info, each with a visible 44px ✕ button.
3. Confirm the sticky bottom bar appears with the correct item count and total, and updates live when you change a quantity or scale.
4. Tap a card thumbnail, confirm the 3D viewer opens as a bottom sheet, and drag to rotate the model.
5. Close the viewer, tap "Review Order →" on the sticky bar, confirm the order-review bottom sheet opens with correct totals, continue to the contact form, fill it in, and submit — confirm the success screen appears.
6. Remove a file via its ✕ button and confirm the sticky bar total updates (or disappears if no files remain).

- [ ] **Step 2: Regression check at tablet and desktop widths**

Resize to **768×1024** and then **1280×800**. At both widths, confirm:
- Header is a single row with full-text buttons.
- The order summary is the sidebar (not the sticky bar), and it stays in sync with totals.
- The 3D viewer and order-review overlays are centered floating panels, not bottom sheets.
- Nothing from Tasks 1–5 broke the existing desktop appearance.

- [ ] **Step 3: Fix any issues found, then commit**

If any check in Steps 1–2 fails, fix the specific CSS/markup/JS from the relevant task above (do not add new scope), re-run that check, and only then commit:
```bash
git add -A
git commit -m "Fix mobile verification issues" --allow-empty
```
(Use `--allow-empty` only if verification found nothing to fix and this step is a no-op checkpoint; omit it if real fixes were made.)

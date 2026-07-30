# Resin Tiered Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the continuous per-ml resin pricing formula with fixed price tiers by physical size, plus a Model Type selector that governs which add-ons (Base, Extras) are relevant to a given upload.

**Architecture:** Two data/logic layers change (`js/config.js`, `js/calculator.js`), then the UI layer (`js/main.js`, `index.html`) is updated to expose Model Type, Extras, and per-model Notes, and to replace the old volume/markup cost breakdown with tier-based pricing. No changes to `js/stl-parser.js` or `js/viewer.js`.

**Tech Stack:** Vanilla HTML/CSS/JS, no build step, no test framework (verification is manual, in-browser).

## Global Constraints

- No changes to `js/stl-parser.js` or `js/viewer.js`.
- `admin.html`/`js/admin.js` are explicitly out of scope (desktop-only, established convention for this project). After this plan, `admin.js`'s form fields for the removed config knobs (`resinCostPerMl`, `supportMaterial`, `machineHourlyCost`, `printSpeedMlPerHour`, `markupPercentage`, `minimumItemCost`, `labourBaseFee`) will read/write stale, functionally-unused values — this is a known, accepted side effect, not a bug to fix here. `admin.html` is slated for full replacement by a Shopify-metaobject-backed editor in a separate, already-discussed future project.
- `server.py` sends `Cache-Control: no-cache, no-store` on every response, so the `?v=N` cache-busting query strings don't affect *this plan's own local verification* — they only matter for production deployment (returning visitors on a real host caching aggressively). Don't bump them after every task; Task 6 (the last task touching `js/main.js`) has a single dedicated step that bumps every version reference this whole plan touches, once, at the end.
- No automated test suite exists for this project — every task's verification step is a manual, scripted check in the browser preview (`python server.py 8744`), using real `.stl` test files where called for.
- Currency formatting, dimension formatting (`fmt`, `fmtMm`), and the `esc()` HTML-escaping helper in `js/main.js` are unchanged — reuse them, don't reinvent them.

---

### Task 1: Config schema — size tiers, model types, extras, build plate

**Files:**
- Modify (full rewrite): `js/config.js`

**Interfaces:**
- Produces: `DEFAULT_CONFIG.sizeTiers: [{name, maxDimensionMm, price}]` (ascending), `DEFAULT_CONFIG.maxPlatePrice: number`, `DEFAULT_CONFIG.buildPlate: {x, y, z, supportMarginPct}`, `DEFAULT_CONFIG.materialSurcharges: {[materialId]: percentNumber}`, `DEFAULT_CONFIG.modelTypes: [{id, name, basesIncluded, availableExtras: [extraId]}]`, `DEFAULT_CONFIG.extras: [{id, name, price}]`, `DEFAULT_CONFIG.customQuoteOrderThreshold: number`. `getConfig()`/`saveConfig()`/`resetConfig()`/`getMaterial()` signatures unchanged.
- Consumes: nothing (this is the base data layer).

- [ ] **Step 1: Replace `js/config.js` in full**

```javascript
// ============================================================
// config.js — Pricing configuration with localStorage persistence
// For Shopify: replace localStorage with Shopify metafields API
// ============================================================

const CONFIG_KEY = 'stl_calc_config_v1';

export const DEFAULT_CONFIG = {
  // --- Size tiers (resin) ---
  // A model's tier is decided by its LARGEST single scaled dimension (mm).
  // Ascending by maxDimensionMm. A model bigger than the last tier falls
  // back to the build-plate check (maxPlatePrice); if it doesn't fit the
  // plate either, it cannot be auto-priced at all.
  sizeTiers: [
    { name: 'XS',      maxDimensionMm: 15,  price: 1  },
    { name: 'Small',   maxDimensionMm: 30,  price: 3  },
    { name: 'Regular', maxDimensionMm: 50,  price: 6  },
    { name: 'Large',   maxDimensionMm: 100, price: 15 },
    { name: 'Large+',  maxDimensionMm: 120, price: 21 },
    { name: 'XL',      maxDimensionMm: 150, price: 30 },
    { name: 'XL+',     maxDimensionMm: 180, price: 45 },
  ],
  maxPlatePrice: 60,   // price for a model bigger than XL+ but still fits the build plate

  // --- Build plate (physical fit check) ---
  buildPlate: {
    x: 211.68, y: 118.37, z: 220,
    supportMarginPct: 20,   // usable space is reduced by this % to leave room for supports
  },

  // --- Assembly (unchanged) ---
  assemblyBase:        5.00,
  assemblyPerJoint:    3.50,
  assemblyMax:         40.00,

  // --- Primer (unchanged) ---
  primerMaterialCost:       5.00,
  primerLabourMultiplier:   0.50,
  primerLabourMin:          1.50,
  primerLabourMax:          12.00,

  // --- Resin material surcharges ---
  // % added on top of the tier price for non-standard resins.
  materialSurcharges: {
    standard: 0,
    tough:    15,
    flexible: 20,
    castable: 25,
    dental:   35,
  },

  // --- Model types (govern which add-ons are relevant) ---
  modelTypes: [
    { id: 'mini-base-included', name: 'Miniature — base included', basesIncluded: true,  availableExtras: ['wings', 'weapon', 'banner'] },
    { id: 'mini-base-separate', name: 'Miniature — base separate', basesIncluded: false, availableExtras: ['wings', 'weapon', 'banner'] },
    { id: 'bust',               name: 'Display piece / bust',      basesIncluded: false, availableExtras: ['banner'] },
    { id: 'terrain',            name: 'Terrain / scenery',         basesIncluded: true,  availableExtras: [] },
    { id: 'other',              name: 'Other',                     basesIncluded: false, availableExtras: ['wings', 'weapon', 'banner', 'shield'] },
  ],

  // --- Extras (flat, fixed-price add-ons) ---
  extras: [
    { id: 'wings',  name: 'Wings',          price: 3.00 },
    { id: 'weapon', name: 'Sword / Weapon', price: 1.50 },
    { id: 'shield', name: 'Shield',         price: 1.50 },
    { id: 'banner', name: 'Banner',         price: 2.50 },
  ],

  // --- Order guardrail ---
  customQuoteOrderThreshold: 150.00,

  // --- Display ---
  currency:        'GBP',
  currencySymbol:  '£',
  businessName:    'Arcane Flame',
  businessEmail:   'orders@arcane-flame.com',
  showCostBreakdown: true,

  // --- Admin access (client-side only) ---
  adminPassword:   'admin123',

  // --- Materials ---
  materials: [
    { id: 'standard',  name: 'Standard Resin',  color: '#b0c4de', description: 'Great for display models' },
    { id: 'tough',     name: 'Tough Resin',      color: '#7ec8e3', description: 'Impact-resistant parts' },
    { id: 'flexible',  name: 'Flexible Resin',   color: '#f0a830', description: 'Bendable / rubber-like' },
    { id: 'castable',  name: 'Castable Resin',   color: '#ffd700', description: 'Lost-wax casting' },
    { id: 'dental',    name: 'Dental/Medical',   color: '#e8d5c4', description: 'Biocompatible grade' },
  ],

  // --- Primer options (label only — cost controlled by fields above) ---
  primerOptions: [
    { id: 'unprimed', label: 'Unprimed' },
    { id: 'black',    label: 'Black Primer' },
    { id: 'grey',     label: 'Grey Primer' },
    { id: 'white',    label: 'White Primer' },
  ],
};

export function getConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      return {
        ...DEFAULT_CONFIG,
        ...saved,
        materials:     saved.materials?.length     ? saved.materials     : DEFAULT_CONFIG.materials,
        primerOptions: saved.primerOptions?.length  ? saved.primerOptions : DEFAULT_CONFIG.primerOptions,
        sizeTiers:     saved.sizeTiers?.length      ? saved.sizeTiers     : DEFAULT_CONFIG.sizeTiers,
        modelTypes:    saved.modelTypes?.length     ? saved.modelTypes    : DEFAULT_CONFIG.modelTypes,
        extras:        saved.extras?.length         ? saved.extras       : DEFAULT_CONFIG.extras,
      };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); return true; }
  catch (e) { console.error('Config save failed:', e); return false; }
}

export function resetConfig() {
  localStorage.removeItem(CONFIG_KEY);
  return { ...DEFAULT_CONFIG };
}

export function getMaterial(config, materialId) {
  return config.materials.find(m => m.id === materialId) ?? config.materials[0];
}
```

- [ ] **Step 2: Verify no syntax errors**

Start the dev server and confirm the page loads without a console error:
```bash
python server.py 8744
```
Open `http://localhost:8744/index.html`, check the browser console (`read_console_messages` if using the browser tool, or DevTools console otherwise) — expect no red errors. The page will look unchanged (this task only touches data, not UI) except the drop zone/order summary render as before with no files uploaded.

- [ ] **Step 3: Commit**

```bash
git add js/config.js
git commit -m "Replace continuous pricing config with size tiers, model types, extras"
```

---

### Task 2: Calculator rewrite — tier lookup, build-plate fit check, cost formulas

**Files:**
- Modify (full rewrite): `js/calculator.js`

**Interfaces:**
- Consumes: `config.sizeTiers`, `config.maxPlatePrice`, `config.buildPlate`, `config.materialSurcharges`, `config.extras`, `config.customQuoteOrderThreshold` (from Task 1). `getMaterial(config, materialId)` from `config.js` (unchanged import).
- Produces:
  - `fitsBuildPlate(dims, buildPlate)` → `boolean`. `dims` is `{x, y, z}` in mm.
  - `calcSizeTier(dims, config)` → `{name, maxDimensionMm, price}` or `null` (doesn't fit anything, even the build plate).
  - `calcItemCost(stlData, settings, config)` → same call signature as before. New return shape: `{ scale, quantity, materialName, presupported, scaledDims, scaledVolumeMl, tier, fitsBuildPlate, surchargePct, surchargeAmount, unitCost, totalCost }`. When `tier` is `null`: `fitsBuildPlate: false`, `unitCost: 0`, `totalCost: 0`, no `surchargeAmount`.
  - `calcGroupCost(items, groupSettings, config)` → same call signature. New return shape: `{ fileSubtotal, totalVolumeMl, totalPartCount, oversizedCount, extrasCost, assemblyCost, primerMaterial, primerLabour, primerTotal, groupTotal, isPrimed, primerLabel }` — **no more `labourBase`** (dropped).
  - `calcOrderTotal(groups)` → `number`. **Signature change: no longer takes `config`** (no floor logic left to need it) — a second argument is harmless (JS ignores extra args) so existing call sites that still pass `config` won't break, but new code should call it with one argument.
  - `exceedsCustomQuoteThreshold(grandTotal, config)` → `boolean` (new function).
  - `calcAssemblyCost(partCount, config)`, `calcPrimerCost(totalVolumeMl, primerType, config)`, `fmt`, `fmtMl`, `fmtMm`, `fmtHours` — **unchanged**, keep exactly as they are today.

- [ ] **Step 1: Replace `js/calculator.js` in full**

```javascript
// ============================================================
// calculator.js — Pricing engine
// Fixed size-tier pricing for resin bodies/bases, flat extras,
// unchanged assembly/primer add-ons.
// ============================================================

import { getMaterial } from './config.js?v=7';

// ---- Build plate fit check --------------------------------------------

/**
 * Does a model (any orientation) fit the printer's build plate, after
 * reducing the plate by supportMarginPct to leave room for supports?
 * Sorts both the model's dims and the plate's dims ascending and compares
 * pairwise, so rotation on the plate is accounted for.
 */
export function fitsBuildPlate(dims, buildPlate) {
  const margin = 1 - (buildPlate.supportMarginPct ?? 0) / 100;
  const usable = [buildPlate.x, buildPlate.y, buildPlate.z].map(v => v * margin).sort((a, b) => a - b);
  const model  = [dims.x, dims.y, dims.z].sort((a, b) => a - b);
  return model[0] <= usable[0] && model[1] <= usable[1] && model[2] <= usable[2];
}

// ---- Size tier lookup ---------------------------------------------------

/**
 * Decide a model's price tier from its largest scaled dimension.
 * Returns null if it exceeds every defined tier AND doesn't fit the
 * build plate even with the support margin — i.e. cannot be auto-priced.
 */
export function calcSizeTier(dims, config) {
  const largest = Math.max(dims.x, dims.y, dims.z);
  for (const tier of config.sizeTiers) {
    if (largest <= tier.maxDimensionMm) {
      return { name: tier.name, maxDimensionMm: tier.maxDimensionMm, price: tier.price };
    }
  }
  if (fitsBuildPlate(dims, config.buildPlate)) {
    return { name: 'Max Plate', maxDimensionMm: null, price: config.maxPlatePrice };
  }
  return null;
}

// ---- Per-file cost ---------------------------------------------------

export function calcItemCost(stlData, settings, config) {
  const { scale = 1.0, quantity = 1, materialId, presupported = false } = settings;
  const material = getMaterial(config, materialId);

  const scaledDims = {
    x: stlData.dimensions.x * scale,
    y: stlData.dimensions.y * scale,
    z: stlData.dimensions.z * scale,
  };
  const scaledVolumeMl = stlData.volumeMl * Math.pow(scale, 3);

  const tier = calcSizeTier(scaledDims, config);
  const surchargePct = config.materialSurcharges?.[materialId] ?? 0;

  if (!tier) {
    return {
      scale, quantity,
      materialName: material.name,
      presupported,
      scaledDims, scaledVolumeMl,
      tier: null,
      fitsBuildPlate: false,
      surchargePct,
      unitCost: 0,
      totalCost: 0,
    };
  }

  const surchargeAmount = tier.price * (surchargePct / 100);
  const unitCost  = tier.price + surchargeAmount;
  const totalCost = unitCost * quantity;

  return {
    scale, quantity,
    materialName: material.name,
    presupported,
    scaledDims, scaledVolumeMl,
    tier,
    fitsBuildPlate: true,
    surchargePct,
    surchargeAmount,
    unitCost,
    totalCost,
  };
}

// ---- Assembly cost (unchanged) ----------------------------------------
// Joints = parts - 1. First joint costs assemblyBase, each extra costs assemblyPerJoint.

export function calcAssemblyCost(partCount, config) {
  if (partCount <= 1) return 0;
  const joints     = partCount - 1;
  const firstJoint = config.assemblyBase;
  const extraJoints = Math.max(0, joints - 1) * config.assemblyPerJoint;
  return Math.min(firstJoint + extraJoints, config.assemblyMax);
}

// ---- Primer cost (unchanged) ------------------------------------------
// Material: flat fee per model group. Labour: scales with volume^(2/3)
// as a surface-area proxy, capped.

export function calcPrimerCost(totalVolumeMl, primerType, config) {
  if (!primerType || primerType === 'unprimed') {
    return { material: 0, labour: 0, total: 0 };
  }
  const material = config.primerMaterialCost;
  const labour   = Math.max(
    config.primerLabourMin,
    Math.min(
      Math.pow(Math.max(totalVolumeMl, 0.1), 2 / 3) * config.primerLabourMultiplier,
      config.primerLabourMax
    )
  );
  return { material, labour, total: material + labour };
}

// ---- Group-level cost --------------------------------------------------

export function calcGroupCost(items, groupSettings, config) {
  const readyItems     = items.filter(i => i.status === 'ready' && i.cost);
  const priceableItems = readyItems.filter(i => i.cost.tier);
  const oversizedCount = readyItems.length - priceableItems.length;

  const fileSubtotal   = priceableItems.reduce((s, i) => s + i.cost.totalCost, 0);
  const totalVolumeMl  = priceableItems.reduce((s, i) => s + i.cost.scaledVolumeMl * i.settings.quantity, 0);
  const totalPartCount = priceableItems.reduce((s, i) => s + i.settings.quantity, 0);

  const { assembly = false, primer = 'unprimed', extras = [] } = groupSettings;

  const extrasCost = extras.reduce((s, extraId) => {
    const extra = config.extras.find(e => e.id === extraId);
    return s + (extra ? extra.price : 0);
  }, 0);

  const assemblyCost = assembly ? calcAssemblyCost(totalPartCount, config) : 0;
  const primerResult = calcPrimerCost(totalVolumeMl, primer, config);

  const groupTotal = fileSubtotal + extrasCost + assemblyCost + primerResult.total;

  return {
    fileSubtotal,
    totalVolumeMl,
    totalPartCount,
    oversizedCount,
    extrasCost,
    assemblyCost,
    primerMaterial: primerResult.material,
    primerLabour:   primerResult.labour,
    primerTotal:    primerResult.total,
    groupTotal,
    isPrimed:    primer !== 'unprimed',
    primerLabel: primer,
  };
}

// ---- Order total -----------------------------------------------------

export function calcOrderTotal(groups) {
  return groups.reduce((s, g) => s + (g.groupCost?.groupTotal ?? 0), 0);
}

export function exceedsCustomQuoteThreshold(grandTotal, config) {
  return grandTotal >= config.customQuoteOrderThreshold;
}

// ---- Formatters -------------------------------------------------------

export function fmt(amount, symbol = '£') {
  return `${symbol}${amount.toFixed(2)}`;
}
export function fmtMl(ml) {
  return ml < 1 ? `${(ml * 1000).toFixed(1)} µL` : `${ml.toFixed(2)} mL`;
}
export function fmtMm(mm) { return `${mm.toFixed(1)} mm`; }
export function fmtHours(h) {
  if (h < 1 / 60) return '<1 min';
  if (h < 1)      return `${Math.round(h * 60)} min`;
  return `${h.toFixed(1)} hr`;
}
```

- [ ] **Step 2: Verify tier math directly in the browser console**

With the dev server running, open `http://localhost:8744/index.html`, open the browser console, and run (the `cb=` query param is just cache-busting for this one-off check — use any unique value):
```javascript
const cb = Date.now();
const { calcSizeTier } = await import(`/js/calculator.js?cb=${cb}`);
const { DEFAULT_CONFIG } = await import(`/js/config.js?cb=${cb}`);
console.log(calcSizeTier({x:25.4,y:25.4,z:38.1}, DEFAULT_CONFIG));
```
Expected: `{ name: 'Regular', maxDimensionMm: 50, price: 6 }` (matches the Hero Forge mini's real dimensions from earlier testing — largest side 38.1mm fits the 50mm Regular tier at £6).

```javascript
console.log(calcSizeTier({x:63.3,y:59.7,z:107.4}, DEFAULT_CONFIG));
```
Expected: `{ name: 'Large+', maxDimensionMm: 120, price: 21 }` — largest side 107.4mm exceeds the 100mm "Large" tier's limit but fits within "Large+"'s 120mm limit. This tells you the DM Stash 75mm body alone is a Large+ tier item (£21); combined with its base's own tier, the group total should approach the ~£40 target once you re-run the full order in Task 7's verification.

- [ ] **Step 3: Commit**

```bash
git add js/calculator.js
git commit -m "Rewrite pricing engine for fixed size tiers, drop per-ml formula"
```

---

### Task 3: Group settings UI — Model Type selector, Extras checklist, per-model Notes

**Files:**
- Modify: `js/main.js` — `defaultGroupSettings()` (~line 63), `buildGroupHTML()` (~line 241), `handleGroupChange()` (~line 576), `handleGroupInput()` (~line 618)
- Modify: `css/style.css` — append new rules for `.extras-list`, `.extra-row`, `.group-notes`

**Interfaces:**
- Consumes: `config.modelTypes`, `config.extras` (Task 1). `calcGroupCost`/`recomputeGroup` (unchanged signatures from Task 2).
- Produces: `group.settings.modelType: string`, `group.settings.extras: string[]`, `group.settings.notes: string` — read by Task 6 (review screen + submit payload).

- [ ] **Step 1: Update `defaultGroupSettings()` in `js/main.js`**

Replace:
```javascript
function defaultGroupSettings() {
  return { assembly: false, primer: 'unprimed' };
}
```
with:
```javascript
function defaultGroupSettings() {
  return {
    assembly: false,
    primer: 'unprimed',
    modelType: config.modelTypes[0].id,
    extras: [],
    notes: '',
  };
}
```

- [ ] **Step 2: Add Model Type + Extras + Notes markup in `buildGroupHTML()`**

Find the start of `buildGroupHTML(group)` and add these two local variables right after the existing `assemblyActive` line:
```javascript
  const selectedType = config.modelTypes.find(t => t.id === group.settings.modelType) ?? config.modelTypes[0];
  const modelTypeOptions = config.modelTypes.map(t =>
    `<option value="${esc(t.id)}" ${t.id === selectedType.id ? 'selected' : ''}>${esc(t.name)}</option>`
  ).join('');
  const extrasHTML = selectedType.availableExtras.length ? `
    <div class="extras-list">
      ${selectedType.availableExtras.map(extraId => {
        const extra = config.extras.find(e => e.id === extraId);
        if (!extra) return '';
        const checked = (group.settings.extras || []).includes(extraId);
        return `<label class="extra-row">
          <input type="checkbox" data-action="extra-toggle" data-extra-id="${esc(extra.id)}" ${checked ? 'checked' : ''}>
          <span>${esc(extra.name)}</span>
          <span class="extra-price">+${fmt(extra.price, sym)}</span>
        </label>`;
      }).join('')}
    </div>` : '';
```

Then, inside the `<div class="group-settings">` block, add a new `group-setting-block` as the FIRST block (before Primer Coating):
```html
      <div class="group-setting-block">
        <div class="group-setting-label">🧩 Model Type</div>
        <div class="group-setting-desc">
          Tells us what kind of model this is, so we show the right add-ons.
        </div>
        <select class="model-type-select" data-action="model-type">
          ${modelTypeOptions}
        </select>
        ${!selectedType.basesIncluded ? `<div class="control-hint">📎 Need a base? Upload it as an extra file using "Add Files to This Model" below — it's priced by size, same as the body.</div>` : ''}
        ${extrasHTML}
      </div>
```

Then, immediately after the closing `</div>` of `.group-settings` and before `<div class="group-items">`, add the notes block:
```html
    <div class="group-notes">
      <label class="group-notes-label" for="notes-${group.id}">📝 Notes for this model (optional)</label>
      <textarea class="group-notes-input" id="notes-${group.id}" data-action="notes"
                placeholder="Any requests or things we should know about this model…">${esc(group.settings.notes || '')}</textarea>
    </div>
```

Then, in the `group-footer`'s `group-costs` block, add an extras line and remove the old labour line. Replace:
```html
        <span>Files subtotal</span><span>${fmt(gc.fileSubtotal, sym)}</span>
        ${assemblyActive ? `<span>🔩 Assembly (${totalParts} parts)</span><span>+${fmt(gc.assemblyCost, sym)}</span>` : ''}
        ${gc.isPrimed ? `<span>🎨 ${esc(config.primerOptions.find(p => p.id === gc.primerLabel)?.label || 'Primer')}</span><span>+${fmt(gc.primerTotal, sym)}</span>` : ''}
        <span>⚙️ Handling &amp; labour</span><span>+${fmt(gc.labourBase, sym)}</span>
```
with:
```html
        <span>Files subtotal</span><span>${fmt(gc.fileSubtotal, sym)}</span>
        ${gc.extrasCost > 0 ? `<span>➕ Extras</span><span>+${fmt(gc.extrasCost, sym)}</span>` : ''}
        ${assemblyActive ? `<span>🔩 Assembly (${totalParts} parts)</span><span>+${fmt(gc.assemblyCost, sym)}</span>` : ''}
        ${gc.isPrimed ? `<span>🎨 ${esc(config.primerOptions.find(p => p.id === gc.primerLabel)?.label || 'Primer')}</span><span>+${fmt(gc.primerTotal, sym)}</span>` : ''}
```

- [ ] **Step 3: Wire the Model Type select and Extras checkboxes in `handleGroupChange()`**

Add this as the first branch inside `handleGroupChange(e, group)`, right after the `const id = el.dataset.id;` line and before the `if (action === 'primer')` check:
```javascript
  if (action === 'model-type') {
    group.settings.modelType = el.value;
    const type = config.modelTypes.find(t => t.id === el.value);
    const allowed = new Set(type?.availableExtras ?? []);
    group.settings.extras = (group.settings.extras || []).filter(id => allowed.has(id));
    recomputeGroup(group);
    renderAll();
    return;
  }

  if (action === 'extra-toggle') {
    const extraId = el.dataset.extraId;
    const set = new Set(group.settings.extras || []);
    if (el.checked) set.add(extraId); else set.delete(extraId);
    group.settings.extras = [...set];
    recomputeGroup(group);
    renderAll();
    return;
  }
```

- [ ] **Step 4: Wire the Notes textarea in `handleGroupInput()`**

Replace:
```javascript
function handleGroupInput(e, group) {
  const el = e.target;
  if (el.dataset.action === 'rename') {
    group.name = el.value || group.name;
    renderOrderSummary();
  }
}
```
with:
```javascript
function handleGroupInput(e, group) {
  const el = e.target;
  if (el.dataset.action === 'rename') {
    group.name = el.value || group.name;
    renderOrderSummary();
    return;
  }
  if (el.dataset.action === 'notes') {
    group.settings.notes = el.value;
  }
}
```

- [ ] **Step 5: Fix `renderOrderSummary()`** (the desktop sidebar / mobile sticky-bar renderer) — it also references the now-removed `gc.labourBase` and `config.minimumItemCost`, and doesn't show extras

Find:
```javascript
  const rawTotal   = activeGroups.reduce((s, g) => s + (g.groupCost?.groupTotal ?? 0), 0);
  const grandTotal = calcOrderTotal(activeGroups, config);
  const minAdjust  = grandTotal - rawTotal;   // > 0 when minimum order floor was applied
```
Replace with:
```javascript
  const grandTotal = calcOrderTotal(activeGroups);
```

Find:
```javascript
        ${gc.assemblyCost > 0 ? `
          <div class="summary-line summary-line-extra">
            <span class="sum-name">🔩 Assembly</span><span></span>
            <span class="sum-price">+${fmt(gc.assemblyCost, sym)}</span>
          </div>` : ''}
        ${gc.isPrimed ? `
          <div class="summary-line summary-line-extra">
            <span class="sum-name">🎨 ${esc(config.primerOptions.find(p => p.id === gc.primerLabel)?.label || 'Primer')}</span><span></span>
            <span class="sum-price">+${fmt(gc.primerTotal, sym)}</span>
          </div>` : ''}
        <div class="summary-line summary-line-extra">
          <span class="sum-name">⚙️ Handling &amp; labour</span><span></span>
          <span class="sum-price">+${fmt(gc.labourBase, sym)}</span>
        </div>
```
Replace with:
```javascript
        ${gc.extrasCost > 0 ? `
          <div class="summary-line summary-line-extra">
            <span class="sum-name">➕ Extras</span><span></span>
            <span class="sum-price">+${fmt(gc.extrasCost, sym)}</span>
          </div>` : ''}
        ${gc.assemblyCost > 0 ? `
          <div class="summary-line summary-line-extra">
            <span class="sum-name">🔩 Assembly</span><span></span>
            <span class="sum-price">+${fmt(gc.assemblyCost, sym)}</span>
          </div>` : ''}
        ${gc.isPrimed ? `
          <div class="summary-line summary-line-extra">
            <span class="sum-name">🎨 ${esc(config.primerOptions.find(p => p.id === gc.primerLabel)?.label || 'Primer')}</span><span></span>
            <span class="sum-price">+${fmt(gc.primerTotal, sym)}</span>
          </div>` : ''}
```

Find:
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
```
Replace with:
```javascript
  if (panel) panel.innerHTML = `
    <h2 class="summary-title">Order Summary</h2>
    <div class="summary-groups">${groupLines}</div>
    <div class="summary-divider"></div>
```

- [ ] **Step 6: Add CSS for the extras list and notes field**

Append to `css/style.css` (after the `.group-setting-*` rules, find `.setting-cost-hint` and add these rules directly after it):
```css
.extras-list { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
.extra-row {
  display: flex; align-items: center; gap: 8px; cursor: pointer;
  font-size: .82rem; color: var(--text); padding: 4px 2px;
}
.extra-row input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--accent); cursor: pointer; }
.extra-row span:first-of-type { flex: 1; }
.extra-price { color: var(--text-dim); font-weight: 600; }

.group-notes { padding: 0 18px 14px; }
.group-notes-label { display: block; font-size: .8rem; font-weight: 500; color: var(--text-dim); margin-bottom: 5px; }
.group-notes-input {
  width: 100%; min-height: 56px; resize: vertical;
  background: var(--bg2); border: 1px solid var(--card-border); border-radius: var(--radius-sm);
  color: var(--text); font-family: var(--body-font); font-size: .85rem; padding: 8px 10px;
}
.group-notes-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
```

- [ ] **Step 7: Verify in the browser**

With the dev server running, open `http://localhost:8744/index.html`, drop in a test STL file:
- Confirm a "🧩 Model Type" dropdown appears above "🎨 Primer Coating" with 5 options.
- Switch to "Miniature — base separate" and confirm a hint appears: "📎 Need a base?..."
- Confirm the Extras checklist shows Wings/Sword/Weapon/Banner (per the default type's `availableExtras`), and ticking one adds a "➕ Extras" line to the Model Total with the correct price.
- Switch Model Type to "Display piece / bust" (only Banner available) and confirm previously-ticked extras not in the new type's list are automatically unticked and the total recalculates.
- Confirm a "📝 Notes for this model" textarea appears below the settings, and typing in it doesn't cause a full re-render (shouldn't lose focus while typing).
- Confirm the desktop sidebar (or mobile sticky bar) total updates correctly with the ticked extra included, shows no "⚙️ Handling & labour" line, and shows no stray "📋 Minimum order" line at any total.

- [ ] **Step 8: Commit**

```bash
git add js/main.js css/style.css
git commit -m "Add Model Type selector, Extras checklist, and per-model notes"
```

---

### Task 4: Item card — tier display, oversized/physical-fit warning

**Files:**
- Modify: `js/main.js` — `buildItemHTML()` (~line 350)

**Interfaces:**
- Consumes: `item.cost.tier`, `item.cost.fitsBuildPlate`, `item.cost.surchargePct`, `item.cost.surchargeAmount` (Task 2's new `calcItemCost` return shape).
- Produces: nothing new consumed by later tasks — this task only changes rendering, not data.

- [ ] **Step 1: Remove the now-unused `supportPct` variable**

Find (near the top of `buildItemHTML`, after `const dims = ...` line):
```javascript
  const supportPct = config.supportMaterial;
```
Delete this line entirely — `config.supportMaterial` no longer exists (removed in Task 1), and support toggling no longer affects price.

- [ ] **Step 2: Replace the card-dims line to show the size tier instead of resin volume**

Replace:
```javascript
        ${c ? `<div class="card-dims">📐 Print size: <strong>${fmtMm(dims.x)} × ${fmtMm(dims.y)} × ${fmtMm(dims.z)}</strong> &nbsp;·&nbsp; <strong>${fmtMl(c.scaledVolumeMl)}</strong> resin</div>` : ''}
```
with:
```javascript
        ${c && c.tier ? `<div class="card-dims">📐 Print size: <strong>${fmtMm(dims.x)} × ${fmtMm(dims.y)} × ${fmtMm(dims.z)}</strong> &nbsp;·&nbsp; <strong>${esc(c.tier.name)}</strong> tier</div>` : ''}
        ${c && !c.tier ? `<div class="card-warning">⚠️ This model is too large to fit our build plate, even with the support margin. Please scale it down or split it into parts before requesting a quote.</div>` : ''}
```

- [ ] **Step 3: Replace the Support Structures control hint** (it previously described a resin-volume surcharge that no longer exists)

Replace:
```javascript
            <div class="control-hint ${ps ? 'hint-green' : ''}">
              ${ps
                ? '✅ No extra support material charged — your file already includes them.'
                : `+${supportPct}% extra resin added for support scaffolding`}
            </div>
```
with:
```javascript
            <div class="control-hint ${ps ? 'hint-green' : ''}">
              ${ps
                ? '✅ Marked as already supported — no changes needed on our end.'
                : 'We’ll add supports during printing as needed — this doesn’t change the price.'}
            </div>
```

- [ ] **Step 4: Replace the cost breakdown table** to show tier price + material surcharge instead of volume/machine-time

Replace:
```javascript
  const breakdownHTML = config.showCostBreakdown && c ? `
    <details class="cost-details">
      <summary>💡 See cost breakdown</summary>
      <table class="breakdown-table">
        <tr><td>Volume at ${Math.round(item.settings.scale * 100)}% scale</td><td>${fmtMl(c.scaledVolumeMl)}</td></tr>
        ${ps
          ? `<tr class="row-saved"><td>✅ No support material (pre-supported)</td><td>—</td></tr>`
          : `<tr><td>+ Support material (${supportPct}%)</td><td>${fmtMl(c.totalVolumeMl)}</td></tr>`}
        <tr><td>Material cost</td><td>${fmt(c.resinCost, sym)}</td></tr>
        <tr><td>Print &amp; finishing</td><td>${fmt(c.machineCost + c.markupAmount, sym)}</td></tr>
      </table>
    </details>` : '';
```
with:
```javascript
  const breakdownHTML = config.showCostBreakdown && c && c.tier ? `
    <details class="cost-details">
      <summary>💡 See price breakdown</summary>
      <table class="breakdown-table">
        <tr><td>Size tier: ${esc(c.tier.name)} (largest side ≤ ${c.tier.maxDimensionMm ? c.tier.maxDimensionMm + 'mm' : 'build plate'})</td><td>${fmt(c.tier.price, sym)}</td></tr>
        ${c.surchargePct > 0 ? `<tr><td>${esc(c.materialName)} surcharge (+${c.surchargePct}%)</td><td>${fmt(c.surchargeAmount, sym)}</td></tr>` : ''}
      </table>
    </details>` : '';
```

- [ ] **Step 5: Update the card-cost footer to handle the oversized case**

Replace:
```javascript
        <div class="card-cost">
          ${c ? `
            <span class="unit-cost">${fmt(c.unitCost, sym)} each</span>
            ${c.quantity > 1 ? `<span class="total-cost">${fmt(c.totalCost, sym)} for ${c.quantity}</span>` : ''}
          ` : '—'}
        </div>
```
with:
```javascript
        <div class="card-cost">
          ${c && c.tier ? `
            <span class="unit-cost">${fmt(c.unitCost, sym)} each</span>
            ${c.quantity > 1 ? `<span class="total-cost">${fmt(c.totalCost, sym)} for ${c.quantity}</span>` : ''}
          ` : c && !c.tier ? `<span class="text-error">Cannot price — too large</span>` : '—'}
        </div>
```

- [ ] **Step 6: Verify in the browser**

With the dev server running, drop in a small test STL (e.g. a 20mm cube) and confirm:
- The card shows "📐 Print size: ... · Small tier" (or whichever tier matches its dimensions).
- "See price breakdown" shows the tier row and price.
- The unit cost shown matches the tier's price (plus any surcharge if you switch to a non-Standard resin).

Then test the oversized path — scale the same file up to e.g. 500% via the Print Scale input so its largest dimension exceeds ~260mm (well past both the tier ladder and the build plate's usable ~176mm max axis), and confirm:
- A red "⚠️ This model is too large..." warning appears on the card.
- The card-cost footer shows "Cannot price — too large" instead of a price.

- [ ] **Step 7: Commit**

```bash
git add js/main.js
git commit -m "Show size tier on file cards, add oversized/physical-fit warning"
```

---

### Task 5: Order guardrails — £150 custom-quote banner, review/cancellation copy, AI-file warning, oversized submit block

**Files:**
- Modify: `index.html` — drop-zone area (~line 42-47), order review step (~line 114-133)
- Modify: `js/main.js` — `openOrderForm()` (~line 968)
- Modify: `css/style.css` — append rules for `.ai-file-note`, `.review-custom-quote-note`

**Interfaces:**
- Consumes: `exceedsCustomQuoteThreshold(grandTotal, config)` (Task 2), `groupCost.oversizedCount` (Task 2).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Add the AI-generated-file note in `index.html`**

Find:
```html
    <p class="drop-hint">Supports binary &amp; ASCII .stl · Multiple files at once · .lys (Lychee Slicer) files detected — export as STL first</p>
```
Add immediately after it:
```html
    <p class="ai-file-note">🤖 Using an AI-generated model? These often need cleanup (thin walls, no drain holes, poor overhangs) before they'll print cleanly — mention it in that model's notes so we can check before starting.</p>
```

- [ ] **Step 2: Update the review step copy and add the custom-quote banner in `index.html`**

Find:
```html
        <div class="order-total-row">
          <span>Grand Total (estimated)</span>
          <span id="review-order-total">—</span>
        </div>
        <p class="review-disclaimer-note">
          ⚠️ Please review your order carefully before continuing.
          Ensure all scales, quantities, and material choices are correct.
          Incorrect details may delay your order.
        </p>
```
Replace with:
```html
        <div class="order-total-row">
          <span>Grand Total (estimated)</span>
          <span id="review-order-total">—</span>
        </div>
        <p class="review-custom-quote-note" id="review-custom-quote-note" style="display:none">
          🔍 Orders over £150 are personally reviewed before we confirm pricing — we'll be in touch if anything needs adjusting.
        </p>
        <p class="review-disclaimer-note">
          ⚠️ Please review your order carefully before continuing.
          Ensure all scales, quantities, and material choices are correct.
          All orders are reviewed by hand before we confirm — you're welcome to cancel at that point if anything needs changing.
        </p>
```

- [ ] **Step 3: Toggle the custom-quote banner and block oversized submissions in `openOrderForm()`**

Add the import of `exceedsCustomQuoteThreshold` at the top of `js/main.js` — find:
```javascript
import {
  calcItemCost, calcGroupCost, calcOrderTotal,
  fmt, fmtMl, fmtMm, fmtHours,
} from './calculator.js?v=9';
```
Replace with:
```javascript
import {
  calcItemCost, calcGroupCost, calcOrderTotal, exceedsCustomQuoteThreshold,
  fmt, fmtMl, fmtMm, fmtHours,
} from './calculator.js?v=9';
```

Then find the start of `openOrderForm()`:
```javascript
function openOrderForm() {
  const activeGroups = groups.filter(g => g.items.some(i => i.status === 'ready'));
  if (!activeGroups.length) { showToast('No valid files to quote.', 'error'); return; }

  const overlay = document.getElementById('order-overlay');
  if (!overlay) return;

  _orderNumber = generateOrderNumber();
  const sym        = config.currencySymbol;
  const grandTotal = calcOrderTotal(activeGroups, config);
```
Replace with:
```javascript
function openOrderForm() {
  const activeGroups = groups.filter(g => g.items.some(i => i.status === 'ready'));
  if (!activeGroups.length) { showToast('No valid files to quote.', 'error'); return; }

  const hasOversized = activeGroups.some(g => (g.groupCost?.oversizedCount ?? 0) > 0);
  if (hasOversized) {
    showToast('One or more files are too large to price automatically. Please scale them down or remove them before requesting a quote.', 'error');
    return;
  }

  const overlay = document.getElementById('order-overlay');
  if (!overlay) return;

  _orderNumber = generateOrderNumber();
  const sym        = config.currencySymbol;
  const grandTotal = calcOrderTotal(activeGroups, config);

  const quoteNoteEl = document.getElementById('review-custom-quote-note');
  if (quoteNoteEl) quoteNoteEl.style.display = exceedsCustomQuoteThreshold(grandTotal, config) ? 'block' : 'none';
```

- [ ] **Step 4: Add CSS for the two new notices**

Append to `css/style.css` (after `.drop-zone .drop-hint` rule):
```css
.ai-file-note {
  margin-top: 8px; font-size: .74rem; color: var(--text-dim);
  background: var(--bg3); border: 1px solid var(--card-border); border-radius: var(--radius-sm);
  padding: 6px 10px; display: inline-block;
}
```
Append after `.review-disclaimer-note` rule:
```css
.review-custom-quote-note {
  font-size: .8rem; color: var(--amber); line-height: 1.6;
  padding: 10px 14px; margin: 4px 0 12px;
  background: rgba(196,119,0,.08); border: 1px solid rgba(196,119,0,.3); border-radius: var(--radius-sm);
  font-weight: 600;
}
```

- [ ] **Step 5: Verify in the browser**

With the dev server running:
- Confirm the AI-file note appears under the drop-zone hint text.
- Drop in enough test files (or scale one up) to push the order total past £150, click "Request a Quote →", and confirm the amber "🔍 Orders over £150..." banner appears in the review step above the standard disclaimer.
- Remove files to bring the total back under £150, re-open the review step, and confirm the banner is hidden again.
- Scale a file up past the build-plate limit (per Task 4's oversized test), then click "Request a Quote →" from the sticky bar/sidebar button and confirm a toast appears ("One or more files are too large...") and the review overlay does NOT open.

- [ ] **Step 6: Commit**

```bash
git add index.html js/main.js css/style.css
git commit -m "Add £150 custom-quote banner, review/cancellation copy, AI-file note, oversized submit block"
```

---

### Task 6: Review screen + submit payload — extras, notes, model type

**Files:**
- Modify: `js/main.js` — `buildReviewGroupHTML()` (~line 710), `submitOrder()` (~line 1001)

**Interfaces:**
- Consumes: `group.settings.modelType`, `group.settings.extras`, `group.settings.notes` (Task 3). `config.modelTypes`, `config.extras` (Task 1). `item.cost.tier` (Task 2).
- Produces: nothing new consumed by later tasks — this is the final data-flow endpoint (review UI + submitted payload).

- [ ] **Step 1: Update `buildReviewGroupHTML()`** to drop the removed labour line, show tier name instead of scale/support text, list ticked extras, and show notes

Replace the whole function:
```javascript
function buildReviewGroupHTML(group, sym) {
  const gc = group.groupCost;
  if (!gc) return '';
  const readyItems = group.items.filter(i => i.status === 'ready' && i.cost?.tier);

  const filesHTML = readyItems.map(i => {
    const thumbHTML = i.thumbnail
      ? `<img src="${i.thumbnail}" alt="" class="review-thumb">`
      : `<div class="review-thumb review-thumb-ph">STL</div>`;
    return `
      <div class="review-file-row">
        ${thumbHTML}
        <div class="review-file-info">
          <div class="review-file-name">${esc(shortName(i.name, 38))}</div>
          <div class="review-file-meta">
            ${esc(i.cost.materialName)} &middot; ×${i.settings.quantity}
            &middot; ${esc(i.cost.tier.name)} tier
          </div>
        </div>
        <div class="review-file-cost">${fmt(i.cost.totalCost, sym)}</div>
      </div>`;
  }).join('');

  const extraLines = (group.settings.extras || []).map(extraId => {
    const extra = config.extras.find(e => e.id === extraId);
    return extra ? `<div class="review-extra-row"><span>➕ ${esc(extra.name)}</span><span>+${fmt(extra.price, sym)}</span></div>` : '';
  }).join('');

  const otherExtras = [];
  if (gc.assemblyCost > 0)
    otherExtras.push(`<div class="review-extra-row"><span>🔩 Assembly</span><span>+${fmt(gc.assemblyCost, sym)}</span></div>`);
  if (gc.isPrimed)
    otherExtras.push(`<div class="review-extra-row"><span>🎨 ${esc(config.primerOptions.find(p => p.id === gc.primerLabel)?.label || 'Primer')}</span><span>+${fmt(gc.primerTotal, sym)}</span></div>`);

  const notesHTML = group.settings.notes?.trim()
    ? `<div class="review-extra-row"><span>📝 Notes</span><span>${esc(group.settings.notes.trim())}</span></div>`
    : '';

  return `
    <div class="review-group">
      <div class="review-group-hdr">${esc(group.name)}</div>
      ${filesHTML}
      ${extraLines}
      ${otherExtras.join('')}
      ${notesHTML}
      <div class="review-group-subtotal">
        <span>${esc(group.name)} total</span>
        <span>${fmt(gc.groupTotal, sym)}</span>
      </div>
    </div>`;
}
```

- [ ] **Step 2: Update the `submitOrder()` payload**

Find:
```javascript
    groups: activeGroups.map(g => ({
      name:     g.name,
      assembly: g.settings.assembly,
      primer:   g.settings.primer,
      cost:     g.groupCost?.groupTotal,
      files:    g.items.filter(i => i.status === 'ready').map(i => ({
        filename:     i.name,
        material:     i.cost.materialName,
        presupported: i.settings.presupported,
        scale:        i.settings.scale,
        quantity:     i.settings.quantity,
        unitCost:     i.cost.unitCost,
        total:        i.cost.totalCost,
      })),
    })),
```
Replace with:
```javascript
    groups: activeGroups.map(g => ({
      name:      g.name,
      modelType: g.settings.modelType,
      extras:    g.settings.extras,
      notes:     g.settings.notes,
      assembly:  g.settings.assembly,
      primer:    g.settings.primer,
      cost:      g.groupCost?.groupTotal,
      files:    g.items.filter(i => i.status === 'ready' && i.cost?.tier).map(i => ({
        filename:     i.name,
        material:     i.cost.materialName,
        presupported: i.settings.presupported,
        scale:        i.settings.scale,
        quantity:     i.settings.quantity,
        tier:         i.cost.tier.name,
        unitCost:     i.cost.unitCost,
        total:        i.cost.totalCost,
      })),
    })),
```

- [ ] **Step 3: Verify in the browser**

With the dev server running: drop a file, tick an Extra, type something in the model's Notes field, choose "Miniature — base separate" as the type, then click through to "Review Your Order" and confirm:
- The file row shows its tier name (e.g. "Regular tier") instead of the old scale/support text.
- The ticked Extra appears as its own line with its price.
- The typed note appears under a "📝 Notes" line.
- No "⚙️ Handling & labour" line appears anywhere (removed).

Then open the browser console, watch for the `console.info('Quote payload:', payload)` log (already present in `submitOrder`) when you submit the contact form, and confirm the logged payload's group object includes `modelType`, `extras`, and `notes` with the values you set.

- [ ] **Step 4: Bump every cache-busting version this plan touched**

This is a one-time housekeeping pass covering all six tasks, done here since this is the last task that touches `js/main.js`. In `index.html`, bump:
```html
  <link rel="stylesheet" href="css/style.css?v=12">
```
to `?v=13` (style.css changed in Tasks 3 and 5), and:
```html
<script type="module" src="js/main.js?v=10"></script>
```
to `?v=11` (main.js changed in Tasks 3, 4, 5, and 6).

In `js/main.js`, bump both:
```javascript
import { getConfig } from './config.js?v=9';
```
to `?v=10` (config.js content changed in Task 1), and:
```javascript
} from './calculator.js?v=9';
```
to `?v=10` (calculator.js content changed in Task 2). `calculator.js`'s own import of `config.js?v=7` was already set correctly when it was rewritten in Task 2 — no change needed there.

- [ ] **Step 5: Commit**

```bash
git add js/main.js index.html
git commit -m "Show extras/notes/tier in order review, include them in submit payload; bump cache-busting versions"
```

---

### Task 7: End-to-end verification against the real test files

**Files:**
- None (verification-only task; no code changes).

**Interfaces:**
- Consumes: the complete feature set from Tasks 1–6.

- [ ] **Step 1: Re-quote all four real test files from earlier in this project's testing**

You'll need the same four files used to calibrate this design: a ~5mm heart, a 32mm Hero Forge mini (base attached, single file), a 32mm DM Stash mini (base + body, two files), and a 75mm DM Stash mini (base + body, two files). Start the dev server (`python server.py 8744`), open `http://localhost:8744/index.html`, and upload each into its own Model group with Model Type "Miniature — base included" for the Hero Forge and "Miniature — base separate" for both DM Stash models. For each, confirm:

- **Heart (~5mm):** lands in the XS tier, £1.00 (no material surcharge with Standard resin).
- **Hero Forge (32mm, base attached):** lands in the Regular tier, £6.00.
- **DM Stash 32mm (base + body, two files):** each file individually tiers based on its own largest dimension (base ~25.4mm → Small tier £3, body ~45.8mm → Regular tier £6 — confirm the exact tiers using each file's real dimensions from Task 2's console check), summing to the group's file subtotal.
- **DM Stash 75mm (base + body, two files):** base's largest dimension ~59.5mm and body's ~107.4mm — confirm which tiers they land in (per Task 2's console check, the body should be Large+ at £21; verify the base's tier too) and that the combined group total lands reasonably close to the ~£40 target discussed during design. If it's meaningfully off, that's a signal the tier ladder itself (not the code) needs adjusting in `js/config.js`'s `DEFAULT_CONFIG.sizeTiers` — not a bug to fix blindly, flag it for the human to confirm the ladder value.

- [ ] **Step 2: Regression-check the guardrails together**

With all four models in the cart, confirm the running total and check whether it crosses £150 (if not, temporarily bump a quantity to push it over) — confirm the custom-quote banner appears in review. Then remove/reduce until back under £150 and confirm it disappears. Finally, scale one file up past the build plate's usable size and confirm both the card-level warning (Task 4) and the submit-time block (Task 5) still work correctly alongside the other three valid models in the cart.

- [ ] **Step 3: Fix any issues found, then commit**

If any check in Steps 1–2 fails, identify which task's code is responsible, fix it there (don't bundle unrelated changes), re-run the specific check, and commit:
```bash
git add -A
git commit -m "Fix verification issues found in end-to-end tiered pricing test"
```
Only make this commit if real fixes were needed — if verification is fully clean, there's nothing to commit for this task.

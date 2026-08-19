// ============================================================
// main.js — App orchestration
// Groups: each model group has primer / assembly / labour settings.
// Files belong to a group. Multiple groups = multiple models.
// ============================================================

import { getConfig } from './config.js?v=13';
import { parseSTLFile } from './stl-parser.js?v=9';
import { generateThumbnail, STLViewer } from './viewer.js?v=11';
import { icon, applyStaticIcons } from './icons.js?v=1';
import {
  calcItemCost, calcGroupCost, calcOrderTotal, calcOrderMinimumShortfall,
  exceedsCustomQuoteThreshold, fmt, fmtMm,
} from './calculator.js?v=13';

// ---- State -----------------------------------------------------------
let config      = getConfig();
let groups      = [];    // Group[]
let modalViewer  = null;
let _orderNumber = null;

// Group shape:
// { id, name, settings: { assembly, primer }, items: Item[], groupCost }
// Item shape:
// { id, file, name, size, status, data, thumbnail, settings, cost }

let _gSeq = 0, _iSeq = 0;
const gId = () => `g${++_gSeq}`;
const iId = () => `i${++_iSeq}`;

// ---- Tap-to-arm delete confirmation ------------------------------------
// First tap on a delete button arms it (shows "Delete part/model?" for a
// few seconds); a second tap while armed actually deletes. Arming a
// different button replaces the pending one, and it auto-disarms after
// a few seconds of inactivity.
let _pendingDeleteType  = null; // 'item' | 'group'
let _pendingDeleteId    = null;
let _pendingDeleteTimer = null;

function isArmedForDelete(type, id) {
  return _pendingDeleteType === type && _pendingDeleteId === id;
}

function armDelete(type, id) {
  clearTimeout(_pendingDeleteTimer);
  _pendingDeleteType  = type;
  _pendingDeleteId    = id;
  _pendingDeleteTimer = setTimeout(() => {
    _pendingDeleteType = null;
    _pendingDeleteId   = null;
    renderAll();
  }, 3000);
  renderAll();
}

function disarmDelete() {
  clearTimeout(_pendingDeleteTimer);
  _pendingDeleteType  = null;
  _pendingDeleteId    = null;
}

// ---- Boot ------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  config = getConfig();
  applyStaticIcons();
  setupDropZone();
  setupAddButtons();
  setupFileInput();
  setupModal();
  setupOrderForm();
  document.getElementById('mobile-summary-btn')?.addEventListener('click', openOrderForm);
  setupGroupList();   // Single delegated listener — no duplicates across re-renders
  renderAll();
});

window.addEventListener('storage', e => {
  if (e.key !== 'stl_calc_config_v1') return;
  config = getConfig();
  allItems().forEach(item => { if (item.status === 'ready') recomputeItemCost(item); });
  recomputeAllGroups();
  renderAll();
});

// ---- Helpers ---------------------------------------------------------

function allItems() { return groups.flatMap(g => g.items); }

function findItem(id) {
  for (const g of groups)
    for (const item of g.items)
      if (item.id === id) return { item, group: g };
  return null;
}

function defaultGroupSettings() {
  return {
    assembly: false,
    primer: 'unprimed',
    extras: [],
    notes: '',
    printMethod: 'resin',
  };
}

function createGroup(name) {
  return {
    id: gId(), name, settings: defaultGroupSettings(), items: [], groupCost: null,
    settingsOpen: false,   // model settings disclosure
    justUnlocked: false,   // set when assembly first becomes available, for a one-shot highlight
  };
}

function ensureGroup() {
  if (!groups.length) groups.push(createGroup('Model 1'));
  return groups[0];
}

// ---- Drop zone -------------------------------------------------------

// The whole page is a drop target for the whole session — the most natural
// way to add a file shouldn't stop working the moment you have one.
// A drop of several files at once reads as "these belong together", so it
// lands as one multi-part model; a single file gets its own model.

function setupDropZone() {
  const overlay = document.getElementById('drop-overlay');
  let depth = 0;

  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');

  window.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay?.classList.add('active');
  });

  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });

  window.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay?.classList.remove('active');
  });

  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay?.classList.remove('active');

    const files = [...e.dataTransfer.files].filter(f => {
      const n = f.name.toLowerCase();
      return n.endsWith('.stl') || n.endsWith('.lys');
    });
    if (!files.length) {
      showToast('Please drop .stl or .lys files.', 'error');
      return;
    }
    // Several files dropped together = one multi-part model.
    _uploadIntent = files.length > 1 ? 'model' : 'single';
    handleFilesForGroup(files);
  });
}

/** Open the file picker with a stated intent. */
function pickFiles(intent) {
  _uploadIntent = intent;
  document.getElementById('file-input').click();
}

function setupAddButtons() {
  for (const id of ['start-zone', 'add-row']) {
    document.getElementById(id)?.addEventListener('click', e => {
      const btn = e.target.closest('[data-intent]');
      if (btn) pickFiles(btn.dataset.intent);
    });
  }
}

function setupFileInput() {
  const input = document.getElementById('file-input');
  if (!input) return;
  input.addEventListener('change', e => {
    handleFilesForGroup([...e.target.files]);
    e.target.value = '';
  });
}

// ---- Group event delegation ------------------------------------------
// ONE set of listeners on #group-list, never duplicated across re-renders.
// group is looked up LIVE from the groups array by card's data-gid.

function setupGroupList() {
  const container = document.getElementById('group-list');
  if (!container) return;

  container.addEventListener('click', e => {
    const card = e.target.closest('.group-card');
    if (!card) return;
    const group = groups.find(g => g.id === card.dataset.gid);
    if (group) handleGroupClick(e, group, card);
  });

  container.addEventListener('change', e => {
    const card = e.target.closest('.group-card');
    if (!card) return;
    const group = groups.find(g => g.id === card.dataset.gid);
    if (group) handleGroupChange(e, group, card);
  });

  container.addEventListener('input', e => {
    const card = e.target.closest('.group-card');
    if (!card) return;
    const group = groups.find(g => g.id === card.dataset.gid);
    if (group) handleGroupInput(e, group, card);
  });
}

// ---- Cost calculation ------------------------------------------------

function recomputeItemCost(item) {
  if (item.status !== 'ready') return;
  const printMethod = findItem(item.id)?.group?.settings?.printMethod ?? 'resin';
  item.cost = calcItemCost(item.data, item.settings, config, printMethod);
}

function recomputeGroup(group) {
  group.groupCost = calcGroupCost(group.items, group.settings, config);
}

function recomputeAllGroups() {
  groups.forEach(recomputeGroup);
}

// ---- Group management ------------------------------------------------

function removeGroup(groupId) {
  groups = groups.filter(g => g.id !== groupId);
  renderAll();
}

function moveItemToGroup(itemId, targetGroupId) {
  let movedItem = null;
  for (const g of groups) {
    const idx = g.items.findIndex(i => i.id === itemId);
    if (idx !== -1) {
      [movedItem] = g.items.splice(idx, 1);
      recomputeGroup(g);
      break;
    }
  }
  if (!movedItem) return;
  const targetGroup = groups.find(g => g.id === targetGroupId);
  if (targetGroup) {
    targetGroup.items.push(movedItem);
    recomputeGroup(targetGroup);
    checkAssemblyUnlocked(targetGroup);
  }
  if (groups.length > 1) groups = groups.filter(g => g.items.length > 0);
  renderAll();
}

function removeItem(itemId) {
  for (const g of groups) {
    const idx = g.items.findIndex(i => i.id === itemId);
    if (idx !== -1) {
      g.items.splice(idx, 1);
      recomputeGroup(g);
      break;
    }
  }
  if (groups.length > 1) groups = groups.filter(g => g.items.length > 0);
  renderAll();
}

// ---- Render ----------------------------------------------------------

function renderAll() {
  renderGroupList();
  renderOrderSummary();
}

function renderGroupList() {
  const container = document.getElementById('group-list');
  if (!container) return;

  const hasItems = groups.some(g => g.items.length > 0);

  // The two-way start panel is the empty state; once anything is uploaded
  // the same two choices live on in the persistent add row below the list.
  const startZone = document.getElementById('start-zone');
  if (startZone) startZone.style.display = hasItems ? 'none' : '';

  const addRow = document.getElementById('add-row');
  if (addRow) addRow.style.display = hasItems ? '' : 'none';

  // Remove stale group cards
  const currentIds = new Set(groups.map(g => g.id));
  [...container.querySelectorAll('.group-card')].forEach(el => {
    if (!currentIds.has(el.dataset.gid)) el.remove();
  });

  // Update group cards — events handled by container delegation (setupGroupList)
  groups.forEach(group => {
    let card = container.querySelector(`[data-gid="${group.id}"]`);
    if (!card) {
      card = document.createElement('div');
      card.className   = 'group-card';
      card.dataset.gid = group.id;
      container.appendChild(card);
    }
    card.innerHTML = buildGroupHTML(group);
  });
}

// ---- Model card HTML -------------------------------------------------
// A model is a container with a visible edge: a header bar carrying its
// name, a one-line summary of its settings and its running total, then
// its parts as single-line rows beneath. Settings and part detail both
// live behind a disclosure — nothing is expanded until it's asked for.

function buildGroupHTML(group) {
  const sym        = config.currencySymbol;
  const gc         = group.groupCost;
  const readyItems = group.items.filter(i => i.status === 'ready' && i.cost);
  const pricedItems = readyItems.filter(i => i.cost.priceable);
  const totalParts = readyItems.reduce((s, i) => s + i.settings.quantity, 0);
  const canAssemble = totalParts >= 2;

  const printMethod = group.settings.printMethod === 'pla' ? 'pla' : 'resin';
  const isPlaModel  = printMethod === 'pla';
  const assemblyActive = group.settings.assembly && canAssemble;

  const primerLabel = config.primerOptions.find(p => p.id === group.settings.primer)?.label || 'Unprimed';

  // Summary chips — what the model's settings currently add up to, in one
  // line, so the settings panel can stay shut without hiding the answer.
  const chips = [
    isPlaModel ? 'PLA' : 'Resin',
    primerLabel,
    canAssemble ? (assemblyActive ? 'Assembled' : 'Loose parts') : null,
    group.settings.notes?.trim() ? 'Notes added' : null,
  ].filter(Boolean);

  const partCountLabel = group.items.length === 1
    ? '1 part'
    : `${group.items.length} parts`;

  const itemsHTML = group.items.length
    ? group.items.map(item => buildItemHTML(item, group, groups.length > 1)).join('')
    : `<div class="part-empty">No files in this model yet — use <strong>Add part</strong> below.</div>`;

  return `
    <div class="model-bar ${group.settingsOpen ? 'open' : ''} ${group.justUnlocked ? 'flash' : ''}">
      <div class="model-bar-id">
        <span class="model-tag">Model</span>
        <input class="model-name" value="${esc(group.name)}" data-action="rename"
               aria-label="Model name" spellcheck="false">
      </div>
      <div class="model-bar-meta">
        <span class="model-chips">${chips.map(c => `<span>${esc(c)}</span>`).join('')}</span>
        <span class="model-count">${partCountLabel}</span>
      </div>
      <div class="model-bar-end">
        <span class="model-total">${gc && pricedItems.length ? fmt(gc.groupTotal, sym) : '—'}</span>
        <button class="model-opts-btn" data-action="toggle-model-settings"
                aria-expanded="${group.settingsOpen ? 'true' : 'false'}">
          <span class="btn-label">Options</span>${icon(group.settingsOpen ? 'chevronUp' : 'chevronDown', { size: 15 })}
        </button>
      </div>
    </div>

    ${group.settingsOpen ? buildModelSettingsHTML(group, { isPlaModel, canAssemble, assemblyActive, totalParts, gc, sym }) : ''}

    <div class="group-items">${itemsHTML}</div>

    <div class="model-foot">
      <button class="btn btn-quiet btn-sm" data-action="add-files-to-group">
        ${icon('plus', { size: 14 })} Add part
      </button>
      ${gc && pricedItems.length ? buildModelFootBreakdown(gc, assemblyActive, sym) : ''}
    </div>
  `;
}

/** The extras that made up a model's total, as a compact inline list. */
function buildModelFootBreakdown(gc, assemblyActive, sym) {
  const bits = [];
  if (assemblyActive)      bits.push(`assembly +${fmt(gc.assemblyCost, sym)}`);
  if (gc.isPrimed)         bits.push(`primer +${fmt(gc.primerTotal, sym)}`);
  if (gc.plaColorCost > 0) bits.push(`colour +${fmt(gc.plaColorCost, sym)}`);
  return bits.length
    ? `<span class="model-foot-extras">Included in the model total: ${esc(bits.join(' · '))}</span>`
    : '';
}

// ---- Model settings panel --------------------------------------------
// Only rendered when the model bar's Options disclosure is open. Assembly
// appears here only once the model actually has 2+ parts — a choice that
// doesn't exist yet isn't shown as a disabled control.

function buildModelSettingsHTML(group, ctx) {
  const { isPlaModel, canAssemble, assemblyActive, totalParts, gc, sym } = ctx;

  const primerColors = { black: '#1a1a1a', grey: '#9a9a9a', white: '#f6f3ec' };
  const primerSwatchesHTML = config.primerOptions.map(p => {
    const active = group.settings.primer === p.id;
    const isNone = p.id === 'unprimed';
    const color  = primerColors[p.id] || '#c9a15a';
    return `
      <button type="button" class="primer-swatch-btn" data-action="primer-select" data-primer-id="${esc(p.id)}"
              title="${esc(p.label)}" aria-label="${esc(p.label)}" aria-pressed="${active}">
        <span class="primer-swatch ${active ? 'active' : ''} ${isNone ? 'primer-none' : ''}"
              ${isNone ? '' : `style="background:${color};"`}>
          ${active ? `<span class="primer-check">${icon('check', { size: 14 })}</span>` : ''}
        </span>
        <span class="primer-swatch-label">${esc(p.label)}</span>
      </button>`;
  }).join('');

  const primerCostHint = (group.settings.primer !== 'unprimed' && gc)
    ? `<span class="setting-cost-hint">+${fmt(gc.primerTotal, sym)}</span>` : '';
  const assemblyCostHint = (assemblyActive && gc)
    ? ` <span class="setting-cost-hint">+${fmt(gc.assemblyCost, sym)}</span>` : '';

  return `
    <div class="model-settings">

      <div class="mset">
        <div class="mset-label">
          Print method
          <span class="info-tip-wrap">
            <button type="button" class="info-tip-btn" data-action="toggle-info"
                    aria-label="What's the difference between resin and PLA?" aria-expanded="false">${icon('helpCircle', { size: 15 })}</button>
            <span class="info-tip-content" role="tooltip">
              <strong>Resin</strong> — highest detail, best for fine miniatures. Priced by size.<br><br>
              <strong>PLA</strong> — stronger and faster, best for larger or simpler parts. Priced by volume, and you pick a filament colour per part.
            </span>
          </span>
        </div>
        <div class="seg">
          <button class="seg-btn ${!isPlaModel ? 'active' : ''}" data-action="print-method" data-val="resin">Resin</button>
          <button class="seg-btn ${isPlaModel ? 'active' : ''}" data-action="print-method" data-val="pla">PLA</button>
        </div>
      </div>

      <div class="mset">
        <div class="mset-label">
          Primer coating
          <span class="info-tip-wrap">
            <button type="button" class="info-tip-btn" data-action="toggle-info"
                    aria-label="What does priming do?" aria-expanded="false">${icon('helpCircle', { size: 15 })}</button>
            <span class="info-tip-content" role="tooltip">
              A spray primer goes on the finished model before you paint it. It helps paint stick and softens layer lines.${isPlaModel ? '<br><br>On PLA, priming covers the filament colour you choose below — pick one or the other unless you want a painting base.' : ''}
            </span>
          </span>
        </div>
        <div class="primer-row">${primerSwatchesHTML}${primerCostHint}</div>
      </div>

      ${canAssemble ? `
      <div class="mset">
        <div class="mset-label">Assembly</div>
        <div class="seg">
          <button class="seg-btn ${!assemblyActive ? 'active' : ''}" data-action="assembly" data-val="false">
            Supply as ${totalParts} loose parts
          </button>
          <button class="seg-btn ${assemblyActive ? 'active' : ''}" data-action="assembly" data-val="true">
            Glue &amp; fit together${assemblyCostHint}
          </button>
        </div>
      </div>` : ''}

      <div class="mset mset-notes">
        <label class="mset-label" for="notes-${group.id}">Notes for this model <span class="mset-optional">optional</span></label>
        <textarea class="mset-notes-input" id="notes-${group.id}" data-action="notes" rows="2"
                  placeholder="Colour preferences, a deadline, anything we should know…">${esc(group.settings.notes || '')}</textarea>
        <p class="mset-hint">Working from an AI-generated model? Tell us here — they often need thin walls, drain holes or overhangs fixed before they print cleanly, and we'll check yours first.</p>
      </div>

      <div class="mset-foot">
        <button class="model-delete-btn ${isArmedForDelete('group', group.id) ? 'armed' : ''}"
                data-action="delete-group">
          ${icon('trash', { size: 14 })} ${isArmedForDelete('group', group.id) ? 'Tap again to delete this model' : 'Delete this model'}
        </button>
      </div>

    </div>`;
}

// ---- Part row HTML ---------------------------------------------------
// At rest a part is one line: what it is, how big, how many, how much.
// Everything that changes it lives behind the row's own disclosure.

function buildItemHTML(item, group, showMoveControl) {
  const sym = config.currencySymbol;

  if (item.status === 'loading') return `
    <div class="part part-loading" data-id="${item.id}">
      <div class="part-thumb"><div class="spinner"></div></div>
      <div class="part-main">
        <div class="part-name">${esc(item.name)}</div>
        <div class="part-spec">Reading file…</div>
      </div>
    </div>`;

  if (item.status === 'error') return `
    <div class="part part-error" data-id="${item.id}">
      <div class="part-thumb part-thumb-error">${icon('alertTriangle', { size: 18 })}</div>
      <div class="part-main">
        <div class="part-name">${esc(item.name)}</div>
        <div class="part-spec part-spec-error">${esc(item.errorMsg || 'Could not read this file — is it a valid STL?')}</div>
      </div>
      <button class="part-remove-inline" data-action="remove-item" data-id="${item.id}">Remove</button>
    </div>`;

  const d     = item.data;
  const c     = item.cost;
  const ps    = item.settings.presupported;
  const dims  = c ? c.scaledDims : d.dimensions;
  const isPla = group.settings.printMethod === 'pla';
  const open  = !!item.expanded;
  const scaled = item.settings.scale !== 1;

  const thumbHTML = item.thumbnail
    ? `<img src="${item.thumbnail}" alt="" class="thumb-img" loading="lazy">`
    : `<span class="thumb-ph">STL</span>`;

  // Anything the customer must not miss stays on the collapsed row.
  const flags = [];
  if (c && !c.priceable) {
    flags.push(`<span class="part-flag part-flag-error">${icon('alertTriangle', { size: 13 })} Too large to print — scale down or split into parts</span>`);
  }
  if (item.warning) {
    flags.push(`<span class="part-flag part-flag-warn">${icon('alertTriangle', { size: 13 })} ${esc(item.warning)}</span>`);
  }

  const specBits = [];
  if (c && c.priceable) {
    specBits.push(`${fmtMm(dims.x)} × ${fmtMm(dims.y)} × ${fmtMm(dims.z)}`);
    specBits.push(c.tier ? `${esc(c.tier.name)} tier` : 'priced by volume');
    if (scaled) specBits.push(`${Math.round(item.settings.scale * 100)}% scale`);
    if (isPla) {
      const pc = (config.plaColors || []).find(p => p.id === item.settings.plaColor);
      if (pc) specBits.push(esc(pc.name));
    } else if (ps) {
      specBits.push('pre-supported');
    }
  } else {
    specBits.push(`${fmtMm(d.dimensions.x)} × ${fmtMm(d.dimensions.y)} × ${fmtMm(d.dimensions.z)}`);
  }

  const priceHTML = c && c.priceable
    ? `<span class="part-price-val">${fmt(c.totalCost, sym)}</span>${
         c.quantity > 1 ? `<span class="part-price-each">${fmt(c.unitCost, sym)} each</span>` : ''}`
    : `<span class="part-price-val part-price-na">—</span>`;

  return `
    <div class="part ${open ? 'open' : ''}" data-id="${item.id}">
      <button class="part-thumb" data-action="view3d" data-id="${item.id}"
              aria-label="View ${esc(item.name)} in 3D">
        ${thumbHTML}
        <span class="part-thumb-hint">${icon('eye', { size: 13 })}</span>
      </button>

      <div class="part-main">
        <div class="part-name" title="${esc(item.name)}">${esc(item.name)}</div>
        <div class="part-spec">${specBits.join(' · ')}</div>
        ${flags.join('')}
      </div>

      <div class="part-qty">
        <label class="sr-only" for="qty-${item.id}">Quantity of ${esc(item.name)}</label>
        <span class="part-qty-x" aria-hidden="true">Qty</span>
        <input type="number" id="qty-${item.id}" class="input-qty" value="${item.settings.quantity}"
               min="1" max="999" data-action="quantity" data-id="${item.id}">
      </div>

      <div class="part-price">${priceHTML}</div>

      <button class="part-toggle" data-action="toggle-part" data-id="${item.id}"
              aria-expanded="${open ? 'true' : 'false'}"
              aria-label="${open ? 'Hide' : 'Show'} options for ${esc(item.name)}">
        ${icon(open ? 'chevronUp' : 'chevronDown', { size: 16 })}
      </button>
    </div>

    ${open ? buildItemDetailHTML(item, group, { isPla, ps, c, sym, showMoveControl }) : ''}
  `;
}

// ---- Part detail (expanded) ------------------------------------------

function buildItemDetailHTML(item, group, ctx) {
  const { isPla, ps, c, sym, showMoveControl } = ctx;

  const supportsHTML = !isPla ? `
    <div class="pset">
      <div class="pset-label">
        Supports
        <span class="info-tip-wrap">
          <button type="button" class="info-tip-btn" data-action="toggle-info"
                  aria-label="What are supports?" aria-expanded="false">${icon('helpCircle', { size: 15 })}</button>
          <span class="info-tip-content" role="tooltip">
            Supports are temporary scaffolding that holds up overhanging parts while they print. If your file already has them built in, say so — it saves us time and costs less. Files without them are priced with an allowance for the support material we add.
          </span>
        </span>
      </div>
      <div class="seg">
        <button class="seg-btn ${!ps ? 'active' : ''}" data-action="presupported" data-id="${item.id}" data-val="false">We add supports</button>
        <button class="seg-btn ${ps ? 'active' : ''}" data-action="presupported" data-id="${item.id}" data-val="true">Already supported</button>
      </div>
    </div>` : '';

  const colorHTML = isPla ? `
    <div class="pset">
      <div class="pset-label">Filament colour <span class="pset-note">white, black &amp; dark grey included</span></div>
      <div class="pla-color-row">
        ${(config.plaColors || []).map(pc => {
          const active = item.settings.plaColor === pc.id;
          const pct = config.plaColorSurchargePct?.[pc.tier] ?? 0;
          const badge = pct > 0 ? `+${pct}%` : '';
          return `
            <button type="button" class="pla-swatch-btn" data-action="pla-color-select" data-id="${item.id}" data-color-id="${esc(pc.id)}"
                    title="${esc(pc.name)}${badge ? ' (' + badge + ')' : ''}" aria-label="${esc(pc.name)}" aria-pressed="${active}">
              <span class="pla-swatch ${active ? 'active' : ''}" style="background:${esc(pc.hex)};">
                ${active ? `<span class="primer-check">${icon('check', { size: 13 })}</span>` : ''}
              </span>
              <span class="pla-swatch-label">${esc(pc.name)}${badge ? `<span class="pla-swatch-badge">${badge}</span>` : ''}</span>
            </button>`;
        }).join('')}
      </div>
    </div>` : '';

  const moveHTML = showMoveControl ? `
    <div class="pset pset-inline">
      <label class="pset-label" for="move-${item.id}">Belongs to</label>
      <select class="input-group-move" id="move-${item.id}" data-action="move-item" data-id="${item.id}">
        ${groups.map(g => `<option value="${esc(g.id)}" ${g.id === group.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
        <option value="__new__">Move to a new model…</option>
      </select>
    </div>` : '';

  const breakdownHTML = (config.showCostBreakdown && c && c.priceable) ? `
    <details class="cost-details">
      <summary>How this price is worked out</summary>
      <table class="breakdown-table">
        ${c.tier ? `
          <tr><td>Size tier: ${esc(c.tier.name)} (up to ${c.tier.maxDimensionMm ? c.tier.maxDimensionMm + 'mm' : 'build plate'})</td><td>${fmt(c.tier.price, sym)}</td></tr>
          ${c.surchargePct > 0 ? `<tr><td>${esc(c.materialName)} surcharge (+${c.surchargePct}%)</td><td>${fmt(c.surchargeAmount, sym)}</td></tr>` : ''}
          ${c.supportHandlingFee > 0 ? `<tr><td>Support handling</td><td>${fmt(c.supportHandlingFee, sym)}</td></tr>` : ''}
        ` : `
          <tr><td>PLA volume (${c.scaledVolumeMl.toFixed(2)}mL × ${fmt(config.fdm?.costPerMl ?? 0, sym)}/mL)</td><td>${fmt(c.baseCost ?? c.unitCost, sym)}</td></tr>
          ${c.colorSurchargePct > 0 ? `<tr><td>Colour surcharge (+${c.colorSurchargePct}%)</td><td>${fmt(c.colorSurchargeAmount, sym)}</td></tr>` : ''}
        `}
      </table>
    </details>` : '';

  return `
    <div class="part-detail" data-detail-for="${item.id}">
      ${supportsHTML}
      ${colorHTML}

      <div class="pset pset-inline">
        <label class="pset-label" for="scale-${item.id}">Print scale</label>
        <div class="scale-ctl">
          <input type="number" class="input-scale" id="scale-${item.id}" value="${item.settings.scale}"
                 min="0.1" max="10" step="0.05" data-action="scale" data-id="${item.id}">
          <span class="scale-suffix">× original</span>
          ${item.settings.scale !== 1
            ? `<button class="scale-reset" data-action="scale-preset" data-scale="1" data-id="${item.id}">Reset to 100%</button>`
            : ''}
        </div>
      </div>

      ${moveHTML}
      ${breakdownHTML}

      <div class="pset-foot">
        <button class="part-delete-btn ${isArmedForDelete('item', item.id) ? 'armed' : ''}"
                data-action="remove-item" data-id="${item.id}">
          ${icon('trash', { size: 14 })} ${isArmedForDelete('item', item.id) ? 'Tap again to remove' : 'Remove this part'}
        </button>
      </div>
    </div>`;
}

// ---- Event handlers --------------------------------------------------

function handleGroupClick(e, group, card) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id     = btn.dataset.id;

  switch (action) {
    case 'delete-group':
      if (isArmedForDelete('group', group.id)) {
        disarmDelete();
        removeGroup(group.id);
      } else {
        armDelete('group', group.id);
      }
      break;

    case 'add-files-to-group':
      pickFiles(group.id);
      break;

    case 'toggle-model-settings':
      group.settingsOpen = !group.settingsOpen;
      renderAll();
      break;

    case 'toggle-part': {
      const found = findItem(id);
      if (found) {
        const wasOpen = found.item.expanded;
        // One part open at a time — an expanded row is a workspace, not a list.
        allItems().forEach(i => { i.expanded = false; });
        found.item.expanded = !wasOpen;
        renderAll();
      }
      break;
    }

    case 'remove-item': {
      // Failed/error uploads have nothing to lose — remove immediately.
      const found = findItem(id);
      if (found?.item.status === 'error') {
        removeItem(id);
      } else if (isArmedForDelete('item', id)) {
        disarmDelete();
        removeItem(id);
      } else {
        armDelete('item', id);
      }
      break;
    }

    case 'view3d':
      openModal(findItem(id)?.item);
      break;

    case 'assembly': {
      const val = btn.dataset.val === 'true';
      group.settings.assembly = val;
      recomputeGroup(group);
      renderAll();
      break;
    }

    case 'primer-select':
      group.settings.primer = btn.dataset.primerId;
      recomputeGroup(group);
      renderAll();
      break;

    case 'print-method': {
      const val = btn.dataset.val === 'pla' ? 'pla' : 'resin';
      if (group.settings.printMethod !== val) {
        group.settings.printMethod = val;
        group.items.forEach(recomputeItemCost);
        recomputeGroup(group);
        renderAll();
      }
      break;
    }

    case 'pla-color-select': {
      const found = findItem(id);
      if (found) {
        found.item.settings.plaColor = btn.dataset.colorId;
        recomputeItemCost(found.item);
        recomputeGroup(found.group);
        renderAll();
      }
      break;
    }

    case 'toggle-info': {
      const wrap = btn.closest('.info-tip-wrap');
      const open = wrap?.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      break;
    }

    case 'presupported': {
      const found = findItem(id);
      if (found) {
        found.item.settings.presupported = btn.dataset.val === 'true';
        recomputeItemCost(found.item);
        recomputeGroup(found.group);
        renderAll();
      }
      break;
    }

    case 'scale-preset': {
      const found = findItem(id);
      if (found) {
        found.item.settings.scale = parseFloat(btn.dataset.scale);
        recomputeItemCost(found.item);
        recomputeGroup(found.group);
        renderAll();
      }
      break;
    }
  }
}

function handleGroupChange(e, group) {
  const el     = e.target;
  const action = el.dataset.action;
  const id     = el.dataset.id;

  if (action === 'move-item') {
    if (el.value === '__new__') {
      const newGroup = createGroup(`Model ${groups.length + 1}`);
      groups.push(newGroup);
      moveItemToGroup(id, newGroup.id);
    } else {
      moveItemToGroup(id, el.value);
    }
    return;
  }

  const found = findItem(id);
  if (!found) return;
  const { item } = found;

  if (action === 'scale') {
    const v = parseFloat(el.value);
    if (!isNaN(v) && v > 0) item.settings.scale = v;
  } else if (action === 'quantity') {
    const v = parseInt(el.value);
    if (!isNaN(v) && v > 0) item.settings.quantity = v;
  }

  recomputeItemCost(item);
  recomputeGroup(found.group);
  renderAll();
}

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

// What the next batch of files means. Set by whichever control opened the
// picker, so grouping is decided by what the customer asked for rather than
// inferred from how many files they happened to select.
//   'single'  — each file becomes its own model
//   'model'   — all files land in one new multi-part model
//   <groupId> — all files join that existing model
let _uploadIntent = 'single';

async function handleFilesForGroup(files) {
  const intent  = _uploadIntent;
  _uploadIntent = 'single';

  const validFiles = [];
  for (const file of files) {
    const fname = file.name.toLowerCase();
    if (fname.endsWith('.stl') || fname.endsWith('.lys')) {
      validFiles.push(file);
    } else {
      showToast(`${file.name} — unsupported file type. Please use .stl files.`, 'error');
    }
  }
  if (!validFiles.length) return;

  const firstUpload = !groups.some(g => g.items.length);

  if (intent === 'single') {
    // One model per file, however many were selected.
    for (const file of validFiles) {
      const g = createGroup(nextModelName());
      groups.push(g);
      await addFileToGroup(file, g);
    }
  } else if (intent === 'model') {
    const g = createGroup(nextModelName());
    groups.push(g);
    for (const file of validFiles) await addFileToGroup(file, g);
    checkAssemblyUnlocked(g);
  } else {
    const g = groups.find(x => x.id === intent) ?? ensureGroup();
    for (const file of validFiles) await addFileToGroup(file, g);
    checkAssemblyUnlocked(g);
  }

  // Show the controls once, on the very first part, so they're discovered
  // rather than hidden — after that everything opens on request.
  if (firstUpload && allItems().length === 1) {
    const first = allItems()[0];
    if (first.status === 'ready') first.expanded = true;
  }
  renderAll();
}

function nextModelName() {
  return `Model ${groups.length + 1}`;
}

/**
 * Assembly only exists once a model has 2+ parts. The moment it becomes
 * available, open the model's settings and flag it for a one-shot highlight
 * so the new option is noticed instead of silently appearing.
 */
function checkAssemblyUnlocked(group) {
  const parts = group.items
    .filter(i => i.status === 'ready' && i.cost)
    .reduce((s, i) => s + i.settings.quantity, 0);
  if (parts >= 2 && !group._assemblyAnnounced) {
    group._assemblyAnnounced = true;
    group.settingsOpen = true;
    group.justUnlocked = true;
    setTimeout(() => { group.justUnlocked = false; renderAll(); }, 2200);
  }
}

async function addFileToGroup(file, targetGroup) {
  const fname = file.name.toLowerCase();

  // .lys = Lychee Slicer project — can't parse directly, guide user to export STL
  if (fname.endsWith('.lys')) {
    const lItem = {
      id: iId(), file, name: file.name, size: file.size,
      status: 'error', data: null, thumbnail: null,
      settings: {}, cost: null, warning: null,
      errorMsg: 'Lychee Slicer (.lys) files cannot be read here. To add this model: open it in Lychee Slicer → File → Export → Export Model as STL, then upload the exported STL file.',
    };
    targetGroup.items.push(lItem);
    renderAll();
    return;
  }

  const item = {
    id: iId(), file, name: file.name, size: file.size,
    status: 'loading', data: null, thumbnail: null,
    settings: { scale: 1.0, quantity: 1, materialId: config.materials[0].id, presupported: false, plaColor: 'black' },
    cost: null, warning: null,
  };
  targetGroup.items.push(item);
  renderAll();

  try {
    item.data = await parseSTLFile(file);

    // Basic mesh validation
    if (item.data.triangleCount === 0) {
      throw new Error('File appears empty — no geometry found. Please re-export the model and try again.');
    }
    if (item.data.volumeMl <= 0.001) {
      item.warning = 'Volume is near zero — this model may have mesh errors. The price estimate may be inaccurate. Please check your file in your slicer before submitting.';
    }

    item.thumbnail = generateThumbnail(item.data.triangles);
    item.status    = 'ready';
    recomputeItemCost(item);
    recomputeGroup(targetGroup);
  } catch (err) {
    item.status   = 'error';
    item.errorMsg = err.message;
  }
  renderAll();
}

// ---- Order helpers ---------------------------------------------------

function generateOrderNumber() {
  const d    = new Date();
  const date = d.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `AF-${date}-${rand}`;
}

/**
 * Build the HTML for one model group in the review screen.
 * Shows thumbnails, per-file details, extras (assembly/primer/labour), subtotal.
 */
function buildReviewGroupHTML(group, sym) {
  const gc = group.groupCost;
  if (!gc) return '';
  const readyItems = group.items.filter(i => i.status === 'ready' && i.cost?.priceable);

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
            &middot; ${i.cost.tier ? esc(i.cost.tier.name) + ' tier' : 'volume-priced'}
          </div>
        </div>
        <div class="review-file-cost">${fmt(i.cost.totalCost, sym)}</div>
      </div>`;
  }).join('');

  const extraLines = (group.settings.extras || []).map(extraId => {
    const extra = config.extras.find(e => e.id === extraId);
    return extra ? `<div class="review-extra-row"><span>${icon('plus', { size: 13 })} ${esc(extra.name)}</span><span>+${fmt(extra.price, sym)}</span></div>` : '';
  }).join('');

  const otherExtras = [];
  if (gc.assemblyCost > 0)
    otherExtras.push(`<div class="review-extra-row"><span>${icon('puzzle', { size: 13 })} Assembly</span><span>+${fmt(gc.assemblyCost, sym)}</span></div>`);
  if (gc.isPrimed)
    otherExtras.push(`<div class="review-extra-row"><span>${icon('paintbrush', { size: 13 })} ${esc(config.primerOptions.find(p => p.id === gc.primerLabel)?.label || 'Primer')}</span><span>+${fmt(gc.primerTotal, sym)}</span></div>`);
  if (gc.plaColorCost > 0)
    otherExtras.push(`<div class="review-extra-row"><span>${icon('layers', { size: 13 })} Colour surcharge</span><span>+${fmt(gc.plaColorCost, sym)}</span></div>`);

  const notesHTML = group.settings.notes?.trim()
    ? `<div class="review-extra-row"><span>${icon('note', { size: 13 })} Notes</span><span>${esc(group.settings.notes.trim())}</span></div>`
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

/** Advance from review step → contact form step */
function showOrderForm() {
  const ref = document.getElementById('form-order-ref');
  if (ref) ref.textContent = _orderNumber ?? '—';
  document.getElementById('order-review-wrap').style.display  = 'none';
  document.getElementById('order-form-wrap').style.display    = 'block';
  document.getElementById('order-panel-title').textContent    = 'Contact Details';
  document.querySelector('.order-panel')?.scrollTo(0, 0);
}

// ---- Order summary ---------------------------------------------------

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

  const grandTotal = calcOrderTotal(activeGroups, config);
  const minimumShortfall = calcOrderMinimumShortfall(activeGroups, config);

  const groupLines = activeGroups.map(g => {
    const gc = g.groupCost;
    if (!gc) return '';
    return `
      <div class="summary-group">
        <div class="summary-group-name">${esc(g.name)}</div>
        ${g.items.filter(i => i.status === 'ready').map(i => `
          <div class="summary-line">
            <span class="sum-name" title="${esc(i.name)}">${esc(shortName(i.name))}</span>
            <span class="sum-qty">×${i.settings.quantity}</span>
            <span class="sum-price">${i.cost?.priceable ? fmt(i.cost.totalCost, sym) : '<span class="text-error">Too large</span>'}</span>
          </div>
          <div class="sum-file-detail">
            ${esc(i.cost.materialName)} · ${Math.round(i.settings.scale * 100)}% scale${g.settings.printMethod === 'pla' ? '' : ` · ${i.settings.presupported ? '<span style="color:var(--green)">Pre-sup.</span>' : 'Std. supports'}`}
          </div>`).join('')}
        ${gc.extrasCost > 0 ? `
          <div class="summary-line summary-line-extra">
            <span class="sum-name">${icon('plus', { size: 13 })} Extras</span><span></span>
            <span class="sum-price">+${fmt(gc.extrasCost, sym)}</span>
          </div>` : ''}
        ${gc.assemblyCost > 0 ? `
          <div class="summary-line summary-line-extra">
            <span class="sum-name">${icon('puzzle', { size: 13 })} Assembly</span><span></span>
            <span class="sum-price">+${fmt(gc.assemblyCost, sym)}</span>
          </div>` : ''}
        ${gc.isPrimed ? `
          <div class="summary-line summary-line-extra">
            <span class="sum-name">${icon('paintbrush', { size: 13 })} ${esc(config.primerOptions.find(p => p.id === gc.primerLabel)?.label || 'Primer')}</span><span></span>
            <span class="sum-price">+${fmt(gc.primerTotal, sym)}</span>
          </div>` : ''}
        <div class="summary-group-subtotal">
          <span>${esc(g.name)} total</span>
          <span>${fmt(gc.groupTotal, sym)}</span>
        </div>
      </div>`;
  }).join('');

  if (panel) panel.innerHTML = `
    <h2 class="summary-title">Order Summary</h2>
    <div class="summary-groups">${groupLines}</div>
    <div class="summary-divider"></div>
    <div class="summary-total">
      <span>${exceedsCustomQuoteThreshold(grandTotal, config) ? 'Estimate' : 'Grand total'}</span>
      <span>${fmt(grandTotal, sym)}</span>
    </div>
    ${minimumShortfall > 0 ? `
      <p class="summary-min-note">${icon('sparkles', { size: 14 })} You're already covered by our ${fmt(config.minimumOrderTotal, sym)} order minimum — add up to ${fmt(minimumShortfall, sym)} more in parts at no extra cost.</p>
    ` : ''}
    ${exceedsCustomQuoteThreshold(grandTotal, config) ? `
      <p class="summary-note summary-note-quote">${icon('info', { size: 14 })} Over ${fmt(config.customQuoteOrderThreshold, sym)} we price by hand — this figure is a guide, not your final quote.</p>
    ` : `
      <p class="summary-note">${icon('lightbulb', { size: 14 })} Estimate only — we confirm the final price once we've checked your files.</p>
    `}
    <button class="btn btn-primary btn-lg" id="request-quote-btn">Request a quote ${icon('arrowRight', { size: 15 })}</button>
  `;
  document.getElementById('request-quote-btn')?.addEventListener('click', openOrderForm);

  if (mobileBar) {
    mobileBar.classList.remove('empty');
    const itemCount = activeGroups.reduce(
      (n, g) => n + g.items.filter(i => i.status === 'ready').length, 0
    );
    document.getElementById('mobile-summary-count').textContent =
      `${itemCount} item${itemCount === 1 ? '' : 's'}`;
    document.getElementById('mobile-summary-total').textContent = fmt(grandTotal, sym);
  }
}

// ---- Modal -----------------------------------------------------------

// Threshold: auto-load 3D viewer if model has fewer than this many triangles.
// Larger models show a static thumbnail with a manual "Load 3D" button.
const TRIS_AUTO_LOAD = 80_000;

function setupModal() {
  const modal = document.getElementById('viewer-modal');
  if (!modal) return;
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  document.getElementById('modal-close')?.addEventListener('click', closeModal);

  // Theme switcher — update active button and re-theme live viewer
  document.getElementById('viewer-theme-btns')?.addEventListener('click', e => {
    const btn = e.target.closest('.theme-btn');
    if (!btn) return;
    document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    modalViewer?.setTheme(btn.dataset.theme);
  });
}

function openModal(item) {
  if (!item || item.status !== 'ready') return;

  const modal      = document.getElementById('viewer-modal');
  const canvas     = document.getElementById('modal-canvas');
  const staticWrap = document.getElementById('modal-static-wrap');
  const staticImg  = document.getElementById('modal-static-img');
  const perfNote   = document.getElementById('modal-perf-note');
  if (!modal || !canvas) return;

  // Update title
  modal.querySelector('.modal-title').textContent = item.name;
  modal.classList.add('open');

  // Dispose any previous viewer
  if (modalViewer) { modalViewer.dispose(); modalViewer = null; }

  const tris = item.data.triangleCount;

  if (tris <= TRIS_AUTO_LOAD) {
    // Small model — load 3D immediately
    if (staticWrap) staticWrap.style.display = 'none';
    canvas.style.display = '';
    _doLoad3D(item, canvas);
  } else {
    // Large model — show static thumbnail, let user opt into 3D
    canvas.style.display = 'none';
    if (staticWrap) {
      staticWrap.style.display = 'flex';
      if (staticImg)  staticImg.src = item.thumbnail || '';
      if (perfNote) {
        const mb = (item.size / 1048576).toFixed(1);
        perfNote.textContent = `${tris.toLocaleString()} triangles · ${mb} MB — may be slow on older devices`;
      }

      // Clone the button to remove any old click listeners
      const oldBtn = document.getElementById('modal-load-3d-btn');
      if (oldBtn) {
        const newBtn = oldBtn.cloneNode(true);
        oldBtn.parentNode.replaceChild(newBtn, oldBtn);
        newBtn.addEventListener('click', () => {
          staticWrap.style.display = 'none';
          canvas.style.display = '';
          _doLoad3D(item, canvas);
        });
      }
    }
  }
}

/** Initialise STLViewer, load geometry, apply current theme. */
function _doLoad3D(item, canvas) {
  modalViewer = new STLViewer(canvas);
  modalViewer.load(item.data.triangles);

  // Apply whichever theme button is currently active
  const activeThemeBtn = document.querySelector('.theme-btn.active');
  if (activeThemeBtn && activeThemeBtn.dataset.theme !== 'resin') {
    modalViewer.setTheme(activeThemeBtn.dataset.theme);
  }

  // Fit canvas to its container now that it's visible
  requestAnimationFrame(() => {
    const w = canvas.parentElement.clientWidth;
    const h = canvas.parentElement.clientHeight;
    if (w && h) {
      canvas.width  = w;
      canvas.height = h;
      modalViewer?.resize(w, h);
    }
  });
}

function closeModal() {
  document.getElementById('viewer-modal')?.classList.remove('open');
  if (modalViewer) { modalViewer.dispose(); modalViewer = null; }
}

// ---- Order form ------------------------------------------------------

function setupOrderForm() {
  const overlay = document.getElementById('order-overlay');
  overlay?.addEventListener('click', e => { if (e.target === overlay) closeOrderForm(); });
  document.getElementById('order-close')?.addEventListener('click', closeOrderForm);
  document.getElementById('order-form')?.addEventListener('submit', submitOrder);

  // Review step → form step
  document.getElementById('review-continue-btn')?.addEventListener('click', showOrderForm);

  // Form step → back to review
  document.getElementById('order-back-btn')?.addEventListener('click', () => {
    document.getElementById('order-form-wrap').style.display   = 'none';
    document.getElementById('order-review-wrap').style.display = 'block';
    document.getElementById('order-panel-title').textContent   = 'Review Your Order';
    document.querySelector('.order-panel')?.scrollTo(0, 0);
  });
}

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
  const minimumShortfall = calcOrderMinimumShortfall(activeGroups, config);

  // Above the threshold the calculator stops presenting a price at all —
  // the order is hand-quoted, so showing a total here would set an
  // expectation we haven't agreed to. Everything else about the flow is
  // unchanged: it's still a quote request, just an honestly labelled one.
  const needsCustomQuote = exceedsCustomQuoteThreshold(grandTotal, config);
  const reviewWrap = document.getElementById('order-review-wrap');
  reviewWrap?.classList.toggle('custom-quote', needsCustomQuote);

  const quoteNoteEl = document.getElementById('review-custom-quote-note');
  if (quoteNoteEl) {
    quoteNoteEl.style.display = needsCustomQuote ? 'block' : 'none';
    quoteNoteEl.innerHTML = `${icon('info', { size: 15 })} <strong>This one we price by hand.</strong>
      Orders over ${fmt(config.customQuoteOrderThreshold, sym)} are quoted individually — the figure below is what
      the calculator worked out, but it isn't your final price. Send it through and we'll come back with a firm
      quote, usually within one working day.`;
  }

  const totalLabelEl = document.getElementById('review-total-label');
  if (totalLabelEl) totalLabelEl.textContent = needsCustomQuote ? 'Calculator estimate (not final)' : 'Grand total (estimated)';

  const submitBtn = document.getElementById('order-submit-btn');
  if (submitBtn) {
    submitBtn.removeAttribute('data-icon-suffix');
    submitBtn.innerHTML =
      `${needsCustomQuote ? 'Request a hand-priced quote' : 'Send quote request'} ${icon('arrowRight', { size: 15 })}`;
  }

  const minNoteEl = document.getElementById('review-minimum-note');
  if (minNoteEl) {
    minNoteEl.style.display = minimumShortfall > 0 ? 'block' : 'none';
    minNoteEl.innerHTML = `${icon('sparkles', { size: 14 })} You're already covered by our ${fmt(config.minimumOrderTotal, sym)} order minimum — add up to ${fmt(minimumShortfall, sym)} more in parts at no extra cost!`;
  }

  // Populate review step
  const numEl = document.getElementById('review-order-number');
  if (numEl) numEl.textContent = _orderNumber;
  const totEl = document.getElementById('review-order-total');
  if (totEl) totEl.textContent = fmt(grandTotal, sym);
  const cont = document.getElementById('review-groups-container');
  if (cont) cont.innerHTML = activeGroups.map(g => buildReviewGroupHTML(g, sym)).join('');

  // Show review step (step 1)
  document.getElementById('order-review-wrap').style.display   = 'block';
  document.getElementById('order-form-wrap').style.display     = 'none';
  document.getElementById('order-success-wrap').style.display  = 'none';
  document.getElementById('order-panel-title').textContent     = 'Review Your Order';

  overlay.classList.add('open');
  document.querySelector('.order-panel')?.scrollTo(0, 0);
}

function closeOrderForm() {
  document.getElementById('order-overlay')?.classList.remove('open');
}

function submitOrder(e) {
  e.preventDefault();
  const form       = e.target;
  const name       = form.querySelector('[name="cust-name"]').value.trim();
  const email      = form.querySelector('[name="cust-email"]').value.trim();
  const notes      = form.querySelector('[name="cust-notes"]').value.trim();
  const disclaimer = form.querySelector('[name="disclaimer"]').checked;

  if (!name || !email) { showToast('Please fill in your name and email.', 'error'); return; }
  if (!disclaimer)     { showToast('Please tick the confirmation checkbox to continue.', 'error'); return; }

  const activeGroups = groups.filter(g => g.items.some(i => i.status === 'ready'));
  const grandTotal   = calcOrderTotal(activeGroups, config);

  const payload = {
    orderNumber: _orderNumber,
    customer: { name, email, notes },
    groups: activeGroups.map(g => ({
      name:        g.name,
      extras:      g.settings.extras,
      notes:       g.settings.notes,
      assembly:    g.settings.assembly,
      primer:      g.settings.primer,
      printMethod: g.settings.printMethod,
      cost:        g.groupCost?.groupTotal,
      files:    g.items.filter(i => i.status === 'ready' && i.cost?.priceable).map(i => ({
        filename:     i.name,
        material:     i.cost.materialName,
        plaColor:     g.settings.printMethod === 'pla' ? i.settings.plaColor : undefined,
        presupported: i.settings.presupported,
        scale:        i.settings.scale,
        quantity:     i.settings.quantity,
        tier:         i.cost.tier?.name ?? 'volume-priced',
        unitCost:     i.cost.unitCost,
        total:        i.cost.totalCost,
      })),
    })),
    grandTotal,
    submittedAt: new Date().toISOString(),
  };
  console.info('Quote payload:', payload);

  // ---- Shopify integration point ----
  // fetch('/cart/add.js', { method:'POST', body: JSON.stringify(buildShopifyPayload(payload)) });
  // -----------------------------------

  document.getElementById('order-form-wrap').style.display    = 'none';
  document.getElementById('order-success-wrap').style.display = 'flex';
  document.getElementById('order-success-email').textContent  = email;
  document.getElementById('order-success-number').textContent = _orderNumber ?? '—';
}

// ---- Utilities -------------------------------------------------------

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function shortName(name, max = 28) {
  return name.length > max ? name.slice(0, max - 3) + '…' : name;
}
function formatBytes(bytes) {
  if (bytes < 1024)    return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

let _toastTimer;
function showToast(msg, type = 'info') {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.className   = `toast toast-${type} show`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

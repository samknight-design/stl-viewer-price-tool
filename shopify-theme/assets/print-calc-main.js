// ============================================================
// main.js — App orchestration
// Groups: each model group has primer / assembly / labour settings.
// Files belong to a group. Multiple groups = multiple models.
// ============================================================

import { getConfig, RELAY_BASE_URL } from './print-calc-config.js?v=bb5826ba86';
import { parseSTLFile } from './print-calc-stl-parser.js?v=8ade704353';
import { generateThumbnail, STLViewer } from './print-calc-viewer.js?v=097e779d64';
import { icon, applyStaticIcons } from './print-calc-icons.js?v=dbcda99c8c';
import {
  calcItemCost, calcGroupCost, calcOrderTotal, calcOrderMinimumShortfall,
  exceedsCustomQuoteThreshold, fmt, fmtMm,
} from './print-calc-calculator.js?v=63496ddb25';

// ---- State -----------------------------------------------------------
let config      = null;
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

document.addEventListener('DOMContentLoaded', async () => {
  config = await getConfig();
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
    settingsOpen: true,    // model settings — open by default; this is the model's face, not a drawer
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
    canAssemble ? (assemblyActive ? 'Assembled' : 'Loose parts') : null,   // chip stays terse; the control carries the full wording
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
        <span class="name-edit">
          <input class="model-name" value="${esc(group.name)}" data-action="rename"
                 size="${Math.max(8, group.name.length)}"
                 aria-label="Model name" spellcheck="false">
          ${icon('pencil', { size: 12, className: 'name-edit-pencil' })}
        </span>
      </div>
      <div class="model-bar-meta">
        <span class="model-chips">${chips.map(c => `<span>${esc(c)}</span>`).join('')}</span>
        <span class="model-count">${partCountLabel}</span>
      </div>
      <div class="model-bar-end">
        <span class="model-total">${gc && pricedItems.length ? fmt(gc.groupTotal, sym) : '—'}</span>
        <button class="model-opts-btn ${group.settingsOpen ? 'open' : ''}" data-action="toggle-model-settings"
                aria-expanded="${group.settingsOpen ? 'true' : 'false'}"
                aria-label="${group.settingsOpen ? 'Hide' : 'Show'} options for ${esc(group.name)}">
          ${icon(group.settingsOpen ? 'chevronUp' : 'chevronDown', { size: 16 })}
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

/**
 * Swatch captions carry the colour only — the swatch already says "primer",
 * and the full label is still what shows on the order summary and quote.
 */
function shortPrimerLabel(option) {
  if (option.id === 'unprimed') return 'None';
  return option.label.replace(/\s*primer\s*$/i, '');
}

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
        <span class="primer-swatch-label">${esc(shortPrimerLabel(p))}</span>
      </button>`;
  }).join('');

  const primerCostHint = (group.settings.primer !== 'unprimed' && gc)
    ? `<span class="setting-cost-hint">+${fmt(gc.primerTotal, sym)}</span>` : '';
  const assemblyCostHint = (assemblyActive && gc)
    ? ` <span class="setting-cost-hint">+${fmt(gc.assemblyCost, sym)}</span>` : '';

  return `
    <div class="model-settings">

      <div class="mset">
        <span class="mset-head">
          <span class="mset-label">Material</span>
          <span class="info-tip-wrap">
            <button type="button" class="info-tip-btn" data-action="toggle-info"
                    aria-label="Resin or PLA?" aria-expanded="false">${icon('helpCircle', { size: 14 })}</button>
            <span class="info-tip-content" role="tooltip">
              <strong>Resin</strong> — finest detail, best for miniatures.<br>
              <strong>PLA</strong> — tougher and cheaper on bigger parts. You pick a colour per part.
            </span>
          </span>
        </span>
        <span class="seg seg-sm">
          <button class="seg-btn ${!isPlaModel ? 'active' : ''}" data-action="print-method" data-val="resin">Resin</button>
          <button class="seg-btn ${isPlaModel ? 'active' : ''}" data-action="print-method" data-val="pla">PLA</button>
        </span>
      </div>

      <div class="mset">
        <span class="mset-head">
          <span class="mset-label">Primer</span>
          <span class="info-tip-wrap">
            <button type="button" class="info-tip-btn" data-action="toggle-info"
                    aria-label="What is primer?" aria-expanded="false">${icon('helpCircle', { size: 14 })}</button>
            <span class="info-tip-content" role="tooltip">
              A sprayed base coat, ready for you to paint. Helps paint grip and softens layer lines.
            </span>
          </span>
        </span>
        <span class="primer-row">${primerSwatchesHTML}${primerCostHint}</span>
      </div>

      ${canAssemble ? `
      <div class="mset">
        <span class="mset-label">Assembly</span>
        <span class="seg seg-sm">
          <button class="seg-btn ${!assemblyActive ? 'active' : ''}" data-action="assembly" data-val="false">Receive as loose parts</button>
          <button class="seg-btn ${assemblyActive ? 'active' : ''}" data-action="assembly" data-val="true">Receive assembled${assemblyCostHint}</button>
        </span>
      </div>` : ''}

      <div class="mset mset-notes">
        <label class="mset-label" for="notes-${group.id}">Notes</label>
        <textarea class="mset-notes-input" id="notes-${group.id}" data-action="notes" rows="2"
                  placeholder="Anything we should know about this model">${esc(group.settings.notes || '')}</textarea>
      </div>

      <div class="mset-foot">
        <p class="mset-hint">Working from an AI-generated model? Mention it here &mdash; they often need thin walls or overhangs fixing before they print cleanly, and we'll check yours first.</p>
        <button class="model-delete-btn ${isArmedForDelete('group', group.id) ? 'armed' : ''}"
                data-action="delete-group">
          ${icon('trash', { size: 14 })} ${isArmedForDelete('group', group.id) ? 'Tap again to delete' : 'Delete model'}
        </button>
      </div>

    </div>`;
}

// ---- Part row HTML ---------------------------------------------------
// At rest a part is one line: what it is, how big, how many, how much.
// Everything that changes it lives behind the row's own disclosure.

/** What to call a part on screen: the customer's label, else the filename. */
function partLabel(item) {
  return (item.label || '').trim() || item.name;
}

function buildItemHTML(item, group, showMoveControl) {
  const sym = config.currencySymbol;

  if (item.status === 'loading') return `
    <div class="part part-loading" data-id="${item.id}">
      <div class="part-thumb"><div class="pc-spinner"></div></div>
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
        <div class="name-edit">
          <input class="part-name" value="${esc(partLabel(item))}" data-action="rename-part" data-id="${item.id}"
                 size="${Math.max(8, partLabel(item).length)}"
                 title="${esc(item.name)}" aria-label="Name for ${esc(item.name)}" spellcheck="false">
          ${icon('pencil', { size: 12, className: 'name-edit-pencil' })}
        </div>
        <div class="part-spec">${specBits.join(' · ')}</div>
        ${flags.join('')}
      </div>

      ${!isPla ? `
      <div class="part-supports" role="group" aria-label="Supports for ${esc(item.name)}">
        <span class="part-supports-label">Supports</span>
        <span class="mini-seg">
          <button class="mini-seg-btn ${!ps ? 'active' : ''}" data-action="presupported"
                  data-id="${item.id}" data-val="false" title="We add supports for you">We add</button>
          <button class="mini-seg-btn ${ps ? 'active' : ''}" data-action="presupported"
                  data-id="${item.id}" data-val="true" title="Your file already has supports built in">Pre-supported</button>
        </span>
      </div>` : ''}

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

  // Supports now lives on the part row — see buildItemHTML.

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
  if (el.dataset.action === 'rename-part') {
    const found = findItem(el.dataset.id);
    if (found) {
      // Clearing the field falls back to the filename rather than leaving a
      // nameless part.
      found.item.label = el.value;
      renderOrderSummary();
    }
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

// Chain background Shopify-file uploads one after another instead of
// letting a multi-file drop fire them all concurrently — see the comment
// at its use in addFileToGroup().
let _uploadChain = Promise.resolve();

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
    label: '',
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

    // Compute pricing immediately — don't make the user wait on the
    // Shopify file-upload round trip below just to see a price.
    recomputeItemCost(item);
    recomputeGroup(targetGroup);

    // Fire-and-forget from the pricing UI's point of view: upload the STL +
    // thumbnail to Supabase Storage in the background so pricing doesn't
    // wait on the round trip. Non-fatal if it fails — pricing still works
    // without the hosted copy, the packing tool just won't have a
    // file/thumbnail reference for this part. The promise itself is kept on
    // the item (not truly discarded) so submitOrder() can await any still-
    // in-flight uploads before reading item.fileUrl/thumbnailUrl —
    // otherwise a fast submit could race the upload and silently ship null
    // file URLs (see uploadItemToShopify's own doc comment).
    //
    // Queued (not fired concurrently): firing every file's upload at once —
    // exactly what a multi-file drop used to do under the old base64-relay
    // approach — piled multiple in-memory copies up simultaneously and
    // could exhaust the tab's memory on its own. Uploads now go straight to
    // storage with no base64 copy, but chaining onto _uploadChain still caps
    // this to one file's worth of in-flight request at a time.
    // uploadItemToShopify() never rejects (it catches its own errors), so
    // chaining is safe — one slow/failed upload can't break the queue.
    _uploadChain = _uploadChain.then(() => uploadItemToShopify(item, file));
    item.uploadPromise = _uploadChain;
  } catch (err) {
    item.status   = 'error';
    item.errorMsg = err.message;
  }
  renderAll();
}

const RELAY_TIMEOUT_MS = 15_000;    // small JSON round trip to the relay (stage)
const FILE_PUT_TIMEOUT_MS = 60_000; // the actual file transfer, direct to storage

/** fetch() with a hard timeout — without this, a stalled request could hang
 *  uploadItemToShopify()'s promise forever, which would in turn block
 *  submitOrder() (it awaits any still-in-flight upload) with no way out
 *  short of reloading the page. */
function fetchWithTimeout(url, options, timeoutMs = RELAY_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/**
 * Uploads a file straight to Supabase Storage instead of routing its bytes
 * through the relay. Two steps: (1) ask the relay for a signed upload URL —
 * a small JSON exchange regardless of file size; (2) PUT the raw file
 * directly to that URL, bypassing the relay entirely for the actual bytes.
 * The returned publicUrl is immediately valid, no separate finalize step.
 *
 * Previously this uploaded to Shopify Files, but Shopify's Admin API
 * hard-caps generic FILE-resource uploads at 20MB regardless of any size
 * hint we send — real STL files routinely exceed that. Supabase Storage's
 * own signed-upload-URL pattern is the same direct-from-browser
 * architecture, just pointed at a bucket we control (50MB cap on this
 * project's free plan; raised on Pro).
 */
async function uploadFileDirect(fileOrBlob, filename, mimeType) {
  const stageRes = await fetchWithTimeout(`${RELAY_BASE_URL}/files/stage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, mimeType, fileSize: fileOrBlob.size }),
  });
  if (!stageRes.ok) throw new Error(`Stage upload failed: HTTP ${stageRes.status}`);
  const { uploadUrl, publicUrl } = await stageRes.json();

  const putRes = await fetchWithTimeout(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: fileOrBlob,
  }, FILE_PUT_TIMEOUT_MS);
  if (!putRes.ok) throw new Error(`Direct upload failed: HTTP ${putRes.status}`);

  return publicUrl;
}

/** Upload an item's STL bytes + thumbnail to Supabase Storage, without
 *  blocking the caller. Sets item.fileUrl / item.thumbnailUrl on success and
 *  re-renders. No size cap needed here — uploads go straight to storage
 *  (see uploadFileDirect), so the relay never holds the file in memory
 *  regardless of how large it is. */
async function uploadItemToShopify(item, file) {
  try {
    item.fileUrl = await uploadFileDirect(file, item.name, 'model/stl');

    if (item.thumbnail) {
      const thumbBlob = await (await fetch(item.thumbnail)).blob();
      item.thumbnailUrl = await uploadFileDirect(thumbBlob, item.name.replace(/\.stl$/i, '.png'), 'image/png');
    }
  } catch (err) {
    console.warn('File upload failed for', item.name, err);
  } finally {
    renderAll();
  }
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
          <div class="review-file-name">${esc(shortName(partLabel(i), 38))}</div>
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
  clearFormError();
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

  // Below the custom-quote threshold the order ends up in the cart rather than
  // in a manual quote, so the summary's primary action shouldn't promise a
  // quote either — it opens the same review step the submit button finishes.
  const isQuote = exceedsCustomQuoteThreshold(grandTotal, config);

  const groupLines = activeGroups.map(g => {
    const gc = g.groupCost;
    if (!gc) return '';
    return `
      <div class="summary-group">
        <div class="summary-group-name">${esc(g.name)}</div>
        ${g.items.filter(i => i.status === 'ready').map(i => `
          <div class="summary-line">
            <span class="sum-name" title="${esc(i.name)}">${esc(shortName(partLabel(i)))}</span>
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
    ${isQuote ? `
      <p class="summary-note summary-note-quote">${icon('info', { size: 14 })} Over ${fmt(config.customQuoteOrderThreshold, sym)} we price by hand — this figure is a guide, not your final quote.</p>
    ` : `
      <p class="summary-note">${icon('lightbulb', { size: 14 })} Estimate only — we confirm the final price once we've checked your files.</p>
    `}
    <button class="btn btn-primary btn-lg" id="request-quote-btn">${isQuote ? 'Request a quote' : 'Add to cart'} ${icon(isQuote ? 'arrowRight' : 'cart', { size: 15 })}</button>
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
  // Clear the validation message as soon as the customer acts on it, so a
  // stale error can't sit there contradicting what they've just filled in.
  document.getElementById('order-form')?.addEventListener('input', clearFormError);
  document.getElementById('order-form')?.addEventListener('change', clearFormError);

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

/**
 * Returns the submit button's label and icon slots, creating them when the
 * rendered markup predates them.
 *
 * The label and the icon have to be separate child elements so each can be
 * updated without destroying the other, but the theme snippet that declares
 * them deploys independently of this file. A theme carrying an older snippet
 * would otherwise leave the button stuck on its hardcoded "Submit Quote
 * Request" text — which reads as a broken quote flow when the order is
 * actually headed for the cart. Rebuilding the slots here keeps the button
 * correct regardless of which snippet version the theme happens to serve.
 */
function ensureSubmitButtonParts() {
  const btn = document.getElementById('order-submit-btn')
    || document.querySelector('#order-form button[type="submit"]');
  if (!btn) return {};

  let label = document.getElementById('order-submit-label');
  let iconSlot = document.getElementById('order-submit-icon');
  if (!label || !iconSlot) {
    // Drop the static-icon hook as well, so a later applyStaticIcons pass
    // can't append a second, stale icon beside the one managed here.
    btn.removeAttribute('data-icon-suffix');
    btn.textContent = '';
    label = document.createElement('span');
    label.id = 'order-submit-label';
    iconSlot = document.createElement('span');
    iconSlot.id = 'order-submit-icon';
    btn.append(label, iconSlot);
  }
  return { btn, label, iconSlot };
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

  // Above the threshold the order stops being a self-serve checkout and
  // becomes a hand-priced quote, so the screen stops presenting the figure
  // as a price: the notice leads, the total is relabelled and de-emphasised,
  // and the button says what will actually happen.
  const isQuote = exceedsCustomQuoteThreshold(grandTotal, config);

  const reviewWrap = document.getElementById('order-review-wrap');
  reviewWrap?.classList.toggle('custom-quote', isQuote);

  const quoteNoteEl = document.getElementById('review-custom-quote-note');
  if (quoteNoteEl) {
    quoteNoteEl.style.display = isQuote ? 'block' : 'none';
    if (isQuote) {
      quoteNoteEl.innerHTML = `${icon('info', { size: 15 })} <strong>This one we price by hand.</strong>
        Orders over ${fmt(config.customQuoteOrderThreshold, sym)} are quoted individually — the figure below is what
        the calculator worked out, but it isn't your final price. Send it through and we'll come back with a firm
        quote, usually within one working day.`;
    }
  }

  const totalLabelEl = document.getElementById('review-total-label');
  if (totalLabelEl) totalLabelEl.textContent = isQuote ? 'Calculator estimate (not final)' : 'Grand total (estimated)';

  const marketingBlockEl = document.getElementById('marketing-consent-block');
  if (marketingBlockEl) marketingBlockEl.style.display = isQuote ? 'block' : 'none';

  // Write through the label/icon slots rather than the button's innerHTML —
  // submitOrder() writes in-flight upload progress into these same nodes.
  const { label: submitLabelEl, iconSlot: submitIconEl } = ensureSubmitButtonParts();
  if (submitLabelEl) submitLabelEl.textContent = isQuote ? 'Request a hand-priced quote' : 'Add to cart';
  if (submitIconEl) submitIconEl.innerHTML = icon(isQuote ? 'arrowRight' : 'cart', { size: 15 });

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

/**
 * Shows a validation message inside the contact form, next to the button that
 * was just pressed.
 *
 * These used to go through showToast(), which pins its message to the bottom
 * of the viewport — several hundred pixels below the modal, and gone again
 * after a few seconds. A customer who missed it saw the submit button do
 * nothing at all and concluded the tool was broken, so the message has to
 * live where the click happened.
 */
function showFormError(msg, field) {
  const el = document.getElementById('order-form-error');
  if (el) {
    el.textContent = msg;
    el.style.display = 'block';
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } else {
    // Older markup without the inline slot — better a toast than silence.
    showToast(msg, 'error');
  }
  field?.focus({ preventScroll: true });
}

function clearFormError() {
  const el = document.getElementById('order-form-error');
  if (el) { el.textContent = ''; el.style.display = 'none'; }
}

// A variant freshly created by createPricedVariant (relay-side, via
// productVariantsBulkCreate) is occasionally not yet visible to the
// storefront cart API for a moment after creation — the same kind of
// propagation lag already documented in customer.ts's
// findOrCreateCustomer, just for a different Shopify index. Without a
// retry, a fast submit can hit a transient 422 "sold out" for a variant
// that in fact exists and is for sale.
// Measured on this store: a variant created via the Admin API can take well
// over ten seconds to become addable, and the previous 3.5s of retries
// routinely expired first — the customer got a dead-looking button while
// Shopify was still catching up. Verified by hand: the same variant that
// returned 422 throughout the old window returned 200 a minute later.
const CART_ADD_RETRY_DELAYS_MS = [500, 1000, 2000, 3000, 4000, 5000, 5000];

async function addVariantToCart(variantId, properties) {
  let lastError;
  for (let attempt = 0; attempt <= CART_ADD_RETRY_DELAYS_MS.length; attempt++) {
    const res = await fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: variantId, quantity: 1, properties }] }),
    });
    if (res.ok) return;
    lastError = new Error(`Add to cart failed: HTTP ${res.status}`);
    if (attempt < CART_ADD_RETRY_DELAYS_MS.length) {
      await new Promise(resolve => setTimeout(resolve, CART_ADD_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastError;
}

async function submitOrder(e) {
  e.preventDefault();
  const form       = e.target;
  const name             = form.querySelector('[name="cust-name"]').value.trim();
  const email            = form.querySelector('[name="cust-email"]').value.trim();
  const notes            = form.querySelector('[name="cust-notes"]').value.trim();
  const disclaimer       = form.querySelector('[name="disclaimer"]').checked;
  const marketingConsent = form.querySelector('[name="marketing-consent"]')?.checked ?? false;

  clearFormError();
  if (!name)       return showFormError('Please enter your name.', form.querySelector('[name="cust-name"]'));
  if (!email)      return showFormError('Please enter your email address.', form.querySelector('[name="cust-email"]'));
  if (!disclaimer) return showFormError('Please tick the confirmation box above to continue.', form.querySelector('[name="disclaimer"]'));

  const activeGroups = groups.filter(g => g.items.some(i => i.status === 'ready'));

  const submitBtn = form.querySelector('button[type="submit"]');
  // Swap only the label span's text while uploads are in flight, not the
  // whole button's textContent — that used to wipe out the button's icon
  // span too (textContent replaces all child nodes) and it never came back.
  const { label: submitLabelEl } = ensureSubmitButtonParts();
  const submitBtnOriginalText = submitLabelEl?.textContent;
  if (submitBtn) submitBtn.disabled = true;

  // Wait for any file uploads still in flight for priceable items in this
  // order. Uploads run fire-and-forget from addFileToGroup() so pricing
  // never blocks on them, but submitOrder reads item.fileUrl/thumbnailUrl
  // below — without this await, a fast submit could beat an in-flight
  // upload and silently ship null file/thumbnail URLs (the future packing
  // tool needs those). uploadItemToShopify() catches its own errors
  // internally (including timeouts — see fetchWithTimeout) and always
  // resolves, so this never rejects/hangs indefinitely.
  const pendingUploads = activeGroups
    .flatMap(g => g.items)
    .filter(i => i.status === 'ready' && i.cost?.priceable && i.uploadPromise)
    .map(i => i.uploadPromise);
  if (pendingUploads.length) {
    if (submitLabelEl) submitLabelEl.textContent = 'Uploading files…';
    await Promise.all(pendingUploads);
    if (submitLabelEl) submitLabelEl.textContent = submitBtnOriginalText;
  }

  const lineItems = activeGroups.map(g => {
    const files = g.items
      .filter(i => i.status === 'ready' && i.cost?.priceable)
      .map(i => ({
        filename: i.name,
        label: (i.label || '').trim() || null,
        fileUrl: i.fileUrl ?? null,
        thumbnailUrl: i.thumbnailUrl ?? null,
        quantity: i.settings.quantity,
      }));
    return {
      title: g.name,
      price: (g.groupCost?.groupTotal ?? 0).toFixed(2),
      quantity: 1,
      properties: [
        { name: '_quote_ref', value: _orderNumber ?? '' },
        { name: '_model_name', value: g.name },
        { name: '_print_method', value: g.settings.printMethod },
        { name: '_primer', value: g.settings.primer },
        { name: '_assembly', value: String(Boolean(g.settings.assembly)) },
        { name: '_notes', value: g.settings.notes || '' },
        { name: '_files_json', value: JSON.stringify(files) },
      ],
    };
  });

  // Total the same rounded per-model prices the relay will re-add, rather than
  // the unrounded figures behind the on-screen total. Those two drift by up to
  // half a penny per model, and the relay reads a large enough gap as a
  // tampered total and rejects the order. The whole-order minimum still
  // applies here exactly as it does server-side.
  const lineItemsTotal = lineItems.reduce((sum, li) => sum + Number(li.price) * li.quantity, 0);
  const minimumOrderTotal = config?.minimumOrderTotal ?? 0;
  const grandTotal = Number(
    (lineItemsTotal > 0 ? Math.max(lineItemsTotal, minimumOrderTotal) : lineItemsTotal).toFixed(2),
  );
  const thresholdExceeded = exceedsCustomQuoteThreshold(grandTotal, config);

  fetch(`${RELAY_BASE_URL}/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerEmail: email,
      customerName: name,
      marketingConsent,
      grandTotal,
      thresholdExceeded,
      lineItems,
    }),
  })
    .then(r => {
      if (!r.ok) throw new Error(`Checkout failed: HTTP ${r.status}`);
      return r.json();
    })
    .then(result => {
      if (result.mode === 'quote') {
        showQuoteSuccess(email);
        return;
      }
      // mode === 'cart' — add the priced variant to the real Shopify cart, then go to checkout.
      // result.properties comes from the relay (the first model group's
      // _quote_ref/_model_name/_print_method/_notes/_files_json — see
      // index.ts's /checkout handler); _quote_ref/_customer_notes below are
      // the frontend's own authoritative values and take precedence over
      // anything of the same name in result.properties.
      const cartProperties = {
        ...(result.properties || {}),
        _quote_ref: _orderNumber ?? '',
        _customer_notes: notes,
      };
      // Adding can spend a few seconds waiting for the new variant to reach
      // the storefront, so say so rather than leaving the button looking dead.
      if (submitLabelEl) submitLabelEl.textContent = 'Adding to cart…';
      return addVariantToCart(result.variantId, cartProperties).then(() => {
        window.location.href = '/checkout';
      });
    })
    .catch(err => {
      console.error(err);
      // Report inside the modal, not via showToast — a toast at the bottom of
      // the page is exactly how this failure stayed invisible before.
      showFormError('Something went wrong submitting your order — please try again in a moment, or contact us if it keeps happening.');
      if (submitLabelEl) submitLabelEl.textContent = submitBtnOriginalText;
      if (submitBtn) submitBtn.disabled = false;
    });
}

/** Shows the success step in place — no navigation. `mode === 'quote'` never redirects the customer anywhere (no payment page, since the order is a draft awaiting manual review). */
function showQuoteSuccess(email) {
  const emailEl  = document.getElementById('order-success-email');
  if (emailEl) emailEl.textContent = email;
  const numberEl = document.getElementById('order-success-number');
  if (numberEl) numberEl.textContent = _orderNumber ?? '—';

  document.getElementById('order-review-wrap').style.display  = 'none';
  document.getElementById('order-form-wrap').style.display    = 'none';
  document.getElementById('order-success-wrap').style.display = 'flex';
  document.querySelector('.order-panel')?.scrollTo(0, 0);
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

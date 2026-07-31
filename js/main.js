// ============================================================
// main.js — App orchestration
// Groups: each model group has primer / assembly / labour settings.
// Files belong to a group. Multiple groups = multiple models.
// ============================================================

import { getConfig, RELAY_BASE_URL } from './config.js?v=15';
import { parseSTLFile } from './stl-parser.js?v=9';
import { generateThumbnail, STLViewer } from './viewer.js?v=11';
import { icon, applyStaticIcons } from './icons.js?v=1';
import {
  calcItemCost, calcGroupCost, calcOrderTotal, calcOrderMinimumShortfall,
  exceedsCustomQuoteThreshold, fmt, fmtMm,
} from './calculator.js?v=14';

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
  setupFileInput();
  setupModal();
  setupOrderForm();
  document.getElementById('mobile-summary-btn')?.addEventListener('click', openOrderForm);
  document.getElementById('add-model-btn')?.addEventListener('click', () => { addGroup(); });
  setupGroupList();   // Single delegated listener — no duplicates across re-renders
  document.addEventListener('add-group', () => { addGroup(); });
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
  return { id: gId(), name, settings: defaultGroupSettings(), items: [], groupCost: null, collapsed: false };
}

function ensureGroup() {
  if (!groups.length) groups.push(createGroup('Model 1'));
  return groups[0];
}

// ---- Drop zone -------------------------------------------------------

function setupDropZone() {
  const zone = document.getElementById('drop-zone');
  if (!zone) return;
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over'); });
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const files = [...e.dataTransfer.files].filter(f => {
      const n = f.name.toLowerCase();
      return n.endsWith('.stl') || n.endsWith('.lys');
    });
    if (files.length) {
      // Top drop zone: create a new model group if one already exists
      if (groups.length > 0) _pendingGroupId = 'new';
      handleFilesForGroup(files);
    } else {
      showToast('Please drop .stl or .lys files.', 'error');
    }
  });
  zone.addEventListener('click', () => {
    // Top button: create a new model group if one already exists
    _pendingGroupId = groups.length > 0 ? 'new' : null;
    document.getElementById('file-input').click();
  });
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

function addGroup() {
  const n = groups.length + 1;
  groups.push(createGroup(`Model ${n}`));
  renderAll();
}

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

  const empty    = document.getElementById('empty-state');
  const hasItems = groups.some(g => g.items.length > 0);
  if (empty) empty.style.display = hasItems ? 'none' : 'flex';

  const dropZone   = document.getElementById('drop-zone');
  if (dropZone) dropZone.style.display = hasItems ? 'none' : '';

  const addModelBtn = document.getElementById('add-model-btn');
  if (addModelBtn) addModelBtn.style.display = hasItems ? '' : 'none';

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

// ---- Group card HTML -------------------------------------------------

function buildGroupHTML(group) {
  if (group.collapsed) return buildCollapsedGroupHTML(group);

  const sym        = config.currencySymbol;
  const gc         = group.groupCost;
  const readyItems = group.items.filter(i => i.status === 'ready' && i.cost);
  const totalParts = readyItems.reduce((s, i) => s + i.settings.quantity, 0);
  const canAssemble   = totalParts >= 2;
  const assemblyActive = group.settings.assembly && canAssemble;

  // Print method — per-model toggle. PLA is priced by volume only (no
  // size tiers). Colour, though, is chosen per PART (see buildItemHTML) —
  // each part prints in exactly one colour, and the surcharge scales with
  // that part's own size instead of being a flat per-model fee.
  const printMethod = group.settings.printMethod === 'pla' ? 'pla' : 'resin';
  const isPlaModel  = printMethod === 'pla';

  // Primer swatches — visual, finger-size circles. Unprimed = blank circle, red slash.
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

  // Assembly description text
  const assemblyDesc = !canAssemble
    ? 'Upload 2 or more parts to this model to enable assembly.'
    : assemblyActive
      ? `We will glue and fit your ${totalParts} parts together into a single assembled model.`
      : `Your ${totalParts} parts will be printed and supplied separately, unassembled.`;

  // Cost hints
  const primerCostHint   = (group.settings.primer !== 'unprimed' && gc)
    ? `<span class="setting-cost-hint">+${fmt(gc.primerTotal, sym)}</span>` : '';
  const assemblyCostHint = (assemblyActive && gc)
    ? ` <span class="setting-cost-hint">+${fmt(gc.assemblyCost, sym)}</span>` : '';

  // Items list
  const itemsHTML = group.items.length
    ? group.items.map(item => buildItemHTML(item, group)).join('')
    : `<div class="group-empty-hint">
         <span>${icon('paperclip')} Use <strong>"Add Part to This Model"</strong> below to upload files.</span>
       </div>`;

  // Cost footer
  const costsHTML = (gc && readyItems.length > 0) ? `
    <div class="group-footer">
      <div class="group-costs">
        <span>Files subtotal</span><span>${fmt(gc.fileSubtotal, sym)}</span>
        ${assemblyActive ? `<span>${icon('puzzle')} Assembly (${totalParts} parts)</span><span>+${fmt(gc.assemblyCost, sym)}</span>` : ''}
        ${gc.isPrimed ? `<span>${icon('paintbrush')} ${esc(config.primerOptions.find(p => p.id === gc.primerLabel)?.label || 'Primer')}</span><span>+${fmt(gc.primerTotal, sym)}</span>` : ''}
        ${gc.plaColorCost > 0 ? `<span>${icon('layers')} Colour surcharge</span><span>+${fmt(gc.plaColorCost, sym)}</span>` : ''}
      </div>
      <div class="group-total">
        <span>Model Total</span>
        <span>${fmt(gc.groupTotal, sym)}</span>
      </div>
    </div>` : '';

  return `
    <div class="group-header">
      <div class="group-name-wrap">
        <span class="group-tag">MODEL</span>
        <input class="group-name-input" value="${esc(group.name)}" data-action="rename"
               title="Click to rename" aria-label="Model name">
      </div>
      <div class="group-header-actions">
        ${readyItems.length > 0 ? `<button class="btn btn-primary btn-sm group-done-btn" data-action="collapse-group" title="Mark this model as done">${icon('check')} Done</button>` : ''}
        <button class="btn btn-sm group-delete-btn ${isArmedForDelete('group', group.id) ? 'armed' : ''}"
                data-action="delete-group" title="Delete this model" aria-label="Delete this model">
          ${icon('trash')}${isArmedForDelete('group', group.id) ? '<span class="delete-confirm-text">Delete model?</span>' : ''}
        </button>
      </div>
    </div>

    <div class="group-settings">

      <div class="group-setting-block print-method-block">
        <div class="group-setting-label">
          <span class="label-icon-row">${icon('printer')} Print Method</span>
          <span class="info-tip-wrap">
            <button type="button" class="info-tip-btn" data-action="toggle-info" aria-label="What's the difference between Resin and PLA?" aria-expanded="false">${icon('helpCircle', { size: 14 })}</button>
            <span class="info-tip-content" role="tooltip">
              <strong>Resin</strong> — highest detail, best for fine miniatures. Priced by size tier.<br><br>
              <strong>PLA (FDM)</strong> — stronger and faster, best for larger or simpler parts. Priced by volume only.
            </span>
          </span>
        </div>
        <div class="print-method-seg">
          <button class="seg-btn ${!isPlaModel ? 'active' : ''}" data-action="print-method" data-val="resin">${icon('flask')} Resin</button>
          <button class="seg-btn ${isPlaModel ? 'active-green' : ''}" data-action="print-method" data-val="pla">${icon('layers')} PLA</button>
        </div>
        ${isPlaModel ? `<div class="group-setting-desc">Choose each part's filament colour below — every part prints in one solid colour. Need multi-colour on a single part? We don't support that here — please request a custom quote instead.</div>` : ''}
      </div>

      <div class="group-setting-block">
        <div class="group-setting-label"><span class="label-icon-row">${icon('paintbrush')} Primer Coating</span></div>
        <div class="group-setting-desc">
          A spray primer is applied to the finished model before painting.
          Improves paint adhesion and hides layer lines for a smoother finish.
        </div>
        <div class="primer-row">
          ${primerSwatchesHTML}
          ${primerCostHint}
        </div>
      </div>

      <div class="group-setting-block ${!canAssemble ? 'setting-disabled' : ''}">
        <div class="group-setting-label"><span class="label-icon-row">${icon('puzzle')} Parts Assembly</span></div>
        <div class="group-setting-desc">${assemblyDesc}</div>
        <div class="assembly-seg ${!canAssemble ? 'seg-disabled' : ''}">
          <button class="seg-btn ${!assemblyActive ? 'active' : ''}"
                  data-action="assembly" data-val="false"
                  ${!canAssemble ? 'disabled' : ''}>
            ${icon('package')} No — supply as separate parts
          </button>
          <button class="seg-btn ${assemblyActive ? 'active-green' : ''}"
                  data-action="assembly" data-val="true"
                  ${!canAssemble ? 'disabled' : ''}>
            ${icon('puzzle')} Yes — assemble for me${assemblyCostHint}
          </button>
        </div>
      </div>

    </div>

    <div class="group-notes">
      <label class="group-notes-label" for="notes-${group.id}"><span class="label-icon-row">${icon('note')} Notes for this model (optional)</span></label>
      <textarea class="group-notes-input" id="notes-${group.id}" data-action="notes"
                placeholder="Any requests or things we should know about this model…">${esc(group.settings.notes || '')}</textarea>
    </div>

    <div class="group-items">${itemsHTML}</div>

    ${costsHTML}

    <div class="group-actions">
      <button class="btn btn-primary btn-lg add-part-btn" data-action="add-files-to-group">
        ${icon('paperclip')} Add Part to This Model
      </button>
    </div>
  `;
}

// ---- Collapsed ("Done") group card HTML -------------------------------

function buildCollapsedGroupHTML(group) {
  const sym        = config.currencySymbol;
  const gc         = group.groupCost;
  const readyItems = group.items.filter(i => i.status === 'ready' && i.cost);
  const totalParts = readyItems.reduce((s, i) => s + i.settings.quantity, 0);
  const priceStr   = gc ? fmt(gc.groupTotal, sym) : '—';

  return `
    <div class="group-collapsed">
      <span class="group-collapsed-check" title="Complete" aria-hidden="true">${icon('checkCircle', { size: 20 })}</span>
      <div class="group-collapsed-info">
        <div class="group-collapsed-name">${esc(group.name)}</div>
        <div class="group-collapsed-meta">${readyItems.length} file${readyItems.length === 1 ? '' : 's'} · ${totalParts} part${totalParts === 1 ? '' : 's'}</div>
      </div>
      <div class="group-collapsed-price">${priceStr}</div>
      <button class="btn btn-ghost btn-sm group-edit-btn" data-action="expand-group" title="Edit this model" aria-label="Edit this model">${icon('pencil', { size: 14 })} Edit</button>
    </div>
  `;
}

// ---- File item card HTML ---------------------------------------------

function buildItemHTML(item, group) {
  const sym = config.currencySymbol;

  if (item.status === 'loading') return `
    <div class="file-card" data-id="${item.id}">
      <div class="card-header">
        <div class="card-thumb loading-thumb"><div class="spinner"></div><span>Analysing…</span></div>
        <div class="card-header-text">
          <div class="card-filename">${esc(item.name)}</div>
          <div class="card-meta">${formatBytes(item.size)}</div>
        </div>
      </div>
      <div class="card-body">
        <div class="progress-bar"><div class="progress-fill animate"></div></div>
      </div>
    </div>`;

  if (item.status === 'error') return `
    <div class="file-card" data-id="${item.id}">
      <div class="card-header">
        <div class="card-thumb error-thumb">${icon('alertTriangle', { size: 22 })}</div>
        <div class="card-header-text">
          <div class="card-filename">${esc(item.name)}</div>
          <div class="card-meta text-error">${icon('alertTriangle', { size: 13 })} ${esc(item.errorMsg || 'Could not read this file — is it a valid STL?')}</div>
        </div>
      </div>
      <div class="card-body">
        <button class="btn btn-ghost btn-sm" data-action="remove-item" data-id="${item.id}">Remove</button>
      </div>
    </div>`;

  const d   = item.data;
  const c   = item.cost;
  const ps  = item.settings.presupported;
  const dims = c ? c.scaledDims : d.dimensions;

  const thumbHTML = item.thumbnail
    ? `<img src="${item.thumbnail}" alt="${esc(item.name)}" class="thumb-img" loading="lazy">`
    : `<div class="thumb-placeholder">STL</div>`;

  const isPla = group.settings.printMethod === 'pla';

  const groupMoveHTML = `
    <div class="control-row">
      <label><span class="label-icon-row">${icon('folder', { size: 14 })} Model</span></label>
      <select class="input-group-move" data-action="move-item" data-id="${item.id}">
        ${groups.map(g => `<option value="${esc(g.id)}" ${g.id === group.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
        <option value="__new__">+ Move to new model…</option>
      </select>
    </div>`;

  // Scale presets — data-id included so no need for closest() lookup
  const scalePresets = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
  const presetBtns = scalePresets.map(s =>
    `<button class="scale-preset ${item.settings.scale === s ? 'active' : ''}"
             data-action="scale-preset" data-scale="${s}" data-id="${item.id}">${Math.round(s * 100)}%</button>`
  ).join('');

  const breakdownHTML = config.showCostBreakdown && c && c.priceable ? `
    <details class="cost-details">
      <summary><span class="label-icon-row">${icon('lightbulb', { size: 14 })} See price breakdown</span></summary>
      <table class="breakdown-table">
        ${c.tier ? `
          <tr><td>Size tier: ${esc(c.tier.name)} (model size ≤ ${c.tier.maxDimensionMm ? c.tier.maxDimensionMm + 'mm' : 'build plate'})</td><td>${fmt(c.tier.price, sym)}</td></tr>
          ${c.surchargePct > 0 ? `<tr><td>${esc(c.materialName)} surcharge (+${c.surchargePct}%)</td><td>${fmt(c.surchargeAmount, sym)}</td></tr>` : ''}
          ${c.supportHandlingFee > 0 ? `<tr><td>Support handling (no pre-supported file)</td><td>${fmt(c.supportHandlingFee, sym)}</td></tr>` : ''}
        ` : `
          <tr><td>PLA volume (${c.scaledVolumeMl.toFixed(2)}mL × ${fmt(config.fdm?.costPerMl ?? 0, sym)}/mL)</td><td>${fmt(c.baseCost ?? c.unitCost, sym)}</td></tr>
          ${c.colorSurchargePct > 0 ? `<tr><td>Colour surcharge (+${c.colorSurchargePct}%)</td><td>${fmt(c.colorSurchargeAmount, sym)}</td></tr>` : ''}
        `}
      </table>
    </details>` : '';

  return `
    <div class="file-card" data-id="${item.id}">
      <button class="card-remove-x ${isArmedForDelete('item', item.id) ? 'armed' : ''}"
              data-action="remove-item" data-id="${item.id}" title="Delete this part" aria-label="Delete this part">
        ${icon('trash')}${isArmedForDelete('item', item.id) ? '<span class="delete-confirm-text">Delete part?</span>' : ''}
      </button>

      <div class="card-header">
        <div class="card-thumb" data-action="view3d" data-id="${item.id}" title="Click to view in 3D">
          ${thumbHTML}
          <div class="thumb-overlay">${icon('eye', { size: 14 })} View in 3D</div>
        </div>
        <div class="card-header-text">
          <div class="card-filename" title="${esc(item.name)}">
            ${esc(item.name)}
            ${ps && !isPla ? `<span class="presupported-badge">${icon('check', { size: 12 })} Pre-Supported</span>` : ''}
          </div>
          <div class="card-meta">
            <span>${formatBytes(item.size)}</span> ·
            <span>${fmtMm(d.dimensions.x)} × ${fmtMm(d.dimensions.y)} × ${fmtMm(d.dimensions.z)}</span> ·
            <span>${d.triangleCount.toLocaleString()} triangles</span>
          </div>
        </div>
      </div>

      <div class="card-body">
        ${item.warning ? `<div class="card-warning">${esc(item.warning)}</div>` : ''}
        ${c && c.priceable ? `<div class="card-dims">${icon('maximize', { size: 14 })} Print size: <strong>${fmtMm(dims.x)} × ${fmtMm(dims.y)} × ${fmtMm(dims.z)}</strong> &nbsp;·&nbsp; <strong>${c.tier ? esc(c.tier.name) + ' tier' : 'PLA — priced by volume'}</strong></div>` : ''}
        ${c && !c.priceable ? `<div class="card-warning">${icon('alertTriangle', { size: 14 })} This model is too large to fit ${isPla ? 'our FDM printer' : 'our build plate, even with the support margin'}. Please scale it down or split it into parts before requesting a quote.</div>` : ''}

        <div class="card-controls">

          ${!isPla ? `
          <div class="control-block">
            <div class="control-label"><span class="label-icon-row">${icon('construction', { size: 15 })} Support Structures</span></div>
            <div class="control-desc">
              Supports are temporary scaffolding automatically added to hold up overhanging parts during printing.
              If your file already includes them, select "Pre-supported" to avoid being charged twice.
            </div>
            <div class="seg-control supports-seg">
              <button class="seg-btn ${!ps ? 'active' : ''}"
                      data-action="presupported" data-id="${item.id}" data-val="false">
                ${icon('construction', { size: 14 })} Standard &mdash; add supports
              </button>
              <button class="seg-btn ${ps ? 'active-green' : ''}"
                      data-action="presupported" data-id="${item.id}" data-val="true">
                ${icon('check', { size: 14 })} Pre-supported &mdash; already included
              </button>
            </div>
            <div class="control-hint ${ps ? 'hint-green' : ''}">
              ${ps
                ? `${icon('check', { size: 13 })} Marked as already supported — this saves us time, so it’s priced a little cheaper.`
                : 'We’ll add supports during printing — a small handling fee applies, and your file’s effective size for pricing includes an allowance for the extra support material.'}
            </div>
          </div>` : ''}

          ${isPla ? `
          <div class="control-block">
            <div class="control-label"><span class="label-icon-row">${icon('layers', { size: 15 })} Filament Colour</span></div>
            <div class="control-desc">White, Black &amp; Dark Grey are included. Other colours add a % of this part's cost.</div>
            <div class="pla-color-row">
              ${(config.plaColors || []).map(pc => {
                const active = item.settings.plaColor === pc.id;
                const pct = config.plaColorSurchargePct?.[pc.tier] ?? 0;
                const badge = pct > 0 ? `+${pct}%` : '';
                return `
                  <button type="button" class="pla-swatch-btn" data-action="pla-color-select" data-id="${item.id}" data-color-id="${esc(pc.id)}"
                          title="${esc(pc.name)}${badge ? ' (' + badge + ')' : ''}" aria-label="${esc(pc.name)}" aria-pressed="${active}">
                    <span class="pla-swatch ${active ? 'active' : ''}" style="background:${esc(pc.hex)};">
                      ${active ? `<span class="primer-check">${icon('check', { size: 14 })}</span>` : ''}
                    </span>
                    <span class="pla-swatch-label">${esc(pc.name)}${badge ? `<span class="pla-swatch-badge">${badge}</span>` : ''}</span>
                  </button>`;
              }).join('')}
            </div>
          </div>` : ''}

          <div class="control-block">
            <div class="control-label"><span class="label-icon-row">${icon('maximize', { size: 15 })} Print Scale</span></div>
            <div class="control-desc">Resize the model. 1.0 = original file size. 0.5 = half size. 2.0 = double size.</div>
            <div class="scale-wrap">
              <div class="scale-input-row">
                <input type="number" class="input-scale" value="${item.settings.scale}" min="0.1" max="10" step="0.05"
                       data-action="scale" data-id="${item.id}">
                <span class="scale-suffix">× original size</span>
              </div>
              <div class="scale-presets">${presetBtns}</div>
            </div>
          </div>

          <div class="control-row">
            <label><span class="label-icon-row">${icon('hash', { size: 14 })} Quantity</span></label>
            <input type="number" class="input-qty" value="${item.settings.quantity}" min="1" max="999"
                   data-action="quantity" data-id="${item.id}">
          </div>

          ${groupMoveHTML}
        </div>

        ${breakdownHTML}

        <div class="card-cost">
          ${c && c.priceable ? `
            <span class="unit-cost">${fmt(c.unitCost, sym)} each</span>
            ${c.quantity > 1 ? `<span class="total-cost">${fmt(c.totalCost, sym)} for ${c.quantity}</span>` : ''}
          ` : c && !c.priceable ? `<span class="text-error">Cannot price — too large</span>` : '—'}
        </div>
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
      _pendingGroupId = group.id;
      document.getElementById('file-input').click();
      break;

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

    case 'collapse-group':
      group.collapsed = true;
      renderAll();
      break;

    case 'expand-group':
      group.collapsed = false;
      renderAll();
      break;

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

// Track which group the next file batch should go into
let _pendingGroupId = null;

async function handleFilesForGroup(files) {
  const targetGroupId = _pendingGroupId;
  _pendingGroupId     = null;

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

  const isTopLevel = targetGroupId === 'new' || !targetGroupId;

  if (isTopLevel && validFiles.length > 1) {
    // A multi-file top-level drop usually means several separate models, not
    // several parts of the same one — give each file its own model group by
    // default. Parts that do belong together can be merged afterwards via
    // each file's "Model" picker.
    for (const file of validFiles) {
      const newGroup = createGroup(`Model ${groups.length + 1}`);
      groups.push(newGroup);
      await addFileToGroup(file, newGroup);
    }
    return;
  }

  let targetGroup;
  if (targetGroupId === 'new') {
    // Top-level upload — always land in a fresh group
    targetGroup = createGroup(`Model ${groups.length + 1}`);
    groups.push(targetGroup);
  } else if (targetGroupId) {
    targetGroup = groups.find(g => g.id === targetGroupId) ?? ensureGroup();
  } else {
    targetGroup = ensureGroup();
  }

  for (const file of validFiles) {
    await addFileToGroup(file, targetGroup);
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

    // Compute pricing immediately — don't make the user wait on the
    // Shopify file-upload round trip below just to see a price.
    recomputeItemCost(item);
    recomputeGroup(targetGroup);

    // Fire-and-forget from the pricing UI's point of view: upload the STL +
    // thumbnail to Shopify Files in the background so pricing doesn't wait
    // on the round trip. Non-fatal if it fails — pricing still works without
    // the Shopify-side file copy, the packing tool just won't have a
    // file/thumbnail reference for this part. The promise itself is kept on
    // the item (not truly discarded) so submitOrder() can await any still-
    // in-flight uploads before reading item.shopifyFileId/shopifyThumbnailId
    // — otherwise a fast submit could race the upload and silently ship
    // null file ids (see uploadItemToShopify's own doc comment).
    item.uploadPromise = uploadItemToShopify(item, file);
  } catch (err) {
    item.status   = 'error';
    item.errorMsg = err.message;
  }
  renderAll();
}

/** Base64-encode bytes in chunks — avoids the call-stack/perf blowup of
 *  spreading or reduce()-ing very large typed arrays one byte at a time. */
function bytesToBase64(bytes) {
  const CHUNK_SIZE = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

/** Upload an item's STL bytes + thumbnail to the relay's Shopify Files
 *  endpoint, without blocking the caller. Sets item.shopifyFileId /
 *  item.shopifyThumbnailId on success and re-renders. */
async function uploadItemToShopify(item, file) {
  try {
    const fileBuffer = await file.arrayBuffer();
    const base64Data = bytesToBase64(new Uint8Array(fileBuffer));
    const stlRes = await fetch(`${RELAY_BASE_URL}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: item.name, mimeType: 'model/stl', base64Data }),
    });
    if (!stlRes.ok) throw new Error(`STL upload failed: HTTP ${stlRes.status}`);
    const stlUpload = await stlRes.json();
    item.shopifyFileId = stlUpload.id;

    if (item.thumbnail) {
      const thumbBase64 = item.thumbnail.split(',')[1]; // strip "data:image/png;base64,"
      const thumbRes = await fetch(`${RELAY_BASE_URL}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: item.name.replace(/\.stl$/i, '.png'),
          mimeType: 'image/png',
          base64Data: thumbBase64,
        }),
      });
      if (!thumbRes.ok) throw new Error(`Thumbnail upload failed: HTTP ${thumbRes.status}`);
      const thumbUpload = await thumbRes.json();
      item.shopifyThumbnailId = thumbUpload.id;
    }
  } catch (err) {
    console.warn('Shopify file upload failed for', item.name, err);
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
    <div class="summary-total"><span>Grand Total</span><span>${fmt(grandTotal, sym)}</span></div>
    ${minimumShortfall > 0 ? `
      <p class="summary-min-note">${icon('sparkles', { size: 14 })} You're already covered by our ${fmt(config.minimumOrderTotal, sym)} order minimum — add up to ${fmt(minimumShortfall, sym)} more in parts at no extra cost!</p>
    ` : ''}
    <p class="summary-note">${icon('lightbulb', { size: 14 })} Estimate only — final price confirmed after file review.</p>
    <button class="btn btn-primary btn-lg" id="request-quote-btn">Request a Quote ${icon('arrowRight', { size: 15 })}</button>
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

  const quoteNoteEl = document.getElementById('review-custom-quote-note');
  if (quoteNoteEl) quoteNoteEl.style.display = exceedsCustomQuoteThreshold(grandTotal, config) ? 'block' : 'none';

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

async function submitOrder(e) {
  e.preventDefault();
  const form       = e.target;
  const name       = form.querySelector('[name="cust-name"]').value.trim();
  const email      = form.querySelector('[name="cust-email"]').value.trim();
  const notes      = form.querySelector('[name="cust-notes"]').value.trim();
  const disclaimer = form.querySelector('[name="disclaimer"]').checked;

  if (!name || !email) { showToast('Please fill in your name and email.', 'error'); return; }
  if (!disclaimer)     { showToast('Please tick the confirmation checkbox to continue.', 'error'); return; }

  const activeGroups = groups.filter(g => g.items.some(i => i.status === 'ready'));

  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  // Wait for any Shopify file uploads still in flight for priceable items in
  // this order. Uploads run fire-and-forget from addFileToGroup() so pricing
  // never blocks on them, but submitOrder reads item.shopifyFileId/
  // shopifyThumbnailId below — without this await, a fast submit could beat
  // an in-flight upload and silently ship null file/thumbnail ids (the
  // future packing tool needs those). uploadItemToShopify() catches its own
  // errors internally and always resolves, so this never rejects/hangs.
  const pendingUploads = activeGroups
    .flatMap(g => g.items)
    .filter(i => i.status === 'ready' && i.cost?.priceable && i.uploadPromise)
    .map(i => i.uploadPromise);
  if (pendingUploads.length) {
    await Promise.all(pendingUploads);
  }

  const grandTotal   = calcOrderTotal(activeGroups, config);
  const thresholdExceeded = exceedsCustomQuoteThreshold(grandTotal, config);

  const lineItems = activeGroups.map(g => {
    const files = g.items
      .filter(i => i.status === 'ready' && i.cost?.priceable)
      .map(i => ({
        filename: i.name,
        fileId: i.shopifyFileId ?? null,
        thumbnailId: i.shopifyThumbnailId ?? null,
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
        { name: '_notes', value: g.settings.notes || '' },
        { name: '_files_json', value: JSON.stringify(files) },
      ],
    };
  });

  fetch(`${RELAY_BASE_URL}/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerEmail: email,
      customerName: name,
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
      if (result.mode === 'draft-order') {
        window.location.href = result.invoiceUrl;
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
      return fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{
            id: result.variantId,
            quantity: 1,
            properties: cartProperties,
          }],
        }),
      }).then(r => {
        if (!r.ok) throw new Error(`Add to cart failed: HTTP ${r.status}`);
        window.location.href = '/checkout';
      });
    })
    .catch(err => {
      console.error(err);
      showToast('Something went wrong submitting your order — please try again or contact us.', 'error');
      if (submitBtn) submitBtn.disabled = false;
    });
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

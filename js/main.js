// ============================================================
// main.js — App orchestration
// Groups: each model group has primer / assembly / labour settings.
// Files belong to a group. Multiple groups = multiple models.
// ============================================================

import { getConfig } from './config.js?v=8';
import { parseSTLFile } from './stl-parser.js?v=8';
import { generateThumbnail, STLViewer } from './viewer.js?v=8';
import {
  calcItemCost, calcGroupCost, calcOrderTotal,
  fmt, fmtMl, fmtMm, fmtHours,
} from './calculator.js?v=8';

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

// ---- Boot ------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  config = getConfig();
  setupDropZone();
  setupFileInput();
  setupModal();
  setupOrderForm();
  setupGroupList();   // Single delegated listener — no duplicates across re-renders
  document.addEventListener('add-group', () => { addGroup(); });
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
  return { assembly: false, primer: 'unprimed' };
}

function createGroup(name) {
  return { id: gId(), name, settings: defaultGroupSettings(), items: [], groupCost: null };
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
  item.cost = calcItemCost(item.data, item.settings, config);
}

function recomputeGroup(group) {
  group.groupCost = calcGroupCost(group.items, group.settings, config);
}

function recomputeAllGroups() {
  groups.forEach(recomputeGroup);
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
  const sym        = config.currencySymbol;
  const gc         = group.groupCost;
  const readyItems = group.items.filter(i => i.status === 'ready' && i.cost);
  const totalParts = readyItems.reduce((s, i) => s + i.settings.quantity, 0);
  const canAssemble   = totalParts >= 2;
  const assemblyActive = group.settings.assembly && canAssemble;

  // Primer options
  const primerIcons = { unprimed: '🚫', black: '⬛', grey: '🔲', white: '⬜' };
  const primerOptions = config.primerOptions.map(p =>
    `<option value="${esc(p.id)}" ${group.settings.primer === p.id ? 'selected' : ''}>${primerIcons[p.id] || '🎨'} ${esc(p.label)}</option>`
  ).join('');

  // Assembly description text
  const assemblyDesc = !canAssemble
    ? 'Upload 2 or more parts to this model to enable assembly.'
    : assemblyActive
      ? `We will glue and fit your ${totalParts} parts together into a single assembled model.`
      : `Your ${totalParts} parts will be printed and supplied separately, unassembled.`;

  // Cost hints
  const primerCostHint   = (group.settings.primer !== 'unprimed' && gc)
    ? ` <span class="setting-cost-hint">+${fmt(gc.primerTotal, sym)}</span>` : '';
  const assemblyCostHint = (assemblyActive && gc)
    ? ` <span class="setting-cost-hint">+${fmt(gc.assemblyCost, sym)}</span>` : '';

  // Items list
  const itemsHTML = group.items.length
    ? group.items.map(item => buildItemHTML(item, group)).join('')
    : `<div class="group-empty-hint">
         <span>📎 Use <strong>"Add Files to This Model"</strong> below, or drag &amp; drop STL files onto the upload area above.</span>
       </div>`;

  // Cost footer
  const costsHTML = (gc && readyItems.length > 0) ? `
    <div class="group-footer">
      <div class="group-costs">
        <span>Files subtotal</span><span>${fmt(gc.fileSubtotal, sym)}</span>
        ${assemblyActive ? `<span>🔩 Assembly (${totalParts} parts)</span><span>+${fmt(gc.assemblyCost, sym)}</span>` : ''}
        ${gc.isPrimed ? `<span>🎨 ${esc(config.primerOptions.find(p => p.id === gc.primerLabel)?.label || 'Primer')}</span><span>+${fmt(gc.primerTotal, sym)}</span>` : ''}
        <span>⚙️ Handling &amp; labour</span><span>+${fmt(gc.labourBase, sym)}</span>
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
      ${groups.length > 1 ? `<button class="btn btn-ghost btn-sm group-delete" data-action="delete-group" title="Remove this model">✕ Remove</button>` : ''}
    </div>

    <div class="group-settings">

      <div class="group-setting-block">
        <div class="group-setting-label">🎨 Primer Coating</div>
        <div class="group-setting-desc">
          A spray primer is applied to the finished model before painting.
          Improves paint adhesion and hides layer lines for a smoother finish.
        </div>
        <div class="primer-row">
          <select class="primer-select" data-action="primer">
            ${primerOptions}
          </select>
          ${primerCostHint}
        </div>
      </div>

      <div class="group-setting-block ${!canAssemble ? 'setting-disabled' : ''}">
        <div class="group-setting-label">🔩 Parts Assembly</div>
        <div class="group-setting-desc">${assemblyDesc}</div>
        <div class="assembly-seg ${!canAssemble ? 'seg-disabled' : ''}">
          <button class="seg-btn ${!assemblyActive ? 'active' : ''}"
                  data-action="assembly" data-val="false"
                  ${!canAssemble ? 'disabled' : ''}>
            📦 No — supply as separate parts
          </button>
          <button class="seg-btn ${assemblyActive ? 'active-green' : ''}"
                  data-action="assembly" data-val="true"
                  ${!canAssemble ? 'disabled' : ''}>
            🔩 Yes — assemble for me${assemblyCostHint}
          </button>
        </div>
      </div>

    </div>

    <div class="group-items">${itemsHTML}</div>

    ${costsHTML}

    <div class="group-actions">
      <button class="btn btn-secondary btn-sm" data-action="add-files-to-group">
        📎 Add Files to This Model
      </button>
      ${groups.length === 1 ? `<button class="btn btn-ghost btn-sm" data-action="new-group">+ New Model Group</button>` : ''}
    </div>
  `;
}

// ---- File item card HTML ---------------------------------------------

function buildItemHTML(item, group) {
  const sym = config.currencySymbol;

  if (item.status === 'loading') return `
    <div class="file-card" data-id="${item.id}">
      <div class="card-thumb loading-thumb"><div class="spinner"></div><span>Analysing…</span></div>
      <div class="card-body">
        <div class="card-filename">${esc(item.name)}</div>
        <div class="card-meta">${formatBytes(item.size)}</div>
        <div class="progress-bar"><div class="progress-fill animate"></div></div>
      </div>
    </div>`;

  if (item.status === 'error') return `
    <div class="file-card" data-id="${item.id}">
      <div class="card-thumb error-thumb">⚠</div>
      <div class="card-body">
        <div class="card-filename">${esc(item.name)}</div>
        <div class="card-meta text-error">⚠️ ${esc(item.errorMsg || 'Could not read this file — is it a valid STL?')}</div>
        <button class="btn btn-ghost btn-sm" data-action="remove-item" data-id="${item.id}">Remove</button>
      </div>
    </div>`;

  const d   = item.data;
  const c   = item.cost;
  const ps  = item.settings.presupported;
  const dims = c ? c.scaledDims : d.dimensions;
  const supportPct = config.supportMaterial;

  const thumbHTML = item.thumbnail
    ? `<img src="${item.thumbnail}" alt="${esc(item.name)}" class="thumb-img" loading="lazy">`
    : `<div class="thumb-placeholder">STL</div>`;

  const matOptions = config.materials.map(m =>
    `<option value="${esc(m.id)}" ${m.id === item.settings.materialId ? 'selected' : ''}>${esc(m.name)}${m.description ? ' — ' + esc(m.description) : ''}</option>`
  ).join('');

  const groupMoveHTML = `
    <div class="control-row">
      <label>📁 Model</label>
      <select class="input-group-move" data-action="move-item" data-id="${item.id}">
        ${groups.map(g => `<option value="${esc(g.id)}" ${g.id === group.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
        <option value="__new__">➕ Move to new model…</option>
      </select>
    </div>`;

  // Scale presets — data-id included so no need for closest() lookup
  const scalePresets = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
  const presetBtns = scalePresets.map(s =>
    `<button class="scale-preset ${item.settings.scale === s ? 'active' : ''}"
             data-action="scale-preset" data-scale="${s}" data-id="${item.id}">${Math.round(s * 100)}%</button>`
  ).join('');

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

  return `
    <div class="file-card" data-id="${item.id}">
      <button class="card-remove-x" data-action="remove-item" data-id="${item.id}" title="Remove this file">✕</button>

      <div class="card-thumb" data-action="view3d" data-id="${item.id}" title="Click to view in 3D">
        ${thumbHTML}
        <div class="thumb-overlay">🔍 View in 3D</div>
      </div>

      <div class="card-body">
        <div class="card-filename" title="${esc(item.name)}">
          ${esc(item.name)}
          ${ps ? `<span class="presupported-badge">✅ Pre-Supported</span>` : ''}
        </div>
        ${item.warning ? `<div class="card-warning">${esc(item.warning)}</div>` : ''}
        <div class="card-meta">
          <span>${formatBytes(item.size)}</span> ·
          <span>${fmtMm(d.dimensions.x)} × ${fmtMm(d.dimensions.y)} × ${fmtMm(d.dimensions.z)}</span> ·
          <span>${d.triangleCount.toLocaleString()} triangles</span>
        </div>
        ${c ? `<div class="card-dims">📐 Print size: <strong>${fmtMm(dims.x)} × ${fmtMm(dims.y)} × ${fmtMm(dims.z)}</strong> &nbsp;·&nbsp; <strong>${fmtMl(c.scaledVolumeMl)}</strong> resin</div>` : ''}

        <div class="card-controls">

          <div class="control-block">
            <div class="control-label">🏗️ Support Structures</div>
            <div class="control-desc">
              Supports are temporary scaffolding automatically added to hold up overhanging parts during printing.
              If your file already includes them, select "Pre-supported" to avoid being charged twice.
            </div>
            <div class="seg-control supports-seg">
              <button class="seg-btn ${!ps ? 'active' : ''}"
                      data-action="presupported" data-id="${item.id}" data-val="false">
                🏗️ Standard &mdash; add supports
              </button>
              <button class="seg-btn ${ps ? 'active-green' : ''}"
                      data-action="presupported" data-id="${item.id}" data-val="true">
                ✅ Pre-supported &mdash; already included
              </button>
            </div>
            <div class="control-hint ${ps ? 'hint-green' : ''}">
              ${ps
                ? '✅ No extra support material charged — your file already includes them.'
                : `+${supportPct}% extra resin added for support scaffolding`}
            </div>
          </div>

          <div class="control-block">
            <div class="control-label">📐 Print Scale</div>
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
            <label>🔢 Quantity</label>
            <input type="number" class="input-qty" value="${item.settings.quantity}" min="1" max="999"
                   data-action="quantity" data-id="${item.id}">
          </div>

          <div class="control-row">
            <label>🧪 Resin Type</label>
            <select class="input-material" data-action="material" data-id="${item.id}">${matOptions}</select>
          </div>

          ${groupMoveHTML}
        </div>

        ${breakdownHTML}

        <div class="card-cost">
          ${c ? `
            <span class="unit-cost">${fmt(c.unitCost, sym)} each</span>
            ${c.quantity > 1 ? `<span class="total-cost">${fmt(c.totalCost, sym)} for ${c.quantity}</span>` : ''}
          ` : '—'}
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
      if (confirm(`Remove "${group.name}" and all its files?`)) removeGroup(group.id);
      break;

    case 'add-files-to-group':
      _pendingGroupId = group.id;
      document.getElementById('file-input').click();
      break;

    case 'new-group':
      addGroup();
      break;

    case 'remove-item':
      removeItem(id);
      break;

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

  if (action === 'primer') {
    group.settings.primer = el.value;
    recomputeGroup(group);
    renderAll();
    return;
  }

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
  } else if (action === 'material') {
    item.settings.materialId = el.value;
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
  }
}

// Track which group the next file batch should go into
let _pendingGroupId = null;

async function handleFilesForGroup(files) {
  const targetGroupId = _pendingGroupId;
  _pendingGroupId     = null;

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

  for (const file of files) {
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
      continue;
    }

    if (!fname.endsWith('.stl')) {
      showToast(`${file.name} — unsupported file type. Please use .stl files.`, 'error');
      continue;
    }

    const item = {
      id: iId(), file, name: file.name, size: file.size,
      status: 'loading', data: null, thumbnail: null,
      settings: { scale: 1.0, quantity: 1, materialId: config.materials[0].id, presupported: false },
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
  const readyItems = group.items.filter(i => i.status === 'ready');

  const filesHTML = readyItems.map(i => {
    const thumbHTML = i.thumbnail
      ? `<img src="${i.thumbnail}" alt="" class="review-thumb">`
      : `<div class="review-thumb review-thumb-ph">STL</div>`;
    const supLabel = i.settings.presupported
      ? `<span style="color:var(--green)">Pre-supported</span>`
      : 'Standard supports';
    return `
      <div class="review-file-row">
        ${thumbHTML}
        <div class="review-file-info">
          <div class="review-file-name">${esc(shortName(i.name, 38))}</div>
          <div class="review-file-meta">
            ${esc(i.cost.materialName)} &middot; ×${i.settings.quantity}
            &middot; ${Math.round(i.settings.scale * 100)}% scale
            &middot; ${supLabel}
          </div>
        </div>
        <div class="review-file-cost">${fmt(i.cost.totalCost, sym)}</div>
      </div>`;
  }).join('');

  const extras = [];
  if (gc.assemblyCost > 0)
    extras.push(`<div class="review-extra-row"><span>🔩 Assembly</span><span>+${fmt(gc.assemblyCost, sym)}</span></div>`);
  if (gc.isPrimed)
    extras.push(`<div class="review-extra-row"><span>🎨 ${esc(config.primerOptions.find(p => p.id === gc.primerLabel)?.label || 'Primer')}</span><span>+${fmt(gc.primerTotal, sym)}</span></div>`);
  extras.push(`<div class="review-extra-row"><span>⚙️ Handling &amp; labour</span><span>+${fmt(gc.labourBase, sym)}</span></div>`);

  return `
    <div class="review-group">
      <div class="review-group-hdr">${esc(group.name)}</div>
      ${filesHTML}
      ${extras.join('')}
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
  const panel = document.getElementById('order-summary');
  if (!panel) return;
  const sym = config.currencySymbol;

  const activeGroups = groups.filter(g => g.items.some(i => i.status === 'ready'));

  if (!activeGroups.length) {
    panel.innerHTML = `<h2 class="summary-title">Order Summary</h2>
      <p class="summary-empty">Upload STL files to see pricing.</p>`;
    return;
  }

  const rawTotal   = activeGroups.reduce((s, g) => s + (g.groupCost?.groupTotal ?? 0), 0);
  const grandTotal = calcOrderTotal(activeGroups, config);
  const minAdjust  = grandTotal - rawTotal;   // > 0 when minimum order floor was applied

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
            <span class="sum-price">${fmt(i.cost.totalCost, sym)}</span>
          </div>
          <div class="sum-file-detail">
            ${esc(i.cost.materialName)} · ${Math.round(i.settings.scale * 100)}% scale · ${i.settings.presupported ? '<span style="color:var(--green)">Pre-sup.</span>' : 'Std. supports'}
          </div>`).join('')}
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
        <div class="summary-group-subtotal">
          <span>${esc(g.name)} total</span>
          <span>${fmt(gc.groupTotal, sym)}</span>
        </div>
      </div>`;
  }).join('');

  panel.innerHTML = `
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

  const overlay = document.getElementById('order-overlay');
  if (!overlay) return;

  _orderNumber = generateOrderNumber();
  const sym        = config.currencySymbol;
  const grandTotal = calcOrderTotal(activeGroups, config);

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
  const grandTotal   = calcOrderTotal(activeGroups);

  const payload = {
    orderNumber: _orderNumber,
    customer: { name, email, notes },
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

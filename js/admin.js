// ============================================================
// admin.js — the pricing admin page (admin.html)
//
// Edits the pricing settings: every number the online calculator charges.
// They are stored under `formula` in the shop's pricing config metafield,
// read by the calculator (js/config.js getConfig) and by the relay, which
// re-prices every checkout with the same settings. See js/pricing-formula.js
// for what each setting does.
//
// Only the `formula` key is ever changed here. A save fetches the stored
// config fresh, replaces `formula`, keeps the previous version in
// `formula_history` (newest first, last 10), and writes the whole config back
// through the relay's password-gated POST /config. Every other key is left
// exactly as stored, so a save can never touch settings this page doesn't own.
//
// Signing in checks the password by writing the stored config back unchanged:
// the relay has no separate password check, and an identical write is a
// no-op for the shop.
// ============================================================

import {
  FORMULA_DEFAULTS, mergeFormula, formulaPartPrice, findMaterial, quantityLineTotal, applyFormula,
} from './pricing-formula.js?v=2';
import { RELAY_BASE_URL, DEFAULT_CONFIG } from './config.js?v=15';
import { calcItemCost, calcGroupCost, calcOrderTotal } from './calculator.js?v=16';

const $ = (id) => document.getElementById(id);
const PW_KEY = 'af_pricing_admin_pw';
const HISTORY_MAX = 10;

let password = null;
let rawConfig = {};       // the stored config, exactly as the relay returned it
let saved = null;         // the settings as last saved (merged)
let draft = null;         // the settings being edited
let section = 'overview';
let confirming = null;    // which destructive action is waiting for a yes
let compareTo = 'saved';  // preview comparison: 'saved' | 'defaults'

const clone = (o) => JSON.parse(JSON.stringify(o));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n == null || !Number.isFinite(n) ? '—' : `${n < 0 ? '−' : ''}£${Math.abs(n).toFixed(2)}`);
const signed = (n, unit = '%') => `${n > 0 ? '+' : ''}${n}${unit}`;
const getPath = (o, path) => path.split('.').reduce((v, k) => v?.[k], o);
function setPath(o, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((v, k) => v[k], o)[last] = value;
}
const slug = (s) => String(s).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';

// ============================================================
// Relay calls
// ============================================================

async function fetchStoredConfig() {
  const res = await fetch(`${RELAY_BASE_URL}/config`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`The store didn't answer (HTTP ${res.status}). Try again in a moment.`);
  const { config } = await res.json();
  return config && typeof config === 'object' ? config : {};
}

async function writeStoredConfig(config, pw) {
  const res = await fetch(`${RELAY_BASE_URL}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-password': pw },
    body: JSON.stringify({ config }),
  });
  if (res.status === 401) throw Object.assign(new Error('That password isn\'t right.'), { code: 401 });
  if (!res.ok) throw new Error(`Saving failed (HTTP ${res.status}). Nothing was changed.`);
}

// ============================================================
// Sign in
// ============================================================

async function signIn(pw) {
  $('login-btn').disabled = true;
  $('login-error').textContent = '';
  try {
    const stored = await fetchStoredConfig();
    await writeStoredConfig(stored, pw);   // no-op write = password check
    password = pw;
    try { sessionStorage.setItem(PW_KEY, pw); } catch { /* ignore */ }
    // Signing in from explore mode keeps the edits made there.
    const keep = isDirty() ? draft : null;
    load(stored);
    if (keep) draft = keep;
    $('login').hidden = true;
    $('app').hidden = false;
    render();
  } catch (err) {
    if (err.code === 401) { try { sessionStorage.removeItem(PW_KEY); } catch { /* ignore */ } }
    $('login').hidden = false;
    $('app').hidden = true;
    $('login-error').textContent = err.message;
  } finally {
    $('login-btn').disabled = false;
  }
}

function load(stored) {
  rawConfig = stored;
  saved = mergeFormula(stored.formula);
  draft = clone(saved);
}

// Explore mode: the stored settings load read-only (GET /config is public —
// the calculator itself reads it), so the page can be tried without the
// password. Saving asks for it.
async function explore() {
  $('login-error').textContent = '';
  try {
    load(await fetchStoredConfig());
    $('login').hidden = true;
    $('app').hidden = false;
    render();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
}
$('explore-btn').addEventListener('click', explore);

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  signIn($('login-password').value);
});
$('signout-btn').addEventListener('click', () => {
  if (isDirty() && confirming !== 'signout') { confirming = 'signout'; renderTop(); return; }
  try { sessionStorage.removeItem(PW_KEY); } catch { /* ignore */ }
  location.reload();
});

// ============================================================
// Settings — what each control edits
// ============================================================

const part = (ml, mm, presupported = true) => ({ volumeMl: ml, dimensions: { x: mm * 0.6, y: mm * 0.8, z: mm }, presupported });
const resinTermHint = (term, ref, unit) => (v, f) => {
  const t = getPath(f, term);
  const at = (x) => money(t.price * Math.pow(x / t[ref], t.curve));
  return unit === 'ml'
    ? `A ${t[ref]} ml part pays ${money(t.price)} for its resin; 5 ml pays ${at(5)}, 150 ml pays ${at(150)}.`
    : `A ${t[ref]} mm part pays ${money(t.price)} for its size; 30 mm pays ${at(30)}, 150 mm pays ${at(150)}.`;
};
const curveHint = (v) => {
  const pct = Math.round((Math.pow(2, v) - 1) * 100);
  return `Doubling the amount raises this part of the price by ${pct}%. Lower favours big parts, higher favours small ones.`;
};

const S = (path, label, min, max, step, unit, hint) => ({ kind: 'slider', path, label, min, max, step, unit, hint });
const T = (path, label) => ({ kind: 'toggle', path, label });
const X = (path, label, multiline) => ({ kind: 'text', path, label, multiline });

const ROUND_OPTIONS = [[0.01, '1p (exact)'], [0.1, '10p'], [0.25, '25p'], [0.5, '50p'], [1, '£1']];

const SECTIONS = [
  { id: 'overview', title: 'At a glance', prefixes: [], cards: [{
    title: 'The main dials',
    intro: 'The settings you\'ll reach for most. Every other detail is in the sections on the left.',
    fields: [
      S('resin.adjustPct', 'All resin prices', -50, 150, 1, '%', () => 'Moves every resin part up or down by a percentage.'),
      S('fdm.adjustPct', 'All FDM prices', -50, 150, 1, '%', () => 'Moves every FDM part up or down by a percentage.'),
      S('resin.minPrice', 'Cheapest resin part', 0, 30, 0.5, '£', () => 'No resin part costs less than this.'),
      S('fdm.minPrice', 'Cheapest FDM part', 0, 30, 0.5, '£', () => 'No FDM part costs less than this.'),
      S('discounts.quantityPct', 'Discount on extra copies', 0, 75, 1, '%', () => 'Each copy of a part after the first is this much cheaper.'),
      S('order.minimumOrderTotal', 'Minimum order', 0, 50, 0.5, '£', () => 'Small orders are raised to this total.'),
      S('order.customQuoteThreshold', 'Hand-quote orders from', 25, 1000, 5, '£', () => 'Orders at or above this go to you for a quote instead of checkout.'),
      { kind: 'select', path: 'order.roundTo', label: 'Round part prices up to', options: ROUND_OPTIONS, number: true },
    ],
  }, {
    title: 'What you offer',
    fields: [T('resin.enabled', 'Offer resin printing'), T('fdm.enabled', 'Offer FDM printing')],
  }] },

  { id: 'resin', title: 'Resin pricing', prefixes: ['resin.enabled', 'resin.label', 'resin.description', 'resin.adjustPct', 'resin.startingCharge', 'resin.volume', 'resin.size', 'resin.minPrice'], cards: [{
    title: 'How a resin part is priced',
    intro: 'Starting charge + a price for its resin + a price for its size, then the overall adjustment and the material\'s modifier, raised to the minimum and rounded up.',
    fields: [
      S('resin.adjustPct', 'Overall adjustment', -50, 150, 1, '%', () => 'Moves every resin price by a percentage.'),
      S('resin.startingCharge', 'Starting charge per part', -10, 20, 0.05, '£', () => 'A fixed amount in every part. Negative pulls small parts down.'),
      S('resin.minPrice', 'Minimum per part', 0, 30, 0.5, '£', () => 'No resin part costs less than this.'),
    ],
  }, {
    title: 'Resin used (volume)',
    intro: 'What a reference part pays for its resin, and how that grows as parts get bigger.',
    fields: [
      S('resin.volume.price', 'Price at the reference volume', 0, 40, 0.05, '£', resinTermHint('resin.volume', 'refMl', 'ml')),
      S('resin.volume.refMl', 'Reference volume', 1, 200, 1, 'ml', () => 'A typical part. Bending the curve keeps this part\'s price fixed.'),
      S('resin.volume.curve', 'Volume curve', 0.2, 1.2, 0.01, '', curveHint),
    ],
  }, {
    title: 'Part size (longest side)',
    intro: 'Long thin parts — wings, spears, banners — take more printer time and space than their resin suggests.',
    fields: [
      S('resin.size.price', 'Price at the reference length', 0, 40, 0.05, '£', resinTermHint('resin.size', 'refMm', 'mm')),
      S('resin.size.refMm', 'Reference length', 10, 300, 1, 'mm', () => 'A typical part\'s longest side.'),
      S('resin.size.curve', 'Size curve', 0, 2, 0.01, '', curveHint),
    ],
  }, {
    title: 'What customers see',
    fields: [T('resin.enabled', 'Offer resin printing'), X('resin.label', 'Name'), X('resin.description', 'Help text', true)],
  }] },

  { id: 'supports', title: 'Supports', prefixes: ['resin.supports'], cards: [{
    title: 'Unsupported uploads (we add the supports)',
    intro: 'A file uploaded without supports is priced as if it had them. Measured over 363 DM Stash parts: supports add about 22.5% + 2.5 ml, and make a part about 8% longer.',
    fields: [
      S('resin.supports.extraVolumePct', 'Extra resin for supports', 0, 80, 0.5, '%', () => 'Added to the part\'s resin.'),
      S('resin.supports.extraVolumeMl', 'Plus a flat amount of resin', 0, 15, 0.5, 'ml', () => 'Small parts need proportionally more support.'),
      S('resin.supports.extraSizePct', 'Extra length for supports', 0, 25, 0.5, '%', () => 'Also used to check the part still fits the printer.'),
      S('resin.supports.handlingFee', 'Fee for adding supports', 0, 20, 0.25, '£', () => 'Your time setting up supports, per unsupported part.'),
    ],
  }] },

  { id: 'fdm', title: 'FDM pricing', prefixes: ['fdm.enabled', 'fdm.label', 'fdm.description', 'fdm.adjustPct', 'fdm.startingCharge', 'fdm.filament', 'fdm.minPrice', 'fdm.shellMm', 'fdm.infillPct'], cards: [{
    title: 'How an FDM part is priced',
    intro: 'Starting charge + a price for its filament, then the overall adjustment, the filament\'s modifier and the colour surcharge, raised to the minimum and rounded up.',
    fields: [
      S('fdm.adjustPct', 'Overall adjustment', -50, 150, 1, '%', () => 'Moves every FDM price by a percentage.'),
      S('fdm.startingCharge', 'Starting charge per part', -10, 30, 0.05, '£', () => 'A fixed amount in every part: bed prep, removal, packing.'),
      S('fdm.minPrice', 'Minimum per part', 0, 30, 0.5, '£', () => 'No FDM part costs less than this.'),
    ],
  }, {
    title: 'Filament used',
    intro: 'Priced on the filament the part actually uses, which also tracks print time (about 2 minutes per gram on your Bambu).',
    fields: [
      S('fdm.filament.price', 'Price at the reference weight', 0, 80, 0.05, '£', (v, f) => {
        const t = f.fdm.filament; const at = (g) => money(t.price * Math.pow(g / t.refG, t.curve));
        return `A ${t.refG} g part pays ${money(t.price)}; 30 g pays ${at(30)}, 1 kg pays ${at(1000)}.`;
      }),
      S('fdm.filament.refG', 'Reference weight', 5, 1000, 5, 'g', () => 'A typical part. Bending the curve keeps this part\'s price fixed.'),
      S('fdm.filament.curve', 'Filament curve', 0.2, 1.2, 0.01, '', curveHint),
    ],
  }, {
    title: 'Filament estimate',
    intro: 'How much filament a part uses: walls this thick over the whole surface, plus infill inside. Match your slicer profile.',
    fields: [
      S('fdm.shellMm', 'Wall thickness', 0.4, 3, 0.05, 'mm', () => '2 wall loops of a 0.4 mm nozzle ≈ 0.8 mm.'),
      S('fdm.infillPct', 'Infill', 0, 60, 1, '%', () => 'Within 5% of real Bambu slices at 0.8 mm / 8%.'),
    ],
  }, {
    title: 'What customers see',
    fields: [T('fdm.enabled', 'Offer FDM printing'), X('fdm.label', 'Name'), X('fdm.description', 'Help text', true)],
  }] },

  { id: 'materials', title: 'Materials & colours', prefixes: ['resin.materials', 'fdm.materials', 'fdm.colours'], cards: [] },
  { id: 'discounts', title: 'Discounts', prefixes: ['discounts'], cards: [{
    title: 'Extra copies',
    fields: [S('discounts.quantityPct', 'Discount on each extra copy', 0, 75, 1, '%', (v) => `Ordering 4 of a £10 part: ${money(10 + 3 * 10 * (1 - v / 100))}.`)],
  }] },
  { id: 'finishing', title: 'Assembly & primer', prefixes: ['finishes'], cards: [{
    title: 'Assembly',
    intro: 'Charged per model when the customer picks "Receive assembled". Joins = parts − 1.',
    fields: [
      S('finishes.assemblyFirst', 'First join', 0, 30, 0.5, '£', () => 'A two-part model (body + base) costs this.'),
      S('finishes.assemblyPerJoint', 'Each extra join', 0, 15, 0.5, '£', (v, f) => `A five-part model: ${money(Math.min(f.finishes.assemblyFirst + 3 * v, f.finishes.assemblyMax))}.`),
      S('finishes.assemblyMax', 'Most assembly can cost', 0, 150, 1, '£', () => 'Big multi-part models stop here.'),
    ],
  }, {
    title: 'Primer for the biggest models',
    fields: [S('finishes.primer.maxPrice', 'Primer above the last row', 0, 60, 0.5, '£', () => 'Also the most primer can ever cost. The rows are below.')],
  }] },
  { id: 'order', title: 'Order rules', prefixes: ['order'], cards: [{
    title: 'Order rules',
    fields: [
      { kind: 'select', path: 'order.roundTo', label: 'Round part prices up to', options: ROUND_OPTIONS, number: true },
      S('order.minimumOrderTotal', 'Minimum order', 0, 50, 0.5, '£', () => 'Small orders are raised to this total.'),
      S('order.customQuoteThreshold', 'Hand-quote orders from', 25, 1000, 5, '£', () => 'Orders at or above this go to you for a quote instead of straight to checkout.'),
    ],
  }] },
  { id: 'printers', title: 'Printers', prefixes: ['resin.buildPlate', 'fdm.buildPlate'], cards: [
    ['resin', 'Resin printer'], ['fdm', 'FDM printer'],
  ].map(([m, title]) => ({
    title,
    intro: 'Parts bigger than this (after the safety margin) can\'t be priced automatically and go to a quote.',
    fields: [
      S(`${m}.buildPlate.x`, 'Width', 50, 600, 1, 'mm'),
      S(`${m}.buildPlate.y`, 'Depth', 50, 600, 1, 'mm'),
      S(`${m}.buildPlate.z`, 'Height', 50, 600, 1, 'mm'),
      S(`${m}.buildPlate.marginPct`, 'Safety margin', 0, 40, 1, '%', () => m === 'resin' ? 'Room for supports and rafts.' : 'Room for brims and skirts.'),
    ],
  })) },
  { id: 'backup', title: 'Backup & history', prefixes: [], cards: [] },
];

const ALL_FIELDS = SECTIONS.flatMap((s) => s.cards.flatMap((c) => c.fields));
const fieldFor = (path) => ALL_FIELDS.find((f) => f.path === path);

// ============================================================
// Rendering
// ============================================================

function isDirty() { return draft && JSON.stringify(draft) !== JSON.stringify(saved); }
function sectionDirty(s) {
  return s.prefixes.some((p) => JSON.stringify(getPath(draft, p)) !== JSON.stringify(getPath(saved, p)));
}

function render() {
  renderTop();
  renderNav();
  renderPanel();
  renderPreview();
}

function renderTop() {
  const dirty = isDirty();
  const st = $('status');
  if (dirty) { st.textContent = 'Unsaved changes — customers still see the last saved prices'; st.className = 'status dirty'; }
  else if (!password && !st.dataset.flash) { st.textContent = 'Exploring — sign in to save'; st.className = 'status'; }
  else if (!st.dataset.flash) { st.textContent = saved && rawConfig.formula ? 'All changes saved' : 'Default prices (nothing saved yet)'; st.className = 'status'; }
  $('save-btn').disabled = !dirty;
  $('discard-slot').innerHTML = confirming === 'signout'
    ? `<span class="confirm">Sign out and lose your changes? <button class="btn danger small" type="button" id="signout-yes">Sign out</button>
       <button class="btn quiet small" type="button" data-cancel>Keep editing</button></span>`
    : dirty
      ? (confirming === 'discard'
        ? `<span class="confirm">Throw away your changes? <button class="btn danger small" type="button" data-discard-yes>Discard</button>
           <button class="btn quiet small" type="button" data-cancel>Keep</button></span>`
        : '<button class="btn quiet small" type="button" data-discard>Discard changes</button>')
      : '';
}

function renderNav() {
  $('sections').innerHTML = SECTIONS.map((s) => `
    <button type="button" data-section="${s.id}" aria-current="${s.id === section}">${esc(s.title)}${sectionDirty(s) ? '<span class="dot" title="Unsaved changes">●</span>' : ''}</button>`).join('');
}

function fieldHTML(f) {
  const v = getPath(draft, f.path);
  const d = getPath(FORMULA_DEFAULTS, f.path);
  const id = 'f-' + f.path.replace(/\./g, '-');
  const changed = JSON.stringify(v) !== JSON.stringify(getPath(saved, f.path));
  if (f.kind === 'toggle') {
    return `<div class="field${changed ? ' changed' : ''}" data-path="${f.path}">
      <label class="toggle"><input type="checkbox" id="${id}" data-input="toggle" ${v ? 'checked' : ''}> ${esc(f.label)}</label></div>`;
  }
  if (f.kind === 'text') {
    return `<div class="field text-field${changed ? ' changed' : ''}" data-path="${f.path}">
      <label for="${id}">${esc(f.label)}</label>
      ${f.multiline ? `<textarea id="${id}" rows="2" data-input="text">${esc(v)}</textarea>` : `<input type="text" id="${id}" data-input="text" value="${esc(v)}">`}</div>`;
  }
  if (f.kind === 'select') {
    return `<div class="field${changed ? ' changed' : ''}" data-path="${f.path}">
      <div class="field-top"><label for="${id}">${esc(f.label)}</label>
      <select id="${id}" data-input="select">${f.options.map(([val, label]) => `<option value="${val}"${val === v ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></div></div>`;
  }
  const unitPre = f.unit === '£' ? '£' : '';
  const unitPost = f.unit && f.unit !== '£' ? f.unit : '';
  const show = (x) => (f.unit === '£' ? money(x) : `${x}${unitPost}`);
  return `<div class="field${changed ? ' changed' : ''}" data-path="${f.path}">
    <div class="field-top"><label for="${id}">${esc(f.label)}</label>
      <span class="field-val"><span class="unit">${unitPre}</span><input type="number" id="${id}-n" data-input="number" step="${f.step}" value="${v}" aria-label="${esc(f.label)}"><span class="unit">${esc(unitPost)}</span></span></div>
    <input type="range" id="${id}" data-input="range" min="${f.min}" max="${f.max}" step="${f.step}" value="${v}" aria-label="${esc(f.label)} slider">
    <div class="hint"><span class="hint-text">${esc(f.hint ? f.hint(v, draft) : '')}</span>
      <span class="def">Default ${esc(show(d))}${v !== d ? ` · <button type="button" class="link" data-reset="${f.path}">Reset</button>` : ''}</span></div>
  </div>`;
}

function cardHTML(c) {
  return `<section class="card">
    <div class="card-head"><h2>${esc(c.title)}</h2></div>
    ${c.intro ? `<p class="intro">${esc(c.intro)}</p>` : ''}
    <div class="grid2">${c.fields.map(fieldHTML).join('')}</div>
  </section>`;
}

function renderPanel() {
  const s = SECTIONS.find((x) => x.id === section);
  let html = s.cards.map(cardHTML).join('');
  if (s.id === 'materials') html = materialsHTML();
  if (s.id === 'discounts') html += multiPartHTML();
  if (s.id === 'finishing') html += primerHTML();
  if (s.id === 'backup') html = backupHTML();
  $('panel').innerHTML = html;
}

// ---- Editable lists ---------------------------------------------------

function listCard({ title, intro, cls, path, head, row, addLabel, addItem, defaultFirst }) {
  const list = getPath(draft, path);
  return `<section class="card" data-list="${path}" data-cls="${cls}">
    <div class="card-head"><h2>${esc(title)}</h2>
      <button type="button" class="btn quiet small" data-add="${path}" data-template='${esc(JSON.stringify(addItem))}'>${esc(addLabel)}</button></div>
    ${intro ? `<p class="intro">${esc(intro)}</p>` : ''}
    <div class="rows ${cls}">
      <div class="row row-head">${head.map((h) => `<span>${esc(h)}</span>`).join('')}</div>
      ${list.map((item, i) => `<div class="row" data-i="${i}">${row(item, i)}
        <span class="row-actions">
          ${defaultFirst && i === 0 ? '<span class="chip">Default</span>' : ''}
          ${defaultFirst && i > 0 ? `<button type="button" class="btn quiet small" data-first="${i}">Make default</button>` : ''}
          <button type="button" class="btn danger small" data-remove="${i}" ${list.length <= (defaultFirst ? 1 : 0) ? 'disabled' : ''} aria-label="Remove">Remove</button>
        </span></div>`).join('')}
    </div>
  </section>`;
}
const cell = (key, value, type = 'text', step) =>
  `<input type="${type}" data-key="${key}" value="${esc(value)}"${step ? ` step="${step}"` : ''} aria-label="${esc(key)}">`;

function materialsHTML() {
  return [
    listCard({
      title: 'Resins', cls: 'rows-materials', path: 'resin.materials', defaultFirst: true,
      intro: 'Each resin changes the price by a percentage. Customers pick one per model when there\'s more than one; the first is the default.',
      head: ['Name', 'Price change %', ''],
      row: (m) => cell('name', m.name) + cell('modifierPct', m.modifierPct, 'number', 1),
      addLabel: 'Add resin', addItem: { id: '', name: 'New resin', modifierPct: 0 },
    }),
    listCard({
      title: 'Filaments', cls: 'rows-filaments', path: 'fdm.materials', defaultFirst: true,
      intro: 'Density turns the estimated filament volume into grams (PLA 1.24, PETG 1.27, ABS 1.04, TPU 1.21 g/ml).',
      head: ['Name', 'Price change %', 'Density g/ml', ''],
      row: (m) => cell('name', m.name) + cell('modifierPct', m.modifierPct, 'number', 1) + cell('gPerMl', m.gPerMl ?? 1.24, 'number', 0.01),
      addLabel: 'Add filament', addItem: { id: '', name: 'New filament', modifierPct: 0, gPerMl: 1.24 },
    }),
    listCard({
      title: 'Filament colours', cls: 'rows-colours', path: 'fdm.colours',
      intro: 'Customers pick a colour per FDM part. The surcharge is a percentage of that part\'s price.',
      head: ['', 'Colour', 'Surcharge %', ''],
      row: (c) => cell('hex', c.hex, 'color') + cell('name', c.name) + cell('surchargePct', c.surchargePct, 'number', 1),
      addLabel: 'Add colour', addItem: { id: '', name: 'New colour', hex: '#888888', surchargePct: 0 },
    }),
  ].join('');
}

function multiPartHTML() {
  return listCard({
    title: 'Multi-part models', cls: 'rows-tiers', path: 'discounts.multiPart',
    intro: 'A model with at least this many parts (counting copies) gets this much off its parts. The best matching tier applies; assembly and primer are never discounted.',
    head: ['From parts', 'Discount %', ''],
    row: (t) => cell('minParts', t.minParts, 'number', 1) + cell('pct', t.pct, 'number', 0.5),
    addLabel: 'Add tier', addItem: { minParts: 4, pct: 5 },
  });
}

function primerHTML() {
  return listCard({
    title: 'Primer prices', cls: 'rows-tiers', path: 'finishes.primer.tiers',
    intro: 'Priced once per model from its total resin. A model bigger than the last row pays the maximum below.',
    head: ['Up to ml', 'Price £', ''],
    row: (t) => cell('maxMl', t.maxMl, 'number', 1) + cell('price', t.price, 'number', 0.5),
    addLabel: 'Add row', addItem: { maxMl: 300, price: 20 },
  }) + listCard({
    title: 'Primer colours', cls: 'rows-primer-colours', path: 'finishes.primer.colours',
    intro: 'The colours customers can choose. "Unprimed" is always offered and free.',
    head: ['', 'Name', ''],
    row: (c) => cell('hex', c.hex ?? '#888888', 'color') + cell('label', c.label),
    addLabel: 'Add primer colour', addItem: { id: '', label: 'New Primer', hex: '#888888' },
  });
}

function backupHTML() {
  const history = Array.isArray(rawConfig.formula_history) ? rawConfig.formula_history : [];
  return `<section class="card">
    <div class="card-head"><h2>Backup</h2></div>
    <p class="intro">Download the settings as a file to keep a copy, or load a file you saved earlier. Loading only changes this page until you save.</p>
    <div class="row-actions">
      <button type="button" class="btn quiet" data-export>Download settings</button>
      <label class="btn quiet" for="import-file">Load settings from a file</label>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
    </div>
  </section>
  <section class="card">
    <div class="card-head"><h2>Previous versions</h2></div>
    <p class="intro">Each save keeps the version it replaced (the last ${HISTORY_MAX}). Loading one puts it in the editor; save to make it live again.</p>
    ${history.length ? `<ul class="history">${history.map((h, i) => `<li><span>${esc(new Date(h.savedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}</span>
      <button type="button" class="btn quiet small" data-history="${i}">Load into editor</button></li>`).join('')}</ul>` : '<p class="intro">No earlier versions yet.</p>'}
  </section>
  <section class="card">
    <div class="card-head"><h2>Start again</h2></div>
    <p class="intro">Put every setting back to the defaults (the prices approved in the pricing trainer). Only changes this page until you save.</p>
    <div>${confirming === 'reset'
      ? `<span class="confirm">Reset everything to the defaults? <button type="button" class="btn danger small" data-reset-all-yes>Reset all</button>
         <button type="button" class="btn quiet small" data-cancel>Cancel</button></span>`
      : '<button type="button" class="btn danger" data-reset-all>Reset all to defaults</button>'}</div>
  </section>`;
}

// ============================================================
// Live preview
// ============================================================

const RESIN_SAMPLES = [
  ['32mm base', part(3, 28)], ['32mm body', part(6, 49)], ['32mm dragon wing', part(11, 138)],
  ['75mm base', part(31, 63)], ['75mm body', part(49, 108)], ['75mm large body', part(72, 144)],
  ['Bust', part(112, 130)], ['Centrepiece part', part(250, 151)],
  ['75mm body, uploaded unsupported', part(40, 100, false)],
];
const FDM_SAMPLES = [
  ['Small prop', { volumeMl: 50.95, areaMm2: 27900 }], ['Scenery piece', { volumeMl: 177.98, areaMm2: 34320 }],
  ['Terrain floor tile', { volumeMl: 1142.87, areaMm2: 130640 }], ['Terrain tower', { volumeMl: 4079.43, areaMm2: 232370 }],
];

function priceResin(p, f, materialId) { return formulaPartPrice({ ...p, method: 'resin', materialId }, f)?.price ?? null; }
function priceFdm(p, f, materialId) {
  const r = formulaPartPrice({ ...p, dimensions: { x: 100, y: 100, z: 100 }, method: 'pla', materialId }, f);
  return r ? { price: r.price, grams: r.grams } : null;
}

const tryState = { method: 'resin', materialId: '', ml: 25, mm: 80, presupported: true, grams: 100, qty: 1, parts: 4, assembled: true, primed: true, size: '32' };

function configFor(f) {
  return applyFormula({ ...DEFAULT_CONFIG, ...rawConfig }, f);
}

function exampleModel(f) {
  const cfg = configFor(f);
  const sizes = { 32: [6, 49, 3, 28], 75: [49, 108, 31, 63] };
  const [bodyMl, bodyMm, partMl, partMm] = sizes[tryState.size];
  const items = Array.from({ length: tryState.parts }, (_, i) => {
    const ml = i === 0 ? bodyMl : partMl, mm = i === 0 ? bodyMm : partMm;
    const stl = { volumeMl: ml, dimensions: { x: mm * 0.6, y: mm * 0.8, z: mm }, areaMm2: 6.5 * Math.pow(ml * 1000, 2 / 3) };
    const settings = { scale: 1, quantity: 1, presupported: true, materialId: cfg.materials[0]?.id };
    return { status: 'ready', settings, cost: calcItemCost(stl, settings, cfg, 'resin') };
  });
  const gc = calcGroupCost(items, { assembly: tryState.assembled, primer: tryState.primed ? (cfg.primerOptions[1]?.id ?? 'unprimed') : 'unprimed', extras: [] }, cfg);
  const total = calcOrderTotal([{ groupCost: gc }], cfg);
  return { gc, total, cfg };
}

function renderPreview() {
  const base = compareTo === 'saved' ? saved : mergeFormula(undefined);
  const baseLabel = compareTo === 'saved' ? 'Saved' : 'Default';
  const cmp = (now, then) => {
    if (now == null) return '<b>Too big</b>';
    const d = then == null ? 0 : now - then;
    return `<b class="${d > 0.004 ? 'up' : d < -0.004 ? 'down' : ''}">${money(now)}</b>`;
  };
  const resinRows = draft.resin.enabled ? RESIN_SAMPLES.map(([label, p]) => `<tr><td>${esc(label)}<span class="sub">${p.volumeMl} ml · ${p.dimensions.z} mm</span></td>
    <td class="r num">${money(priceResin(p, base))}</td><td class="r num">${cmp(priceResin(p, draft), priceResin(p, base))}</td></tr>`).join('') : '';
  const fdmRows = draft.fdm.enabled ? FDM_SAMPLES.map(([label, p]) => {
    const now = priceFdm(p, draft), then = priceFdm(p, base);
    return `<tr><td>${esc(label)}<span class="sub">≈${Math.round(now?.grams ?? 0)} g</span></td>
      <td class="r num">${money(then?.price)}</td><td class="r num">${cmp(now?.price, then?.price)}</td></tr>`;
  }).join('') : '';

  // Try a part
  const methodKey = tryState.method === 'pla' ? 'fdm' : 'resin';
  const mats = draft[methodKey].materials;
  if (!mats.some((m) => m.id === tryState.materialId)) tryState.materialId = mats[0]?.id;
  let tryResult;
  if (tryState.method === 'pla') {
    const mat = findMaterial(draft.fdm, tryState.materialId);
    // Feed the exact grams in: a part whose whole volume is "shell" uses
    // volume × density, so volume = grams ÷ density.
    const r = formulaPartPrice({ volumeMl: tryState.grams / (mat.gPerMl || 1.24), dimensions: { x: 1, y: 1, z: 1 }, areaMm2: 1e12, method: 'pla', materialId: tryState.materialId }, draft);
    tryResult = r ? { unit: r.price, line: quantityLineTotal(r.price, tryState.qty, draft), note: `${tryState.grams} g of ${esc(r.materialName)} · about ${Math.round((49 + 1.96 * tryState.grams) / 60 * 10) / 10} h on the printer` } : null;
  } else {
    const r = formulaPartPrice({ volumeMl: tryState.ml, dimensions: { x: tryState.mm * 0.6, y: tryState.mm * 0.8, z: tryState.mm }, presupported: tryState.presupported, method: 'resin', materialId: tryState.materialId }, draft);
    tryResult = r ? { unit: r.price, line: quantityLineTotal(r.price, tryState.qty, draft), note: `${esc(r.materialName)} · priced on ${r.pricedVolumeMl.toFixed(1)} ml, ${Math.round(r.pricedLongestMm)} mm${r.minApplied ? ' · minimum applied' : ''}` } : null;
  }

  const ex = exampleModel(draft);
  const exBase = exampleModel(base);
  $('preview').innerHTML = `
    <section class="card">
      <div class="card-head"><h2>Live preview</h2>
        <select id="compare" aria-label="Compare with"><option value="saved"${compareTo === 'saved' ? ' selected' : ''}>vs saved</option><option value="defaults"${compareTo === 'defaults' ? ' selected' : ''}>vs defaults</option></select></div>
      <table><thead><tr><th>Part</th><th class="r">${baseLabel}</th><th class="r">Now</th></tr></thead>
        <tbody>${resinRows}${fdmRows}</tbody></table>
    </section>
    <section class="card">
      <h2>Try a part</h2>
      <div class="try">
        <label>Print method<select id="t-method">${draft.resin.enabled ? `<option value="resin"${tryState.method === 'resin' ? ' selected' : ''}>${esc(draft.resin.label)}</option>` : ''}${draft.fdm.enabled ? `<option value="pla"${tryState.method === 'pla' ? ' selected' : ''}>${esc(draft.fdm.label)}</option>` : ''}</select></label>
        <label>Material<select id="t-material">${mats.map((m) => `<option value="${esc(m.id)}"${m.id === tryState.materialId ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
        ${tryState.method === 'pla'
          ? `<label>Filament (g)<input type="number" id="t-grams" min="1" step="1" value="${tryState.grams}"></label>`
          : `<label>Resin (ml)<input type="number" id="t-ml" min="0.1" step="0.1" value="${tryState.ml}"></label>
             <label>Longest side (mm)<input type="number" id="t-mm" min="1" step="1" value="${tryState.mm}"></label>
             <label style="flex-direction:row;display:flex;gap:6px;align-items:center"><input type="checkbox" id="t-sup" ${tryState.presupported ? 'checked' : ''}> Pre-supported</label>`}
        <label>Copies<input type="number" id="t-qty" min="1" step="1" value="${tryState.qty}"></label>
        <div class="try-result">${tryResult
          ? `<span class="big">${money(tryResult.unit)}</span> each${tryState.qty > 1 ? ` · ${tryState.qty} copies <b>${money(tryResult.line)}</b>` : ''}<br><span class="sub">${tryResult.note}</span>`
          : 'Can\'t be priced.'}</div>
      </div>
    </section>
    ${draft.resin.enabled ? `<section class="card">
      <h2>Example model</h2>
      <div class="try">
        <label>Scale<select id="e-size"><option value="32"${tryState.size === '32' ? ' selected' : ''}>32mm figure</option><option value="75"${tryState.size === '75' ? ' selected' : ''}>75mm figure</option></select></label>
        <label>Parts<input type="number" id="e-parts" min="1" max="30" step="1" value="${tryState.parts}"></label>
        <label style="flex-direction:row;display:flex;gap:6px;align-items:center"><input type="checkbox" id="e-asm" ${tryState.assembled ? 'checked' : ''}> Assembled</label>
        <label style="flex-direction:row;display:flex;gap:6px;align-items:center"><input type="checkbox" id="e-prime" ${tryState.primed ? 'checked' : ''}> Primed</label>
        <div class="try-result">
          Parts ${money(ex.gc.fileSubtotal)}${ex.gc.multiPartDiscount > 0 ? ` · multi-part −${money(ex.gc.multiPartDiscount)} (${ex.gc.multiPartPct}%)` : ''}${ex.gc.assemblyCost ? ` · assembly ${money(ex.gc.assemblyCost)}` : ''}${ex.gc.primerTotal ? ` · primer ${money(ex.gc.primerTotal)}` : ''}<br>
          <span class="big">${money(ex.total)}</span> <span class="sub">${baseLabel.toLowerCase()}: ${money(exBase.total)}${ex.total >= draft.order.customQuoteThreshold ? ' · goes to a hand quote' : ''}${ex.total > ex.gc.groupTotal ? ' · raised to the minimum order' : ''}</span>
        </div>
      </div>
    </section>` : ''}`;
}

// ============================================================
// Editing
// ============================================================

function changed({ panel = false } = {}) {
  confirming = confirming === 'signout' ? null : confirming;
  const st = $('status'); delete st.dataset.flash;
  renderTop();
  renderNav();
  if (panel) renderPanel();
  renderPreview();
}

function refreshField(row) {
  const f = fieldFor(row.dataset.path);
  if (!f || f.kind !== 'slider') return;
  const v = getPath(draft, f.path);
  row.querySelector('.hint-text').textContent = f.hint ? f.hint(v, draft) : '';
  row.classList.toggle('changed', JSON.stringify(v) !== JSON.stringify(getPath(saved, f.path)));
  const d = getPath(FORMULA_DEFAULTS, f.path);
  const def = row.querySelector('.def');
  const show = f.unit === '£' ? money(d) : `${d}${f.unit && f.unit !== '£' ? f.unit : ''}`;
  def.innerHTML = `Default ${esc(show)}${v !== d ? ` · <button type="button" class="link" data-reset="${f.path}">Reset</button>` : ''}`;
  // Hints that read other settings (assembly, curves) stay current too.
  for (const other of document.querySelectorAll('.field[data-path]')) {
    const of = fieldFor(other.dataset.path);
    if (of?.kind === 'slider' && of.hint && other !== row) other.querySelector('.hint-text').textContent = of.hint(getPath(draft, of.path), draft);
  }
}

$('panel').addEventListener('input', (e) => {
  const t = e.target;
  const row = t.closest('.field[data-path]');
  if (row) {
    const path = row.dataset.path;
    const kind = t.dataset.input;
    if (kind === 'range' || kind === 'number') {
      const v = Number(t.value);
      if (!Number.isFinite(v)) return;
      setPath(draft, path, v);
      const twin = row.querySelector(kind === 'range' ? '[data-input="number"]' : '[data-input="range"]');
      if (twin) twin.value = v;
      refreshField(row);
    } else if (kind === 'text') {
      setPath(draft, path, t.value);
    }
    changed();
    return;
  }
  const listRow = t.closest('.row[data-i]');
  if (listRow && t.dataset.key) {
    const list = getPath(draft, listRow.closest('[data-list]').dataset.list);
    const item = list[+listRow.dataset.i];
    item[t.dataset.key] = t.type === 'number' ? (Number.isFinite(Number(t.value)) ? Number(t.value) : item[t.dataset.key]) : t.value;
    changed();
  }
});

$('panel').addEventListener('change', (e) => {
  const t = e.target;
  const row = t.closest('.field[data-path]');
  if (row && t.dataset.input === 'toggle') { setPath(draft, row.dataset.path, t.checked); changed({ panel: true }); return; }
  if (row && t.dataset.input === 'select') {
    const f = fieldFor(row.dataset.path);
    setPath(draft, row.dataset.path, f?.number ? Number(t.value) : t.value);
    changed({ panel: true });
    return;
  }
  if (t.id === 'import-file' && t.files?.[0]) importFile(t.files[0]);
});

$('panel').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  if (d.reset) { setPath(draft, d.reset, clone(getPath(FORMULA_DEFAULTS, d.reset))); changed({ panel: true }); }
  else if (d.add) {
    getPath(draft, d.add).push(JSON.parse(d.template));
    changed({ panel: true });
  } else if (d.remove !== undefined) {
    getPath(draft, b.closest('[data-list]').dataset.list).splice(+d.remove, 1);
    changed({ panel: true });
  } else if (d.first !== undefined) {
    const list = getPath(draft, b.closest('[data-list]').dataset.list);
    list.unshift(...list.splice(+d.first, 1));
    changed({ panel: true });
  } else if ('export' in d) exportFile();
  else if (d.history !== undefined) {
    draft = mergeFormula(rawConfig.formula_history[+d.history].formula);
    section = 'overview';
    flash('Loaded an earlier version — check it, then save to make it live');
    render();
  } else if ('resetAll' in d) { confirming = 'reset'; renderPanel(); }
  else if ('resetAllYes' in d) { draft = mergeFormula(undefined); confirming = null; changed({ panel: true }); }
  else if ('cancel' in d) { confirming = null; renderPanel(); renderTop(); }
});

$('sections').addEventListener('click', (e) => {
  const b = e.target.closest('[data-section]');
  if (!b) return;
  section = b.dataset.section;
  confirming = null;
  renderNav();
  renderPanel();
  window.scrollTo({ top: 0 });
});

$('preview').addEventListener('input', (e) => {
  const t = e.target;
  const num = (v, min, fallback) => (Number.isFinite(Number(v)) && Number(v) >= min ? Number(v) : fallback);
  if (t.id === 't-ml') tryState.ml = num(t.value, 0.01, tryState.ml);
  else if (t.id === 't-mm') tryState.mm = num(t.value, 1, tryState.mm);
  else if (t.id === 't-grams') tryState.grams = num(t.value, 1, tryState.grams);
  else if (t.id === 't-qty') tryState.qty = Math.floor(num(t.value, 1, tryState.qty));
  else if (t.id === 'e-parts') tryState.parts = Math.min(30, Math.floor(num(t.value, 1, tryState.parts)));
  else return;
  const focusId = t.id, pos = t.selectionStart;
  renderPreview();
  const el = $(focusId);
  if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch { /* number inputs */ } }
});
$('preview').addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'compare') compareTo = t.value;
  else if (t.id === 't-method') { tryState.method = t.value; tryState.materialId = ''; }
  else if (t.id === 't-material') tryState.materialId = t.value;
  else if (t.id === 't-sup') tryState.presupported = t.checked;
  else if (t.id === 'e-size') tryState.size = t.value;
  else if (t.id === 'e-asm') tryState.assembled = t.checked;
  else if (t.id === 'e-prime') tryState.primed = t.checked;
  else return;
  renderPreview();
});

document.querySelector('.top').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if ('discard' in b.dataset) { confirming = 'discard'; renderTop(); }
  else if ('discardYes' in b.dataset) { draft = clone(saved); confirming = null; render(); }
  else if ('cancel' in b.dataset) { confirming = null; renderTop(); }
  else if (b.id === 'signout-yes') { try { sessionStorage.removeItem(PW_KEY); } catch { /* ignore */ } location.reload(); }
});

// ============================================================
// Saving
// ============================================================

/** Tidy the settings before they go live: ids for new materials and colours,
 *  sorted tiers, nothing non-numeric where a number belongs. */
function cleaned(f) {
  const out = mergeFormula(clone(f));
  const withIds = (list, nameKey) => {
    const used = new Set();
    for (const item of list) {
      let id = item.id || slug(item[nameKey]);
      while (used.has(id) || id === 'unprimed') id = `${id}-2`;
      item.id = id;
      used.add(id);
      item[nameKey] = String(item[nameKey] || '').trim() || 'Unnamed';
    }
    return list;
  };
  withIds(out.resin.materials, 'name');
  withIds(out.fdm.materials, 'name');
  withIds(out.fdm.colours, 'name');
  withIds(out.finishes.primer.colours, 'label');
  for (const m of out.fdm.materials) if (!(m.gPerMl > 0)) m.gPerMl = 1.24;
  for (const c of [...out.fdm.colours, ...out.finishes.primer.colours]) if (!/^#[0-9a-f]{6}$/i.test(c.hex || '')) c.hex = '#888888';
  out.discounts.multiPart = out.discounts.multiPart
    .filter((t) => t.minParts >= 2 && t.pct > 0 && t.pct < 100).sort((a, b) => a.minParts - b.minParts);
  out.finishes.primer.tiers = out.finishes.primer.tiers
    .filter((t) => t.maxMl > 0 && t.price >= 0).sort((a, b) => a.maxMl - b.maxMl);
  if (!out.resin.enabled && !out.fdm.enabled) out.resin.enabled = true;   // the calculator needs one
  out.version = 2;
  return out;
}

$('save-btn').addEventListener('click', async () => {
  if (!password) {
    // Explore mode: sign in first; the edits are kept (see signIn).
    $('app').hidden = true;
    $('login').hidden = false;
    $('login-error').textContent = 'Sign in to save. Your changes are kept.';
    $('login-password').focus();
    return;
  }
  const btn = $('save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const fresh = await fetchStoredConfig();   // never overwrite keys changed elsewhere
    const next = cleaned(draft);
    const history = Array.isArray(fresh.formula_history) ? fresh.formula_history : [];
    const updated = {
      ...fresh,
      formula: next,
      formula_history: fresh.formula ? [{ savedAt: new Date().toISOString(), formula: fresh.formula }, ...history].slice(0, HISTORY_MAX) : history,
    };
    await writeStoredConfig(updated, password);
    load(updated);
    flash('Saved — the calculator uses these prices now', 'ok');
    render();
  } catch (err) {
    flash(err.message, 'dirty');
    if (err.code === 401) { try { sessionStorage.removeItem(PW_KEY); } catch { /* ignore */ } }
  } finally {
    btn.textContent = 'Save and publish';
    btn.disabled = !isDirty();
  }
});

function flash(text, cls = 'ok') {
  const st = $('status');
  st.textContent = text;
  st.className = `status ${cls}`;
  st.dataset.flash = '1';
  setTimeout(() => { delete st.dataset.flash; renderTop(); }, 6000);
}

window.addEventListener('beforeunload', (e) => {
  if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
});

// ============================================================
// Backup
// ============================================================

function exportFile() {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), formula: cleaned(draft) }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `arcane-flame-pricing-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function importFile(file) {
  try {
    const data = JSON.parse(await file.text());
    draft = mergeFormula(data.formula ?? data);
    flash('Loaded the file — check it, then save to make it live');
    render();
  } catch {
    flash('That file isn\'t a pricing settings file.', 'dirty');
  }
}

// ============================================================
// Start
// ============================================================

(() => {
  let pw = null;
  try { pw = sessionStorage.getItem(PW_KEY); } catch { /* ignore */ }
  if (pw) signIn(pw); else $('login-password').focus();
})();

// ============================================================
// icons.js — Minimal inline SVG icon set, Lucide-style (MIT license
// inspiration: https://lucide.dev). Hand-authored, self-contained —
// no external requests, no build step, no npm dependency.
// All icons share Lucide's conventions: 24x24 viewBox, no fill,
// currentColor stroke, 2px stroke width, round caps/joins.
// ============================================================

const PATHS = {
  flame: '<path d="M8.5 14.5c-.7-1.7-.3-3 .8-4.6-.2 1.2.2 2 1 2.4-.3-2.6.4-5.2 2.7-6.8-.4 2 .3 3.6 1.6 5 1.1 1.1 1.7 2.3 1.7 3.7a4.3 4.3 0 0 1-8.6.3c0-.7.2-1.3.4-1.9 .1.5.3 1 .4 1.9z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  printer: '<polyline points="6 9 6 3 18 3 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  flask: '<path d="M9 2v6.3a2 2 0 0 1-.3 1L4 17a2 2 0 0 0 1.7 3h12.6a2 2 0 0 0 1.7-3l-4.7-7.7a2 2 0 0 1-.3-1V2"/><line x1="8" y1="2" x2="16" y2="2"/><line x1="7.5" y1="14" x2="16.5" y2="14"/>',
  layers: '<polygon points="12 2 2 8 12 14 22 8 12 2"/><polyline points="2 13 12 19 22 13"/><polyline points="2 18 12 24 22 18"/>',
  paintbrush: '<path d="M18.4 2.6a2 2 0 0 1 2.8 2.8L11 15.6l-3.7.9.9-3.7z"/><path d="M9 15.6 4 21c-1 1-2.5.5-2.5-1 0-2 1-4 3-5.5"/>',
  puzzle: '<path d="M15.5 6.5a2 2 0 1 1 3.5 1.3V11h1.5a2 2 0 0 1 0 4H19v3.5a2 2 0 0 1-2 2H13v-1.5a2 2 0 1 0-4 0V20.5H5.5a2 2 0 0 1-2-2V15H2a2 2 0 0 1 0-4h1.5V7.5a2 2 0 0 1 2-2H9V4a2 2 0 1 1 4 0v1.5h2.5c.4 0 .7.4.5.9-.3.5-.5 1-.5 1.6a2 2 0 0 0 0 0z"/>',
  package: '<path d="M21 8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7z"/><polyline points="3.3 6.7 12 12 20.7 6.7"/><line x1="12" y1="22" x2="12" y2="12"/>',
  note: '<path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><polyline points="15 3 15 8 20 8"/><line x1="7" y1="12" x2="15" y2="12"/><line x1="7" y1="16" x2="12" y2="16"/>',
  paperclip: '<path d="M20 12.5 11.5 21a4.5 4.5 0 0 1-6.4-6.4l9-9a3 3 0 0 1 4.3 4.3l-8.6 8.6a1.5 1.5 0 0 1-2.1-2.1l7.9-7.9"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><polyline points="8.5 12.2 11 14.7 15.5 9.5"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  pencil: '<path d="M17 3a2.1 2.1 0 0 1 3 3L7.5 18.5 2 20l1.5-5.5z"/>',
  alertTriangle: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  hash: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.5 3.9A2 2 0 0 0 7.8 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  lightbulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a6 6 0 0 0-4 10.5c.7.6 1 1.2 1 2.5h6c0-1.3.3-1.9 1-2.5A6 6 0 0 0 12 2z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  sparkles: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>',
  construction: '<rect x="2" y="6" width="20" height="8" rx="1"/><path d="M17 14v7"/><path d="M7 14v7"/><path d="M17 3l-5 3-5-3"/><path d="M8 6h8"/>',
  arrowRight: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  arrowLeft: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  bot: '<rect x="3" y="9" width="18" height="11" rx="2"/><circle cx="8.5" cy="14.5" r="1.2"/><circle cx="15.5" cy="14.5" r="1.2"/><path d="M12 9V5"/><circle cx="12" cy="3.5" r="1.5"/><line x1="3" y1="13" x2="1" y2="13"/><line x1="23" y1="13" x2="21" y2="13"/>',
  inbox: '<polyline points="3 12 8 12 10 15 14 15 16 12 21 12"/><path d="M5.5 5h13l2.5 7v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7z"/>',
  upload: '<path d="M12 16V4"/><polyline points="6 10 12 4 18 10"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  chevronDown: '<polyline points="6 9 12 15 18 9"/>',
  chevronUp: '<polyline points="18 15 12 9 6 15"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  helpCircle: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.3a2.5 2.5 0 0 1 4.8 1c0 1.5-2.3 2-2.3 3.4"/><line x1="12" y1="17.2" x2="12.01" y2="17.2"/>',
  mousePointer: '<path d="M4 3l7.1 16.5 2-6.5 6.5-2z"/>',
  edit: '<path d="M11 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6"/><path d="M17 3a2.1 2.1 0 0 1 3 3L9.5 16.5 5 18l1.5-4.5z"/>',
  cart: '<circle cx="9" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.5 2.5h2l2.7 12.6a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.6L21 7H6"/>',
  info: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="10.5" x2="12" y2="16.5"/><line x1="12" y1="7.2" x2="12.01" y2="7.2"/>',
  lock: '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  dollarSign: '<line x1="12" y1="2" x2="12" y2="22"/><path d="M17 7a4 4 0 0 0-4-3h-2a3.5 3.5 0 0 0 0 7h2a3.5 3.5 0 0 1 0 7h-2a4 4 0 0 1-4-3"/>',
  store: '<path d="M3 9l1-5h16l1 5"/><path d="M3 9a2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0"/><path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M9 21v-6h6v6"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  download: '<path d="M12 3v12"/><polyline points="7 11 12 16 17 11"/><path d="M5 19h14"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  barChart: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="9"/><line x1="12" y1="5" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="17" y1="16" x2="23" y2="16"/>',
};

/**
 * Returns an inline <svg>...</svg> string for the named icon.
 * size: pixel width/height. className: extra CSS class(es).
 */
export function icon(name, { size = 16, className = '' } = {}) {
  const inner = PATHS[name];
  if (!inner) return '';
  return `<svg class="icon${className ? ' ' + className : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
}

/**
 * Injects icons into static (non-JS-rendered) markup via data attributes,
 * so HTML files can declare icons without duplicating SVG source:
 * data-icon="name"        → prefixed before existing content
 * data-icon-suffix="name" → appended after existing content
 * data-icon-only="name"   → replaces all content
 * data-icon-size="N"      → optional size override (default 16/15/20)
 */
export function applyStaticIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    const size = parseInt(el.dataset.iconSize) || 16;
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, { size }) + ' ');
  });
  root.querySelectorAll('[data-icon-suffix]').forEach(el => {
    const size = parseInt(el.dataset.iconSize) || 15;
    el.insertAdjacentHTML('beforeend', ' ' + icon(el.dataset.iconSuffix, { size }));
  });
  root.querySelectorAll('[data-icon-only]').forEach(el => {
    const size = parseInt(el.dataset.iconSize) || 20;
    el.innerHTML = icon(el.dataset.iconOnly, { size });
  });
}

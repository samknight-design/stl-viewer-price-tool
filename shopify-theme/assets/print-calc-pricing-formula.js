// ============================================================
// pricing-formula.js — every number the calculator charges
//
// The pricing settings the owner edits in the pricing admin page
// (pricing-admin.html) and saves under `formula` in the shop's pricing config.
// Anything missing falls back to FORMULA_DEFAULTS, which reproduce the prices
// the owner approved in the pricing trainer (fit 1, 3 Nov 2026).
//
//   Resin part: starting charge
//             + volume price × (mL ÷ reference mL) ^ volume curve
//             + size price   × (longest mm ÷ reference mm) ^ size curve
//   FDM part:   starting charge
//             + filament price × (grams ÷ reference g) ^ filament curve
//   then × overall adjustment × material modifier, raised to the minimum and
//   rounded UP to the rounding step.
//
// Each term is "what a reference part pays", so the curve pivots around that
// part: bending a curve changes big and small parts in opposite directions
// without moving the typical part. Curve 0.5 means doubling the size adds
// about 41%; 1 means price grows in proportion.
//
// An unsupported resin upload is priced as if it already had supports. FDM
// filament = a shell as thick as the walls over the whole surface + infill %
// of the inside, times the filament's density.
//
// Discounts (inside a model's price, before assembly and primer):
//   - every copy of a part after the first gets the quantity discount;
//   - a model with enough parts gets the multi-part discount for its tier,
//     capped per model;
//   - parts under the discount minimum size get neither, and don't count.
// Labour (handling per part, plus a small-part fee under a size) goes on
// after every discount, per copy, and is never discounted.
//
// The relay prices every order again with
// supabase/functions/shopify-relay/formula.ts, a line-for-line port.
// formula.test.ts asserts both give the same penny — a change here is a
// change there.
// ============================================================

export const FORMULA_VERSION = 2;

export const FORMULA_DEFAULTS = Object.freeze({
  version: 2,
  order: { roundTo: 0.5, minimumOrderTotal: 5, customQuoteThreshold: 150 },
  resin: {
    enabled: true,
    label: 'Resin',
    description: 'Finest detail, best for miniatures.',
    adjustPct: 0,
    startingCharge: -1.69,
    volume: { price: 7.43, refMl: 25, curve: 0.5 },
    size: { price: 6.9, refMm: 100, curve: 1 },
    minPrice: 3,
    supports: { extraVolumePct: 22.5, extraVolumeMl: 2.5, extraSizePct: 8, handlingFee: 0 },
    materials: [{ id: 'abs-like', name: 'ABS-like resin', modifierPct: 0 }],
    labour: { perPart: 0, smallPartFee: 0, smallPartMaxMl: 2 },
    buildPlate: { x: 211.68, y: 118.37, z: 220, marginPct: 20 },
  },
  fdm: {
    enabled: true,
    label: 'PLA',
    description: 'Tougher and cheaper on bigger parts. You pick a colour per part.',
    adjustPct: 0,
    startingCharge: 0,
    filament: { price: 12.16, refG: 100, curve: 0.5 },
    minPrice: 3,
    shellMm: 0.8,
    infillPct: 8,
    materials: [{ id: 'matte-pla', name: 'Matte PLA', modifierPct: 0, gPerMl: 1.24, finish: 'matte' }],
    labour: { perPart: 0, smallPartFee: 0, smallPartMaxMl: 5 },
    colours: [
      { id: 'white', name: 'White', hex: '#f2f2ee', surchargePct: 0, finish: 'solid' },
      { id: 'black', name: 'Black', hex: '#1c1c1c', surchargePct: 0, finish: 'solid' },
      { id: 'dark-grey', name: 'Dark Grey', hex: '#4d4d4d', surchargePct: 0, finish: 'solid' },
      { id: 'red', name: 'Red', hex: '#c0392b', surchargePct: 10, finish: 'solid' },
      { id: 'orange', name: 'Orange', hex: '#e2711d', surchargePct: 10, finish: 'solid' },
      { id: 'yellow', name: 'Yellow', hex: '#f0c414', surchargePct: 10, finish: 'solid' },
      { id: 'green', name: 'Green', hex: '#1f8a3d', surchargePct: 10, finish: 'solid' },
      { id: 'blue', name: 'Blue', hex: '#1a5fb4', surchargePct: 10, finish: 'solid' },
      { id: 'purple', name: 'Purple', hex: '#7d3c98', surchargePct: 10, finish: 'solid' },
      { id: 'pink', name: 'Pink', hex: '#e88ab0', surchargePct: 10, finish: 'solid' },
      { id: 'brown', name: 'Brown', hex: '#6d4c33', surchargePct: 10, finish: 'solid' },
      { id: 'gold', name: 'Gold', hex: '#cfa036', surchargePct: 20, finish: 'metallic' },
      { id: 'silver', name: 'Silver', hex: '#b8bcc0', surchargePct: 20, finish: 'metallic' },
      { id: 'copper', name: 'Copper', hex: '#b3673f', surchargePct: 20, finish: 'metallic' },
      { id: 'pearl-white', name: 'Pearl White', hex: '#efe8df', surchargePct: 20, finish: 'pearl' },
      { id: 'pearl-blue', name: 'Pearl Blue', hex: '#a9c3d6', surchargePct: 20, finish: 'pearl' },
    ],
    buildPlate: { x: 256, y: 256, z: 256, marginPct: 15 },
  },
  discounts: {
    quantityPct: 0,
    multiPart: [],          // [{ minParts: 3, pct: 5 }, …], best matching tier wins
    minPartMl: 0,           // parts smaller than this get no discounts and don't count towards tiers
    maxMultiPartDiscount: 0, // the most a multi-part discount can take off one model (0 = no cap)
  },
  finishes: {
    assemblyFirst: 5,
    assemblyPerJoint: 3.5,
    assemblyMax: 40,
    primer: {
      tiers: [
        { maxMl: 3, price: 0.5 }, { maxMl: 7, price: 1 }, { maxMl: 15, price: 2 },
        { maxMl: 30, price: 3.5 }, { maxMl: 50, price: 5.5 }, { maxMl: 80, price: 8 },
        { maxMl: 120, price: 11 }, { maxMl: 180, price: 14.5 }, { maxMl: 260, price: 18 },
      ],
      maxPrice: 20,
      colours: [
        { id: 'black', label: 'Black Primer', hex: '#1a1a1a' },
        { id: 'grey', label: 'Grey Primer', hex: '#9a9a9a' },
        { id: 'white', label: 'White Primer', hex: '#f6f3ec' },
      ],
    },
  },
});

const DEFAULT_G_PER_ML = 1.24;

const clone = (o) => JSON.parse(JSON.stringify(o));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Settings saved by the pricing trainer's first version (perSqrtMl …),
 *  mapped onto version 2 so they price identically. */
function migrateV1(saved) {
  if (!isObj(saved) || saved.version !== 1) return saved;
  const out = clone(saved);
  out.version = 2;
  out.order = { roundTo: saved.roundTo };
  if (isObj(saved.resin)) {
    out.resin.volume = { price: saved.resin.perSqrtMl * 5, refMl: 25, curve: 0.5 };
    out.resin.size = { price: saved.resin.perLongestMm * 100, refMm: 100, curve: 1 };
  }
  if (isObj(saved.fdm)) out.fdm.filament = { price: saved.fdm.perSqrtGram * 10, refG: 100, curve: 0.5 };
  if (isObj(saved.finishes)) {
    out.finishes = { ...saved.finishes };
    delete out.finishes.primerAdjustPct;
  }
  return out;
}

/**
 * Saved settings over the defaults, key by key, so settings saved by an older
 * or newer admin page still produce a complete, valid formula. A list that is
 * saved replaces the default list (an empty multi-part list is valid; an
 * empty material or colour list is not, and falls back).
 */
export function mergeFormula(saved, defaults = FORMULA_DEFAULTS) {
  return mergeNode(migrateV1(saved), defaults, '');
}

const MAY_BE_EMPTY = new Set(['discounts.multiPart']);

function mergeNode(saved, defaults, path) {
  if (Array.isArray(defaults)) {
    if (!Array.isArray(saved)) return clone(defaults);
    if (!saved.length && !MAY_BE_EMPTY.has(path)) return clone(defaults);
    return clone(saved);
  }
  const out = {};
  for (const [k, v] of Object.entries(defaults)) {
    const s = isObj(saved) ? saved[k] : undefined;
    const p = path ? `${path}.${k}` : k;
    out[k] = v !== null && typeof v === 'object'
      ? mergeNode(s, v, p)
      : (typeof s === typeof v && (typeof v !== 'number' || Number.isFinite(s)) ? s : v);
  }
  return out;
}

/** The material a part uses: the one named, else the method's first. */
export function findMaterial(method, materialId) {
  return method.materials.find((m) => m.id === materialId) ?? method.materials[0];
}

/** Estimated FDM filament in grams, or null without a surface area. */
export function filamentGrams(volumeMl, areaMm2, formula, material) {
  if (!Number.isFinite(areaMm2) || !Number.isFinite(volumeMl)) return null;
  const shellMl = areaMm2 * formula.fdm.shellMm / 1000;
  const ml = shellMl >= volumeMl ? volumeMl : shellMl + (volumeMl - shellMl) * formula.fdm.infillPct / 100;
  const density = Number.isFinite(material?.gPerMl) && material.gPerMl > 0 ? material.gPerMl : DEFAULT_G_PER_ML;
  return ml * density;
}

/** One term of the formula: price × (amount ÷ reference) ^ curve. */
function curveTerm(t, amount, ref) {
  if (!(amount > 0) || !(ref > 0)) return 0;
  return t.price * Math.pow(amount / ref, t.curve);
}

/** Round UP to the step, after rounding to pennies so float noise
 *  (3.0000000001) can't push an exact step up to the next one. */
export function roundUpTo(value, step) {
  const s = step > 0 ? step : 0.01;
  return Math.round(Math.ceil(Math.round(value * 100) / 100 / s - 1e-9) * s * 100) / 100;
}

/**
 * The price of one part (already scaled). Returns null when it cannot be
 * priced — an FDM part with no surface area.
 *   { volumeMl, dimensions, areaMm2, presupported, method: 'resin'|'pla', materialId }
 */
export function formulaPartPrice(part, formula) {
  const { volumeMl, dimensions, areaMm2, presupported = false, method = 'resin', materialId } = part;
  const isPla = method === 'pla';
  const m = isPla ? formula.fdm : formula.resin;
  const material = findMaterial(m, materialId);
  let raw;
  let grams = null;
  let pricedVolumeMl = volumeMl;
  let pricedLongestMm = Math.max(dimensions.x, dimensions.y, dimensions.z);
  if (isPla) {
    grams = filamentGrams(volumeMl, areaMm2, formula, material);
    if (grams === null) return null;
    raw = formula.fdm.startingCharge + curveTerm(formula.fdm.filament, grams, formula.fdm.filament.refG);
  } else {
    const r = formula.resin;
    const s = r.supports;
    if (!presupported) {
      pricedVolumeMl = volumeMl * (1 + s.extraVolumePct / 100) + s.extraVolumeMl;
      pricedLongestMm *= 1 + s.extraSizePct / 100;
    }
    raw = r.startingCharge
      + curveTerm(r.volume, pricedVolumeMl, r.volume.refMl)
      + curveTerm(r.size, pricedLongestMm, r.size.refMm)
      + (presupported ? 0 : s.handlingFee);
  }
  const adjusted = raw * (1 + m.adjustPct / 100) * (1 + (material?.modifierPct ?? 0) / 100);
  if (!Number.isFinite(adjusted)) return null;
  const price = roundUpTo(Math.max(adjusted, m.minPrice), formula.order.roundTo);
  return {
    price,
    raw,
    minApplied: adjusted < m.minPrice,
    materialId: material?.id,
    materialName: material?.name ?? (isPla ? 'PLA' : 'Resin'),
    modifierPct: material?.modifierPct ?? 0,
    grams,
    pricedVolumeMl,
    pricedLongestMm,
  };
}

/** A part's line total for `quantity` copies: the first at full price, the
 *  rest with the quantity discount (none for a part too small to discount).
 *  Rounded to pennies. Labour is added separately and never discounted. */
export function quantityLineTotal(unitPrice, quantity, formula, eligible = true) {
  const q = Math.max(1, Math.floor(quantity) || 1);
  const pct = eligible ? formula.discounts.quantityPct : 0;
  const extra = (q - 1) * unitPrice * (1 - pct / 100);
  return Math.round((unitPrice + extra) * 100) / 100;
}

/**
 * Handling labour for one copy of a part: the per-part fee, plus the
 * small-part fee when the part is under the small-part size. Tiny resin parts
 * take as long to clean, cure, check and bag as big ones, so this keeps a
 * basket of a hundred tiny parts from being priced like a few grams of resin.
 * Added after every discount — labour is never discounted.
 */
export function labourFee(volumeMl, method, formula) {
  const l = (method === 'pla' ? formula.fdm : formula.resin).labour;
  return l.perPart + (volumeMl < l.smallPartMaxMl ? l.smallPartFee : 0);
}

/** Parts below the discount minimum size get no discounts and don't count
 *  towards the multi-part tiers. */
export function discountEligible(volumeMl, formula) {
  return volumeMl >= formula.discounts.minPartMl;
}

/** A model's multi-part discount: the best tier for its eligible part count,
 *  as a % of its eligible parts' (non-labour) total, capped per model. */
export function multiPartDiscount(eligibleParts, discountableSubtotal, formula) {
  const pct = multiPartDiscountPct(eligibleParts, formula);
  let amount = Math.round(discountableSubtotal * pct) / 100;
  const cap = formula.discounts.maxMultiPartDiscount;
  if (cap > 0 && amount > cap) amount = cap;
  return { pct, amount };
}

/** Display only (not ported to the relay): a CSS background for a colour
 *  swatch with its finish, used by the calculator and the admin page. */
export const FINISHES = Object.freeze({
  solid: 'Solid', matte: 'Matte', silk: 'Silk', metallic: 'Metallic',
  pearl: 'Pearlescent', translucent: 'Translucent', glow: 'Glow in the dark',
});
export function swatchBackground(hex, finish) {
  const c = /^#[0-9a-f]{6}$/i.test(hex || '') ? hex : '#888888';
  switch (finish) {
    case 'silk':
      return `linear-gradient(135deg, ${c} 0%, rgba(255,255,255,.55) 45%, ${c} 60%, rgba(0,0,0,.18) 100%), ${c}`;
    case 'metallic':
      return `linear-gradient(135deg, rgba(0,0,0,.35) 0%, rgba(255,255,255,.75) 40%, rgba(255,255,255,.1) 55%, rgba(0,0,0,.3) 100%), ${c}`;
    case 'pearl':
      return `linear-gradient(135deg, rgba(255,190,225,.55) 0%, rgba(190,225,255,.55) 35%, rgba(255,250,215,.55) 65%, rgba(210,190,255,.55) 100%), ${c}`;
    case 'translucent':
      return `linear-gradient(${c}99, ${c}99), repeating-conic-gradient(#ffffff 0 25%, #d9d9d9 0 50%) 0 0 / 10px 10px`;
    case 'glow':
      return `radial-gradient(circle at 50% 50%, rgba(255,255,255,.65) 0%, ${c} 55%, ${c} 100%)`;
    case 'matte':
      return `linear-gradient(rgba(255,255,255,.06), rgba(0,0,0,.06)), ${c}`;
    default:
      return c;
  }
}

/** The multi-part discount % for a model with this many parts (best tier). */
export function multiPartDiscountPct(partCount, formula) {
  let pct = 0;
  for (const t of formula.discounts.multiPart) {
    if (partCount >= t.minParts && t.pct > pct) pct = t.pct;
  }
  return pct;
}

/**
 * Fold the formula into a pricing config so the rest of the engine and the
 * calculator UI read it without special cases: materials, colours, primer,
 * assembly, printer sizes and order rules all come from the formula.
 */
export function applyFormula(config, savedFormula) {
  const formula = mergeFormula(savedFormula);
  const f = formula.finishes;
  const plate = (b) => ({ x: b.x, y: b.y, z: b.z, supportMarginPct: b.marginPct });
  return {
    ...config,
    formula,
    materials: formula.resin.materials.map(({ id, name, modifierPct }) => ({ id, name, modifierPct })),
    fdmMaterials: formula.fdm.materials.map(({ id, name, modifierPct, finish }) => ({ id, name, modifierPct, finish })),
    printMethods: {
      resin: { enabled: formula.resin.enabled, label: formula.resin.label, description: formula.resin.description },
      pla: { enabled: formula.fdm.enabled, label: formula.fdm.label, description: formula.fdm.description },
    },
    // Each colour is its own surcharge "tier", so the existing colour code
    // reads per-colour surcharges unchanged.
    plaColors: formula.fdm.colours.map(({ id, name, hex, finish }) => ({ id, name, hex, finish, tier: id })),
    plaColorSurchargePct: Object.fromEntries(formula.fdm.colours.map((c) => [c.id, c.surchargePct])),
    primerOptions: [{ id: 'unprimed', label: 'Unprimed' }, ...f.primer.colours.filter((c) => c.id !== 'unprimed')],
    primerTiers: f.primer.tiers.map((t) => ({ maxVolumeMl: t.maxMl, price: t.price })),
    primerMinPrice: 0,
    primerMaxPrice: f.primer.maxPrice,
    assemblyBase: f.assemblyFirst,
    assemblyPerJoint: f.assemblyPerJoint,
    assemblyMax: f.assemblyMax,
    buildPlate: plate(formula.resin.buildPlate),
    fdmBuildPlate: plate(formula.fdm.buildPlate),
    minimumOrderTotal: formula.order.minimumOrderTotal,
    customQuoteOrderThreshold: formula.order.customQuoteThreshold,
  };
}

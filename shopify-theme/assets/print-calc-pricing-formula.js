// ============================================================
// pricing-formula.js — the size-and-volume pricing formula
//
// Replaces the resin size tiers and the PLA per-mL rate. It was fitted to the
// owner's own hand-priced DM Stash parts in the pricing trainer
// (trainer/pricing-trainer.html), and every number in it is one of that
// trainer's Pricing settings. FORMULA_DEFAULTS below is the trainer's
// PRICING_DEFAULTS minus the release-only settings: keep the two in step.
//
//   Resin part: starting charge + volume weight × √mL + size weight × longest mm
//   FDM part:   filament weight × √(estimated filament g)
//   then × overall adjustment × material modifier, raised to the minimum and
//   rounded UP to the rounding step.
//
// An unsupported resin upload is priced as if it already had supports:
// volume + extraVolumePct% + extraVolumeMl, sides + extraSizePct%, plus any
// support handling fee. FDM filament = a shell as thick as the walls over the
// whole surface + infillPct% of the inside, calibrated to the shop's Bambu
// profile (2 walls, 8% gyroid; within 5% of real slices).
//
// The relay prices every order again on the server with
// supabase/functions/shopify-relay/formula.ts, a line-for-line port of this
// file. formula.test.ts imports this file and asserts both give the same
// penny, so a change here is a change there.
//
// The settings live in the shop's pricing config under `formula`; anything
// missing falls back to these defaults (mergeFormula).
// ============================================================

export const FORMULA_DEFAULTS = Object.freeze({
  version: 1,
  roundTo: 0.5,
  resin: {
    adjustPct: 0, startingCharge: -1.69, perSqrtMl: 1.486, perLongestMm: 0.069, minPrice: 3,
    supports: { extraVolumePct: 22.5, extraVolumeMl: 2.5, extraSizePct: 8, handlingFee: 0 },
    materials: [{ id: 'abs-like', name: 'ABS-like resin', modifierPct: 0 }],
  },
  fdm: {
    adjustPct: 0, perSqrtGram: 1.216, minPrice: 3, shellMm: 0.8, infillPct: 8,
    materials: [{ id: 'matte-pla', name: 'Matte PLA', modifierPct: 0 }],
  },
  finishes: { assemblyFirst: 5, assemblyPerJoint: 3.5, assemblyMax: 40, primerAdjustPct: 0 },
});

const PLA_G_PER_ML = 1.24;

const clone = (o) => JSON.parse(JSON.stringify(o));

/** Saved settings over the defaults, key by key, so settings saved by an older
 *  or newer trainer still produce a complete, valid formula. */
export function mergeFormula(saved, defaults = FORMULA_DEFAULTS) {
  if (Array.isArray(defaults)) return Array.isArray(saved) && saved.length ? clone(saved) : clone(defaults);
  const out = {};
  for (const [k, v] of Object.entries(defaults)) {
    out[k] = v && typeof v === 'object'
      ? mergeFormula(saved && typeof saved === 'object' ? saved[k] : undefined, v)
      : (typeof saved?.[k] === typeof v && (typeof v !== 'number' || Number.isFinite(saved[k])) ? saved[k] : v);
  }
  return out;
}

/** Estimated PLA filament in grams, or null without a surface area. */
export function filamentGrams(volumeMl, areaMm2, formula) {
  if (!Number.isFinite(areaMm2) || !Number.isFinite(volumeMl)) return null;
  const shellMl = areaMm2 * formula.fdm.shellMm / 1000;
  const ml = shellMl >= volumeMl ? volumeMl : shellMl + (volumeMl - shellMl) * formula.fdm.infillPct / 100;
  return ml * PLA_G_PER_ML;
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
  let raw;
  let grams = null;
  let pricedVolumeMl = volumeMl;
  let pricedLongestMm = Math.max(dimensions.x, dimensions.y, dimensions.z);
  if (isPla) {
    grams = filamentGrams(volumeMl, areaMm2, formula);
    if (grams === null) return null;
    raw = m.perSqrtGram * Math.sqrt(grams);
  } else {
    const s = m.supports;
    if (!presupported) {
      pricedVolumeMl = volumeMl * (1 + s.extraVolumePct / 100) + s.extraVolumeMl;
      pricedLongestMm *= 1 + s.extraSizePct / 100;
    }
    raw = m.startingCharge + m.perSqrtMl * Math.sqrt(pricedVolumeMl) + m.perLongestMm * pricedLongestMm
      + (presupported ? 0 : s.handlingFee);
  }
  const material = m.materials.find((x) => x.id === materialId) ?? m.materials[0];
  const adjusted = raw * (1 + m.adjustPct / 100) * (1 + (material?.modifierPct ?? 0) / 100);
  if (!Number.isFinite(adjusted)) return null;
  const floored = Math.max(adjusted, m.minPrice);
  const step = formula.roundTo > 0 ? formula.roundTo : 0.01;
  // Round the floored figure to pennies first so float noise (3.0000000001)
  // can't push an exact step up to the next one.
  const price = Math.round(Math.ceil(Math.round(floored * 100) / 100 / step - 1e-9) * step * 100) / 100;
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

/**
 * Fold the formula into a pricing config so the rest of the engine reads it
 * without special cases: resin materials come from the formula, assembly from
 * its finishes, and the primer ladder is scaled by primerAdjustPct (rounded up
 * to 50p, like every other price).
 */
export function applyFormula(config, savedFormula) {
  const formula = mergeFormula(savedFormula);
  const f = formula.finishes;
  const scale = 1 + f.primerAdjustPct / 100;
  const up50 = (v) => Math.ceil(v * scale * 2) / 2;
  return {
    ...config,
    formula,
    materials: formula.resin.materials.map(({ id, name }) => ({ id, name })),
    assemblyBase: f.assemblyFirst,
    assemblyPerJoint: f.assemblyPerJoint,
    assemblyMax: f.assemblyMax,
    primerTiers: (config.primerTiers ?? []).map((t) => ({ ...t, price: up50(t.price) })),
    primerMinPrice: up50(config.primerMinPrice ?? 0),
    primerMaxPrice: up50(config.primerMaxPrice ?? 0),
  };
}

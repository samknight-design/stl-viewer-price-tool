// supabase/functions/shopify-relay/formula.ts
//
// Server-side port of js/pricing-formula.js — the size-and-volume pricing
// formula. Same rule as pricing.ts: this file and the browser's MUST stay in
// lockstep, or the relay re-prices honest orders differently from the
// customer's screen. formula.test.ts imports the browser file and asserts the
// two agree to the penny across a grid of parts and settings.
//
// The port is literal on purpose: same names, same order of operations, same
// rounding.

import type { Dimensions } from "./pricing.ts";

export interface FormulaMaterial {
  id: string;
  name: string;
  modifierPct: number;
}

export interface Formula {
  version: number;
  roundTo: number;
  resin: {
    adjustPct: number;
    startingCharge: number;
    perSqrtMl: number;
    perLongestMm: number;
    minPrice: number;
    supports: { extraVolumePct: number; extraVolumeMl: number; extraSizePct: number; handlingFee: number };
    materials: FormulaMaterial[];
  };
  fdm: {
    adjustPct: number;
    perSqrtGram: number;
    minPrice: number;
    shellMm: number;
    infillPct: number;
    materials: FormulaMaterial[];
  };
  finishes: { assemblyFirst: number; assemblyPerJoint: number; assemblyMax: number; primerAdjustPct: number };
}

export const FORMULA_DEFAULTS: Formula = Object.freeze({
  version: 1,
  roundTo: 0.5,
  resin: {
    adjustPct: 0, startingCharge: -1.69, perSqrtMl: 1.486, perLongestMm: 0.069, minPrice: 3,
    supports: { extraVolumePct: 22.5, extraVolumeMl: 2.5, extraSizePct: 8, handlingFee: 0 },
    materials: [{ id: "abs-like", name: "ABS-like resin", modifierPct: 0 }],
  },
  fdm: {
    adjustPct: 0, perSqrtGram: 1.216, minPrice: 3, shellMm: 0.8, infillPct: 8,
    materials: [{ id: "matte-pla", name: "Matte PLA", modifierPct: 0 }],
  },
  finishes: { assemblyFirst: 5, assemblyPerJoint: 3.5, assemblyMax: 40, primerAdjustPct: 0 },
}) as Formula;

const PLA_G_PER_ML = 1.24;

const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));

/** Saved settings over the defaults, key by key. Mirrors mergeFormula in js. */
// deno-lint-ignore no-explicit-any
export function mergeFormula(saved: any, defaults: any = FORMULA_DEFAULTS): any {
  if (Array.isArray(defaults)) return Array.isArray(saved) && saved.length ? clone(saved) : clone(defaults);
  // deno-lint-ignore no-explicit-any
  const out: any = {};
  for (const [k, v] of Object.entries(defaults)) {
    out[k] = v && typeof v === "object"
      ? mergeFormula(saved && typeof saved === "object" ? saved[k] : undefined, v)
      : (typeof saved?.[k] === typeof v && (typeof v !== "number" || Number.isFinite(saved[k])) ? saved[k] : v);
  }
  return out;
}

export function filamentGrams(volumeMl: number, areaMm2: number | undefined | null, formula: Formula): number | null {
  if (!Number.isFinite(areaMm2) || !Number.isFinite(volumeMl)) return null;
  const shellMl = (areaMm2 as number) * formula.fdm.shellMm / 1000;
  const ml = shellMl >= volumeMl ? volumeMl : shellMl + (volumeMl - shellMl) * formula.fdm.infillPct / 100;
  return ml * PLA_G_PER_ML;
}

export interface FormulaPart {
  volumeMl: number;
  dimensions: Dimensions;
  areaMm2?: number | null;
  presupported?: boolean;
  method?: string;
  materialId?: string;
}

export interface FormulaPrice {
  price: number;
  raw: number;
  minApplied: boolean;
  materialId?: string;
  materialName: string;
  modifierPct: number;
  grams: number | null;
  pricedVolumeMl: number;
  pricedLongestMm: number;
}

export function formulaPartPrice(part: FormulaPart, formula: Formula): FormulaPrice | null {
  const { volumeMl, dimensions, areaMm2, presupported = false, method = "resin", materialId } = part;
  const isPla = method === "pla";
  const m = isPla ? formula.fdm : formula.resin;
  let raw: number;
  let grams: number | null = null;
  let pricedVolumeMl = volumeMl;
  let pricedLongestMm = Math.max(dimensions.x, dimensions.y, dimensions.z);
  if (isPla) {
    grams = filamentGrams(volumeMl, areaMm2, formula);
    if (grams === null) return null;
    raw = formula.fdm.perSqrtGram * Math.sqrt(grams);
  } else {
    const s = formula.resin.supports;
    if (!presupported) {
      pricedVolumeMl = volumeMl * (1 + s.extraVolumePct / 100) + s.extraVolumeMl;
      pricedLongestMm *= 1 + s.extraSizePct / 100;
    }
    raw = formula.resin.startingCharge + formula.resin.perSqrtMl * Math.sqrt(pricedVolumeMl) +
      formula.resin.perLongestMm * pricedLongestMm + (presupported ? 0 : s.handlingFee);
  }
  const material = m.materials.find((x) => x.id === materialId) ?? m.materials[0];
  const adjusted = raw * (1 + m.adjustPct / 100) * (1 + (material?.modifierPct ?? 0) / 100);
  if (!Number.isFinite(adjusted)) return null;
  const floored = Math.max(adjusted, m.minPrice);
  const step = formula.roundTo > 0 ? formula.roundTo : 0.01;
  const price = Math.round(Math.ceil(Math.round(floored * 100) / 100 / step - 1e-9) * step * 100) / 100;
  return {
    price,
    raw,
    minApplied: adjusted < m.minPrice,
    materialId: material?.id,
    materialName: material?.name ?? (isPla ? "PLA" : "Resin"),
    modifierPct: material?.modifierPct ?? 0,
    grams,
    pricedVolumeMl,
    pricedLongestMm,
  };
}

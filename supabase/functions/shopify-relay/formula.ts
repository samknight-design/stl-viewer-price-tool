// supabase/functions/shopify-relay/formula.ts
//
// Server-side port of js/pricing-formula.js — every number the calculator
// charges, as the owner sets it in the pricing admin page. Same rule as
// pricing.ts: this file and the browser's MUST stay in lockstep, or the relay
// re-prices honest orders differently from the customer's screen.
// formula.test.ts imports the browser file and asserts the two agree to the
// penny across a grid of parts, settings and discounts.
//
// The port is literal on purpose: same names, same order of operations, same
// rounding. Loosely typed where the browser is, because saved settings arrive
// from a shop metafield that may predate or postdate this code.

import type { Dimensions } from "./pricing.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export interface FormulaMaterial {
  id: string;
  name: string;
  modifierPct: number;
  gPerMl?: number;
  finish?: string;
}

export interface CurveTerm {
  price: number;
  curve: number;
  refMl?: number;
  refMm?: number;
  refG?: number;
}

export interface Labour {
  perPart: number;
  smallPartFee: number;
  smallPartMaxMl: number;
}

export interface BuildPlateSetting {
  x: number;
  y: number;
  z: number;
  marginPct: number;
}

export interface Formula {
  version: number;
  order: { roundTo: number; minimumOrderTotal: number; customQuoteThreshold: number };
  resin: {
    enabled: boolean;
    label: string;
    description: string;
    adjustPct: number;
    startingCharge: number;
    volume: CurveTerm & { refMl: number };
    size: CurveTerm & { refMm: number };
    minPrice: number;
    supports: { extraVolumePct: number; extraVolumeMl: number; extraSizePct: number; handlingFee: number };
    materials: FormulaMaterial[];
    labour: Labour;
    buildPlate: BuildPlateSetting;
  };
  fdm: {
    enabled: boolean;
    label: string;
    description: string;
    adjustPct: number;
    startingCharge: number;
    filament: CurveTerm & { refG: number };
    minPrice: number;
    shellMm: number;
    infillPct: number;
    materials: FormulaMaterial[];
    labour: Labour;
    colours: Array<{ id: string; name: string; hex: string; surchargePct: number; finish?: string }>;
    buildPlate: BuildPlateSetting;
  };
  discounts: {
    quantityPct: number;
    multiPart: Array<{ minParts: number; pct: number }>;
    minPartMl: number;
    maxMultiPartDiscount: number;
  };
  finishes: {
    assemblyFirst: number;
    assemblyPerJoint: number;
    assemblyMax: number;
    primer: {
      tiers: Array<{ maxMl: number; price: number }>;
      maxPrice: number;
      colours: Array<{ id: string; label: string; hex?: string }>;
    };
  };
}

export const FORMULA_VERSION = 2;

export const FORMULA_DEFAULTS: Formula = Object.freeze({
  version: 2,
  order: { roundTo: 0.5, minimumOrderTotal: 5, customQuoteThreshold: 150 },
  resin: {
    enabled: true,
    label: "Resin",
    description: "Finest detail, best for miniatures.",
    adjustPct: 0,
    startingCharge: -1.69,
    volume: { price: 7.43, refMl: 25, curve: 0.5 },
    size: { price: 6.9, refMm: 100, curve: 1 },
    minPrice: 3,
    supports: { extraVolumePct: 22.5, extraVolumeMl: 2.5, extraSizePct: 8, handlingFee: 0 },
    materials: [{ id: "abs-like", name: "ABS-like resin", modifierPct: 0 }],
    labour: { perPart: 0, smallPartFee: 0, smallPartMaxMl: 2 },
    buildPlate: { x: 211.68, y: 118.37, z: 220, marginPct: 20 },
  },
  fdm: {
    enabled: true,
    label: "PLA",
    description: "Tougher and cheaper on bigger parts. You pick a colour per part.",
    adjustPct: 0,
    startingCharge: 0,
    filament: { price: 12.16, refG: 100, curve: 0.5 },
    minPrice: 3,
    shellMm: 0.8,
    infillPct: 8,
    materials: [{ id: "matte-pla", name: "Matte PLA", modifierPct: 0, gPerMl: 1.24, finish: "matte" }],
    labour: { perPart: 0, smallPartFee: 0, smallPartMaxMl: 5 },
    colours: [
      { id: "white", name: "White", hex: "#f2f2ee", surchargePct: 0, finish: "solid" },
      { id: "black", name: "Black", hex: "#1c1c1c", surchargePct: 0, finish: "solid" },
      { id: "dark-grey", name: "Dark Grey", hex: "#4d4d4d", surchargePct: 0, finish: "solid" },
      { id: "red", name: "Red", hex: "#c0392b", surchargePct: 10, finish: "solid" },
      { id: "orange", name: "Orange", hex: "#e2711d", surchargePct: 10, finish: "solid" },
      { id: "yellow", name: "Yellow", hex: "#f0c414", surchargePct: 10, finish: "solid" },
      { id: "green", name: "Green", hex: "#1f8a3d", surchargePct: 10, finish: "solid" },
      { id: "blue", name: "Blue", hex: "#1a5fb4", surchargePct: 10, finish: "solid" },
      { id: "purple", name: "Purple", hex: "#7d3c98", surchargePct: 10, finish: "solid" },
      { id: "pink", name: "Pink", hex: "#e88ab0", surchargePct: 10, finish: "solid" },
      { id: "brown", name: "Brown", hex: "#6d4c33", surchargePct: 10, finish: "solid" },
      { id: "gold", name: "Gold", hex: "#cfa036", surchargePct: 20, finish: "metallic" },
      { id: "silver", name: "Silver", hex: "#b8bcc0", surchargePct: 20, finish: "metallic" },
      { id: "copper", name: "Copper", hex: "#b3673f", surchargePct: 20, finish: "metallic" },
      { id: "pearl-white", name: "Pearl White", hex: "#efe8df", surchargePct: 20, finish: "pearl" },
      { id: "pearl-blue", name: "Pearl Blue", hex: "#a9c3d6", surchargePct: 20, finish: "pearl" },
    ],
    buildPlate: { x: 256, y: 256, z: 256, marginPct: 15 },
  },
  discounts: {
    quantityPct: 0,
    multiPart: [],
    minPartMl: 0,
    maxMultiPartDiscount: 0,
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
        { id: "black", label: "Black Primer", hex: "#1a1a1a" },
        { id: "grey", label: "Grey Primer", hex: "#9a9a9a" },
        { id: "white", label: "White Primer", hex: "#f6f3ec" },
      ],
    },
  },
}) as Formula;

const DEFAULT_G_PER_ML = 1.24;

const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));
const isObj = (v: unknown): v is Record<string, Any> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Mirrors migrateV1 in js/pricing-formula.js. */
function migrateV1(saved: Any): Any {
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

/** Saved settings over the defaults, key by key. Mirrors mergeFormula in js. */
export function mergeFormula(saved: unknown, defaults: Any = FORMULA_DEFAULTS): Formula {
  return mergeNode(migrateV1(saved), defaults, "");
}

const MAY_BE_EMPTY = new Set(["discounts.multiPart"]);

function mergeNode(saved: Any, defaults: Any, path: string): Any {
  if (Array.isArray(defaults)) {
    if (!Array.isArray(saved)) return clone(defaults);
    if (!saved.length && !MAY_BE_EMPTY.has(path)) return clone(defaults);
    return clone(saved);
  }
  const out: Any = {};
  for (const [k, v] of Object.entries(defaults)) {
    const s = isObj(saved) ? saved[k] : undefined;
    const p = path ? `${path}.${k}` : k;
    out[k] = v !== null && typeof v === "object"
      ? mergeNode(s, v, p)
      : (typeof s === typeof v && (typeof v !== "number" || Number.isFinite(s)) ? s : v);
  }
  return out;
}

export function findMaterial(method: { materials: FormulaMaterial[] }, materialId?: string): FormulaMaterial {
  return method.materials.find((m) => m.id === materialId) ?? method.materials[0];
}

export function filamentGrams(
  volumeMl: number,
  areaMm2: number | undefined | null,
  formula: Formula,
  material?: FormulaMaterial,
): number | null {
  if (!Number.isFinite(areaMm2) || !Number.isFinite(volumeMl)) return null;
  const shellMl = (areaMm2 as number) * formula.fdm.shellMm / 1000;
  const ml = shellMl >= volumeMl ? volumeMl : shellMl + (volumeMl - shellMl) * formula.fdm.infillPct / 100;
  const density = Number.isFinite(material?.gPerMl) && (material!.gPerMl as number) > 0
    ? material!.gPerMl as number
    : DEFAULT_G_PER_ML;
  return ml * density;
}

function curveTerm(t: CurveTerm, amount: number, ref: number): number {
  if (!(amount > 0) || !(ref > 0)) return 0;
  return t.price * Math.pow(amount / ref, t.curve);
}

export function roundUpTo(value: number, step: number): number {
  const s = step > 0 ? step : 0.01;
  return Math.round(Math.ceil(Math.round(value * 100) / 100 / s - 1e-9) * s * 100) / 100;
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
  const material = findMaterial(m, materialId);
  let raw: number;
  let grams: number | null = null;
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
    raw = r.startingCharge +
      curveTerm(r.volume, pricedVolumeMl, r.volume.refMl) +
      curveTerm(r.size, pricedLongestMm, r.size.refMm) +
      (presupported ? 0 : s.handlingFee);
  }
  const adjusted = raw * (1 + m.adjustPct / 100) * (1 + (material?.modifierPct ?? 0) / 100);
  if (!Number.isFinite(adjusted)) return null;
  const price = roundUpTo(Math.max(adjusted, m.minPrice), formula.order.roundTo);
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

export function quantityLineTotal(
  unitPrice: number,
  quantity: number,
  formula: Formula,
  eligible = true,
): number {
  const q = Math.max(1, Math.floor(quantity) || 1);
  const pct = eligible ? formula.discounts.quantityPct : 0;
  const extra = (q - 1) * unitPrice * (1 - pct / 100);
  return Math.round((unitPrice + extra) * 100) / 100;
}

/** Mirrors labourFee in js. */
export function labourFee(volumeMl: number, method: string, formula: Formula): number {
  const l = (method === "pla" ? formula.fdm : formula.resin).labour;
  return l.perPart + (volumeMl < l.smallPartMaxMl ? l.smallPartFee : 0);
}

/** Mirrors discountEligible in js. */
export function discountEligible(volumeMl: number, formula: Formula): boolean {
  return volumeMl >= formula.discounts.minPartMl;
}

/** Mirrors multiPartDiscount in js. */
export function multiPartDiscount(
  eligibleParts: number,
  discountableSubtotal: number,
  formula: Formula,
): { pct: number; amount: number } {
  const pct = multiPartDiscountPct(eligibleParts, formula);
  let amount = Math.round(discountableSubtotal * pct) / 100;
  const cap = formula.discounts.maxMultiPartDiscount;
  if (cap > 0 && amount > cap) amount = cap;
  return { pct, amount };
}

export function multiPartDiscountPct(partCount: number, formula: Formula): number {
  let pct = 0;
  for (const t of formula.discounts.multiPart) {
    if (partCount >= t.minParts && t.pct > pct) pct = t.pct;
  }
  return pct;
}

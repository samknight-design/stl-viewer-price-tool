// Pins the server's formula to the browser's, and both to the prices the owner
// approved in the pricing trainer (fit 1, 3 Nov 2026).
//
// If a parity test fails, the relay would re-price honest orders differently
// from the customer's screen: fix whichever side drifted, never the test.

import { assertEquals } from "jsr:@std/assert@1";
import * as browserFormula from "../../../js/pricing-formula.js";
import * as browserCalc from "../../../js/calculator.js";
import { FORMULA_DEFAULTS, formulaPartPrice, mergeFormula } from "./formula.ts";
import { calcGroupCost, calcItemCost } from "./pricing.ts";
import { DEFAULT_PRICING_CONFIG, mergePricingConfig } from "./pricingConfig.ts";

// Real DM Stash parts and the prices approved for them in the trainer.
const APPROVED = [
  { name: "Alric 75mm body", part: { volumeMl: 49.3, dimensions: { x: 49, y: 63, z: 108 }, presupported: true }, price: 16.5 },
  { name: "Aterian base cut A", part: { volumeMl: 74.7, dimensions: { x: 79, y: 82, z: 82 }, presupported: true }, price: 17 },
  { name: "Aterian 32mm leg", part: { volumeMl: 1.8, dimensions: { x: 19, y: 21, z: 43 }, presupported: true }, price: 3.5 },
  { name: "Brandyn 75mm body", part: { volumeMl: 71.7, dimensions: { x: 117, y: 62.8, z: 144 }, presupported: true }, price: 21 },
];

Deno.test("formula: defaults are identical on both sides", () => {
  assertEquals(FORMULA_DEFAULTS, browserFormula.FORMULA_DEFAULTS);
  assertEquals(mergeFormula(undefined), browserFormula.mergeFormula(undefined));
});

Deno.test("formula: the approved trainer prices", () => {
  for (const a of APPROVED) {
    assertEquals(formulaPartPrice({ ...a.part, method: "resin" }, FORMULA_DEFAULTS)?.price, a.price, a.name);
  }
  // Aterian's Lair Part 0 (602 g estimated) and the dowels (31 g).
  const grams = (g: number) => {
    // Invert the filament estimate's shell term away: feed a solid part whose
    // whole volume is shell, so grams = volume × 1.24.
    const ml = g / 1.24;
    return formulaPartPrice({ volumeMl: ml, dimensions: { x: 1, y: 1, z: 1 }, areaMm2: 1e9, method: "pla" }, FORMULA_DEFAULTS)?.price;
  };
  assertEquals(grams(602), 30);
  assertEquals(grams(31), 7);
});

Deno.test("formula: browser and server agree across a grid of parts and settings", () => {
  const settingsGrid = [
    undefined,
    { roundTo: 0.01 },
    { roundTo: 1, resin: { adjustPct: 12, minPrice: 4 }, fdm: { adjustPct: -20, infillPct: 15 } },
    { resin: { supports: { handlingFee: 2.5, extraVolumePct: 30 }, materials: [{ id: "abs-like", name: "ABS-like resin", modifierPct: 0 }, { id: "tough", name: "Tough", modifierPct: 25 }] } },
  ];
  let checked = 0;
  for (const saved of settingsGrid) {
    const fs = mergeFormula(saved);
    const fb = browserFormula.mergeFormula(saved);
    assertEquals(fs, fb);
    for (const volumeMl of [0.2, 1.8, 6, 31, 72, 250, 1142.87, 4079.43]) {
      for (const longest of [12, 49, 108, 151, 205]) {
        for (const presupported of [true, false]) {
          for (const method of ["resin", "pla"]) {
            for (const materialId of [undefined, "tough"]) {
              const part = {
                volumeMl,
                dimensions: { x: longest * 0.6, y: longest, z: longest * 0.4 },
                areaMm2: Math.pow(volumeMl * 1000, 2 / 3) * 6.5,
                presupported,
                method,
                materialId,
              };
              assertEquals(formulaPartPrice(part, fs), browserFormula.formulaPartPrice(part, fb));
              checked++;
            }
          }
        }
      }
    }
  }
  assertEquals(checked, 4 * 8 * 5 * 2 * 2 * 2);
});

Deno.test("formula: the full item cost agrees between js/calculator.js and pricing.ts", () => {
  const saved = { formula: { resin: { adjustPct: 5 } } };
  const serverConfig = mergePricingConfig(saved);
  const browserConfig = browserFormula.applyFormula({ ...DEFAULT_PRICING_CONFIG, ...saved }, saved.formula);
  for (const printMethod of ["resin", "pla"]) {
    for (const presupported of [true, false]) {
      for (const scale of [1, 1.5]) {
        for (const plaColor of ["black", "gold"]) {
          const stl = { volumeMl: 49.3, dimensions: { x: 49, y: 63, z: 108 }, areaMm2: 9100 };
          const settings = { scale, quantity: 2, materialId: "abs-like", presupported, plaColor };
          const s = calcItemCost(stl, settings, serverConfig, printMethod);
          const b = browserCalc.calcItemCost(stl, settings, browserConfig, printMethod);
          assertEquals(s.unitCost, b.unitCost, `${printMethod} ${presupported} ${scale} ${plaColor}`);
          assertEquals(s.priceable, b.priceable);
          assertEquals(s.formula, b.formula);
        }
      }
    }
  }
});

Deno.test("formula: an FDM part with no surface area is unpriceable, never cheap", () => {
  const config = mergePricingConfig(null);
  const cost = calcItemCost({ volumeMl: 50, dimensions: { x: 40, y: 40, z: 40 } }, { presupported: false }, config, "pla");
  assertEquals(cost.priceable, false);
  assertEquals(cost.unreadable, true);
});

Deno.test("formula: folding in replaces materials, colours, primer, assembly, plates and order rules", () => {
  const c = mergePricingConfig({
    formula: {
      finishes: { assemblyFirst: 6, primer: { tiers: [{ maxMl: 10, price: 2 }], maxPrice: 9 } },
      fdm: { colours: [{ id: "neon", name: "Neon", hex: "#0f0", surchargePct: 15 }] },
      resin: { buildPlate: { x: 300, y: 200, z: 250, marginPct: 10 } },
      order: { customQuoteThreshold: 200 },
    },
  });
  assertEquals(c.materials, [{ id: "abs-like", name: "ABS-like resin" }]);
  assertEquals(c.assemblyBase, 6);
  assertEquals(c.primerTiers, [{ maxVolumeMl: 10, price: 2 }]);
  assertEquals(c.primerMaxPrice, 9);
  assertEquals(c.plaColorSurchargePct, { neon: 15 });
  assertEquals(c.buildPlate, { x: 300, y: 200, z: 250, supportMarginPct: 10 });
  assertEquals(c.customQuoteOrderThreshold, 200);
});

Deno.test("formula: v1 trainer settings migrate to the same prices", () => {
  const v1 = {
    version: 1, roundTo: 0.5,
    resin: { perSqrtMl: 1.486, perLongestMm: 0.069 },
    fdm: { perSqrtGram: 1.216 },
  };
  const a = mergeFormula(v1), b = mergeFormula(undefined);
  for (const p of APPROVED) assertEquals(formulaPartPrice({ ...p.part }, a)?.price, formulaPartPrice({ ...p.part }, b)?.price);
});

Deno.test("formula: discounts — quantity copies and multi-part tiers agree on both sides", () => {
  const saved = { formula: { discounts: { quantityPct: 20, multiPart: [{ minParts: 3, pct: 5 }, { minParts: 6, pct: 12 }] } } };
  const serverConfig = mergePricingConfig(saved);
  const browserConfig = browserFormula.applyFormula({ ...DEFAULT_PRICING_CONFIG, ...saved }, saved.formula);
  const stl = { volumeMl: 6, dimensions: { x: 28, y: 33, z: 49 }, areaMm2: 2000 };
  for (const quantity of [1, 2, 5]) {
    const s = calcItemCost(stl, { quantity, presupported: true }, serverConfig, "resin");
    const b = browserCalc.calcItemCost(stl, { quantity, presupported: true }, browserConfig, "resin");
    assertEquals(s.totalCost, b.totalCost);
  }
  // £5.50 part: one copy 5.50; three copies 5.50 + 2 × 4.40 = 14.30.
  assertEquals(calcItemCost(stl, { quantity: 3, presupported: true }, serverConfig, "resin").totalCost, 14.3);
  for (const parts of [1, 3, 6]) {
    const items = Array.from({ length: parts }, () => ({
      status: "ready",
      settings: { quantity: 1, presupported: true },
      cost: calcItemCost(stl, { quantity: 1, presupported: true }, serverConfig, "resin"),
    }));
    const bItems = Array.from({ length: parts }, () => ({
      status: "ready",
      settings: { quantity: 1, presupported: true },
      cost: browserCalc.calcItemCost(stl, { quantity: 1, presupported: true }, browserConfig, "resin"),
    }));
    const s = calcGroupCost(items, { assembly: true, primer: "black" }, serverConfig);
    const b = browserCalc.calcGroupCost(bItems, { assembly: true, primer: "black" }, browserConfig);
    assertEquals(s.groupTotal, b.groupTotal);
    assertEquals(s.multiPartPct, parts >= 6 ? 12 : parts >= 3 ? 5 : 0);
  }
});

Deno.test("formula: a new filament prices on its own density and modifier", () => {
  const f = mergeFormula({ fdm: { materials: [
    { id: "matte-pla", name: "Matte PLA", modifierPct: 0, gPerMl: 1.24 },
    { id: "petg", name: "PETG", modifierPct: 10, gPerMl: 1.27 },
  ] } });
  const part = { volumeMl: 500, dimensions: { x: 100, y: 100, z: 100 }, areaMm2: 60000, method: "pla" };
  const pla = formulaPartPrice({ ...part, materialId: "matte-pla" }, f)!;
  const petg = formulaPartPrice({ ...part, materialId: "petg" }, f)!;
  assertEquals(Math.round(petg.grams! / pla.grams! * 1000) / 1000, Math.round(1.27 / 1.24 * 1000) / 1000);
  assertEquals(petg.materialName, "PETG");
  assertEquals(petg.price > pla.price, true);
});

// Pins the server's formula to the browser's, and both to the prices the owner
// approved in the pricing trainer (fit 1, 3 Nov 2026).
//
// If a parity test fails, the relay would re-price honest orders differently
// from the customer's screen: fix whichever side drifted, never the test.

import { assertEquals } from "jsr:@std/assert@1";
import * as browserFormula from "../../../js/pricing-formula.js";
import * as browserCalc from "../../../js/calculator.js";
import { FORMULA_DEFAULTS, formulaPartPrice, mergeFormula } from "./formula.ts";
import { calcItemCost } from "./pricing.ts";
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

Deno.test("formula: folding in the formula replaces materials and assembly, scales primer", () => {
  const c = mergePricingConfig({ formula: { finishes: { assemblyFirst: 6, primerAdjustPct: 50 } } });
  assertEquals(c.materials, [{ id: "abs-like", name: "ABS-like resin" }]);
  assertEquals(c.assemblyBase, 6);
  assertEquals(c.primerTiers[0].price, 1);      // 0.50 × 1.5 = 0.75 → up to 1.00
  assertEquals(c.primerTiers[5].price, 12);     // 8.00 × 1.5 = 12.00
});

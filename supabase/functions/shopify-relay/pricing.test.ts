// supabase/functions/shopify-relay/pricing.test.ts
import { assertEquals } from "std/testing/asserts.ts";
import {
  calcAssemblyCost,
  calcGroupCost,
  calcItemCost,
  calcOrderTotal,
  calcPrimerCost,
  calcSizeTier,
  fitsBuildPlate,
  type PricingConfig,
} from "./pricing.ts";
import { DEFAULT_PRICING_CONFIG, mergePricingConfig } from "./pricingConfig.ts";

// The browser's own config module, imported directly. This is the point of
// the parity block below: pricingConfig.ts is a hand-kept mirror, and a mirror
// nobody checks is a mirror that drifts.
import { DEFAULT_CONFIG } from "../../../js/config.js";

const CFG: PricingConfig = DEFAULT_PRICING_CONFIG;

// A 20 mm cube: 8000 mm3 = 8 mL.
const CUBE_20 = { dimensions: { x: 20, y: 20, z: 20 }, volumeMl: 8 };

// ---- Parity with js/config.js -----------------------------------------

Deno.test("parity: scalar pricing fields match js/config.js", () => {
  const scalars = [
    "maxPlatePrice",
    "tierBoundaryAllowanceMm",
    "assemblyBase",
    "assemblyPerJoint",
    "assemblyMax",
    "primerMinPrice",
    "primerMaxPrice",
    "customQuoteOrderThreshold",
    "minimumOrderTotal",
    "supportSizeInflationPct",
    "supportHandlingFeePct",
  ] as const;
  for (const key of scalars) {
    assertEquals(
      (DEFAULT_PRICING_CONFIG as unknown as Record<string, unknown>)[key],
      (DEFAULT_CONFIG as Record<string, unknown>)[key],
      `${key} has drifted from js/config.js`,
    );
  }
});

Deno.test("parity: nested pricing objects match js/config.js", () => {
  assertEquals(DEFAULT_PRICING_CONFIG.buildPlate, DEFAULT_CONFIG.buildPlate);
  assertEquals(DEFAULT_PRICING_CONFIG.fdmBuildPlate, DEFAULT_CONFIG.fdmBuildPlate);
  assertEquals(DEFAULT_PRICING_CONFIG.fdm, DEFAULT_CONFIG.fdm);
  assertEquals(
    DEFAULT_PRICING_CONFIG.materialSurcharges,
    DEFAULT_CONFIG.materialSurcharges,
  );
  assertEquals(
    DEFAULT_PRICING_CONFIG.plaColorSurchargePct,
    DEFAULT_CONFIG.plaColorSurchargePct,
  );
});

Deno.test("parity: tier / primer / extras ladders match js/config.js", () => {
  assertEquals(DEFAULT_PRICING_CONFIG.sizeTiers, DEFAULT_CONFIG.sizeTiers);
  assertEquals(DEFAULT_PRICING_CONFIG.primerTiers, DEFAULT_CONFIG.primerTiers);
  assertEquals(DEFAULT_PRICING_CONFIG.extras, DEFAULT_CONFIG.extras);
});

Deno.test("parity: material and PLA colour ids/tiers match js/config.js", () => {
  // Only the price-bearing fields are mirrored; hex/description are display.
  assertEquals(
    DEFAULT_PRICING_CONFIG.materials,
    DEFAULT_CONFIG.materials.map((m: { id: string; name: string }) => ({
      id: m.id,
      name: m.name,
    })),
  );
  assertEquals(
    DEFAULT_PRICING_CONFIG.plaColors,
    DEFAULT_CONFIG.plaColors.map(
      (c: { id: string; name: string; tier: string }) => ({
        id: c.id,
        name: c.name,
        tier: c.tier,
      }),
    ),
  );
});

// ---- Engine behaviour --------------------------------------------------

Deno.test("build plate fit accounts for rotation and the support margin", () => {
  // Usable plate is 211.68/118.37/220 less 20% => 169.34/94.70/176.
  assertEquals(fitsBuildPlate({ x: 90, y: 160, z: 170 }, CFG.buildPlate), true);
  // Same volume, but two axes now exceed the two smallest usable axes.
  assertEquals(fitsBuildPlate({ x: 120, y: 160, z: 170 }, CFG.buildPlate), false);
});

Deno.test("size tier uses the median axis, not the longest", () => {
  // A 20 mm body with a 150 mm spear. Priced off the longest axis this would
  // be XXL (£36); off the median it is XS (£1), which is the whole point.
  assertEquals(calcSizeTier({ x: 20, y: 20, z: 150 }, CFG)?.name, "XS");
  assertEquals(calcSizeTier({ x: 150, y: 150, z: 150 }, CFG), null);
  // A chunkier body with the same spear does move up the ladder.
  assertEquals(calcSizeTier({ x: 25, y: 25, z: 150 }, CFG)?.name, "Small");
});

Deno.test("a model that cannot fit the plate has no tier", () => {
  assertEquals(calcSizeTier({ x: 200, y: 200, z: 200 }, CFG), null);
});

Deno.test("the boundary allowance keeps a just-over model in the cheaper tier", () => {
  assertEquals(calcSizeTier({ x: 52, y: 52, z: 52 }, CFG)?.name, "Regular");
  assertEquals(calcSizeTier({ x: 56, y: 56, z: 56 }, CFG)?.name, "Medium");
});

Deno.test("resin: a standard upload pays the support handling fee", () => {
  // 20mm cube inflated 8% => 21.6 median => Small (£3). Fee = 40% of £3.
  const cost = calcItemCost(
    CUBE_20,
    { scale: 1, quantity: 1, materialId: "standard", presupported: false },
    CFG,
  );
  assertEquals(cost.tier?.name, "Small");
  assertEquals(Number(cost.supportHandlingFee.toFixed(4)), 1.2);
  assertEquals(Number(cost.unitCost.toFixed(4)), 4.2);
  assertEquals(Number(cost.totalCost.toFixed(4)), 4.2);
});

Deno.test("resin: the same model pre-supported is cheaper", () => {
  // No inflation => 20mm median => XS (£1, allowance takes 20 <= 15+5).
  const cost = calcItemCost(
    CUBE_20,
    { scale: 1, quantity: 1, materialId: "standard", presupported: true },
    CFG,
  );
  assertEquals(cost.tier?.name, "XS");
  assertEquals(cost.supportHandlingFee, 0);
  assertEquals(cost.unitCost, 1);
});

Deno.test("resin: material surcharge is a percentage of the tier price", () => {
  const cost = calcItemCost(
    CUBE_20,
    { scale: 1, quantity: 1, materialId: "dental", presupported: true },
    CFG,
  );
  // XS £1 + 35%
  assertEquals(Number(cost.unitCost.toFixed(4)), 1.35);
});

Deno.test("scale cubes the volume and scales every dimension", () => {
  const cost = calcItemCost(
    CUBE_20,
    { scale: 2, quantity: 1, materialId: "standard", presupported: true },
    CFG,
  );
  assertEquals(cost.scaledDims, { x: 40, y: 40, z: 40 });
  assertEquals(cost.scaledVolumeMl, 64); // 8 * 2^3
  assertEquals(cost.tier?.name, "Regular"); // 40mm median
});

Deno.test("PLA is priced by volume with no support fee", () => {
  const cost = calcItemCost(
    CUBE_20,
    { scale: 1, quantity: 1, plaColor: "black" },
    CFG,
    "pla",
  );
  assertEquals(cost.tier, null);
  assertEquals(cost.priceable, true);
  assertEquals(cost.supportHandlingFee, 0);
  assertEquals(Number(cost.unitCost.toFixed(4)), 0.96); // 8 mL * £0.12
});

Deno.test("PLA colour surcharge scales with the part's own cost", () => {
  const cost = calcItemCost(
    CUBE_20,
    { scale: 1, quantity: 1, plaColor: "gold" },
    CFG,
    "pla",
  );
  assertEquals(Number(cost.unitCost.toFixed(4)), 1.152); // 0.96 + 20%
});

Deno.test("assembly: first joint then per-joint, capped", () => {
  assertEquals(calcAssemblyCost(1, CFG), 0);
  assertEquals(calcAssemblyCost(2, CFG), 5);
  assertEquals(calcAssemblyCost(3, CFG), 8.5);
  assertEquals(calcAssemblyCost(100, CFG), 40); // assemblyMax
});

Deno.test("primer is tiered by the group's combined volume", () => {
  assertEquals(calcPrimerCost(8, "grey", CFG).total, 2.00);
  assertEquals(calcPrimerCost(8, "unprimed", CFG).total, 0);
  assertEquals(calcPrimerCost(1000, "white", CFG).total, 20.00); // primerMaxPrice
});

Deno.test("group total sums parts, extras, assembly and primer", () => {
  const item = {
    status: "ready",
    settings: { quantity: 2, scale: 1, materialId: "standard" },
    cost: calcItemCost(
      CUBE_20,
      { scale: 1, quantity: 2, materialId: "standard", presupported: false },
      CFG,
    ),
  };
  const group = calcGroupCost([item], {
    assembly: true,
    primer: "grey",
    extras: ["wings", "shield"],
    printMethod: "resin",
  }, CFG);

  assertEquals(Number(group.fileSubtotal.toFixed(4)), 8.4); // 4.2 x 2
  assertEquals(group.totalPartCount, 2);
  assertEquals(group.totalVolumeMl, 16); // 8 mL x qty 2
  assertEquals(group.extrasCost, 4.5); // 3.00 + 1.50
  assertEquals(group.assemblyCost, 5); // 2 parts = 1 joint
  assertEquals(group.primerTotal, 3.50); // 16 mL lands in the 30 mL tier
  assertEquals(Number(group.groupTotal.toFixed(4)), 21.4);
});

Deno.test("order total is floored at the minimum, but not for an empty cart", () => {
  const priceable = { totalPartCount: 1, groupTotal: 2.8 } as never;
  const empty = { totalPartCount: 0, groupTotal: 0 } as never;
  assertEquals(calcOrderTotal([priceable], CFG), 5);
  assertEquals(calcOrderTotal([empty], CFG), 0);
  assertEquals(calcOrderTotal([], CFG), 0);
});

// ---- Config merge ------------------------------------------------------

Deno.test("merge: a saved scalar wins, an empty array falls back", () => {
  const merged = mergePricingConfig({
    minimumOrderTotal: 7.5,
    sizeTiers: [],
  });
  assertEquals(merged.minimumOrderTotal, 7.5);
  // An empty tier ladder would price every model at maxPlatePrice.
  assertEquals(merged.sizeTiers, DEFAULT_PRICING_CONFIG.sizeTiers);
});

Deno.test("merge: a null config is the defaults", () => {
  assertEquals(mergePricingConfig(null), { ...DEFAULT_PRICING_CONFIG });
});

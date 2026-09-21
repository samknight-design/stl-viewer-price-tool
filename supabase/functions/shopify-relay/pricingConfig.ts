// supabase/functions/shopify-relay/pricingConfig.ts
//
// The relay's mirror of DEFAULT_CONFIG in js/config.js, plus the same merge
// the browser applies over the shop metafield.
//
// Why this duplication exists: until now the relay only needed two numbers
// from the config (the order minimum and the quote threshold), and the
// runbook already warned that those two must mirror the browser's. Re-pricing
// server-side needs the whole ladder — tiers, surcharges, primer, extras,
// build plates — so the mirror grows to the full pricing surface.
//
// The same rule applies, harder: if js/config.js DEFAULT_CONFIG changes, this
// changes with it. A drift here does not fail loudly; it quietly re-prices
// orders differently from the customer's screen and sends honest checkouts to
// manual review. configParity.test.ts pins the values that matter.
//
// Display-only fields (hex colours, descriptions, business name, currency
// symbol) are deliberately omitted — they cannot affect a price.

import type { PricingConfig } from "./pricing.ts";

export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  sizeTiers: [
    { name: "XS", maxDimensionMm: 15, price: 1 },
    { name: "Small", maxDimensionMm: 30, price: 3 },
    { name: "Regular", maxDimensionMm: 50, price: 6 },
    { name: "Medium", maxDimensionMm: 65, price: 9 },
    { name: "Medium+", maxDimensionMm: 80, price: 12 },
    { name: "Large", maxDimensionMm: 100, price: 15 },
    { name: "Large+", maxDimensionMm: 120, price: 21 },
    { name: "XL", maxDimensionMm: 130, price: 24 },
    { name: "XL+", maxDimensionMm: 145, price: 29 },
    { name: "XXL", maxDimensionMm: 158, price: 36 },
  ],
  maxPlatePrice: 43,
  tierBoundaryAllowanceMm: 5,

  buildPlate: { x: 211.68, y: 118.37, z: 220, supportMarginPct: 20 },

  assemblyBase: 5.00,
  assemblyPerJoint: 3.50,
  assemblyMax: 40.00,

  primerTiers: [
    { maxVolumeMl: 3, price: 0.50 },
    { maxVolumeMl: 7, price: 1.00 },
    { maxVolumeMl: 15, price: 2.00 },
    { maxVolumeMl: 30, price: 3.50 },
    { maxVolumeMl: 50, price: 5.50 },
    { maxVolumeMl: 80, price: 8.00 },
    { maxVolumeMl: 120, price: 11.00 },
    { maxVolumeMl: 180, price: 14.50 },
    { maxVolumeMl: 260, price: 18.00 },
  ],
  primerMinPrice: 0.50,
  primerMaxPrice: 20.00,

  materialSurcharges: {
    standard: 0,
    tough: 15,
    flexible: 20,
    castable: 25,
    dental: 35,
  },

  fdm: { costPerMl: 0.12 },
  fdmBuildPlate: { x: 256, y: 256, z: 256, supportMarginPct: 15 },

  plaColors: [
    { id: "white", name: "White", tier: "included" },
    { id: "black", name: "Black", tier: "included" },
    { id: "dark-grey", name: "Dark Grey", tier: "included" },
    { id: "red", name: "Red", tier: "standard" },
    { id: "orange", name: "Orange", tier: "standard" },
    { id: "yellow", name: "Yellow", tier: "standard" },
    { id: "green", name: "Green", tier: "standard" },
    { id: "blue", name: "Blue", tier: "standard" },
    { id: "purple", name: "Purple", tier: "standard" },
    { id: "pink", name: "Pink", tier: "standard" },
    { id: "brown", name: "Brown", tier: "standard" },
    { id: "gold", name: "Gold", tier: "metallic" },
    { id: "silver", name: "Silver", tier: "metallic" },
    { id: "copper", name: "Copper", tier: "metallic" },
    { id: "pearl-white", name: "Pearl White", tier: "pearlescent" },
    { id: "pearl-blue", name: "Pearl Blue", tier: "pearlescent" },
  ],
  plaColorSurchargePct: {
    included: 0,
    standard: 10,
    metallic: 20,
    pearlescent: 20,
  },

  extras: [
    { id: "wings", name: "Wings", price: 3.00 },
    { id: "weapon", name: "Sword / Weapon", price: 1.50 },
    { id: "shield", name: "Shield", price: 1.50 },
    { id: "banner", name: "Banner", price: 2.50 },
  ],

  customQuoteOrderThreshold: 150.00,
  minimumOrderTotal: 5.00,

  supportSizeInflationPct: 8,
  supportHandlingFeePct: 40,

  materials: [
    { id: "standard", name: "Standard Resin" },
    { id: "tough", name: "Tough Resin" },
    { id: "flexible", name: "Flexible Resin" },
    { id: "castable", name: "Castable Resin" },
    { id: "dental", name: "Dental/Medical" },
  ],
};

/**
 * Mirrors getConfigWithSource()'s merge in js/config.js: saved scalars win,
 * but an array the shop has not saved falls back to the default rather than
 * becoming empty. An empty sizeTiers array would price every model at
 * maxPlatePrice, so the length checks are not cosmetic.
 */
export function mergePricingConfig(
  saved: Record<string, unknown> | null | undefined,
): PricingConfig {
  if (!saved) return { ...DEFAULT_PRICING_CONFIG };

  const arrayOrDefault = <K extends keyof PricingConfig>(key: K): PricingConfig[K] => {
    const value = saved[key as string];
    return Array.isArray(value) && value.length
      ? (value as PricingConfig[K])
      : DEFAULT_PRICING_CONFIG[key];
  };

  return {
    ...DEFAULT_PRICING_CONFIG,
    ...(saved as Partial<PricingConfig>),
    materials: arrayOrDefault("materials"),
    sizeTiers: arrayOrDefault("sizeTiers"),
    primerTiers: arrayOrDefault("primerTiers"),
    plaColors: arrayOrDefault("plaColors"),
    extras: arrayOrDefault("extras"),
  };
}

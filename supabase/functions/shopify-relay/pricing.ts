// supabase/functions/shopify-relay/pricing.ts
//
// Server-side port of the browser's js/calculator.js.
//
// This file and js/calculator.js MUST stay in lockstep, the same way
// print-calc-*.js mirror js/*.js. If they drift, the server re-prices every
// order differently from the figure the customer was shown and legitimate
// checkouts start getting routed to manual review. Any change to one is a
// change to both — pricing.test.ts pins the shared acceptance cases.
//
// The port is deliberately literal: same function names, same branch order,
// same rounding (none, until the very end). It is not tidied up, because a
// tidier version that computes a different penny is worse than useless here.
//
// What is NOT ported: the display formatters (fmt/fmtMl/fmtMm/fmtHours) and
// calcOrderMinimumShortfall, which only exist to drive UI copy.

export interface Dimensions {
  x: number;
  y: number;
  z: number;
}

export interface BuildPlate {
  x: number;
  y: number;
  z: number;
  supportMarginPct?: number;
}

export interface SizeTier {
  name: string;
  maxDimensionMm: number;
  price: number;
}

/** Loosely typed on purpose: the real config arrives from a shop metafield
 *  that may predate or postdate this code, and missing keys are handled by
 *  the same defaults the browser applies. */
export interface PricingConfig {
  sizeTiers: SizeTier[];
  maxPlatePrice: number;
  tierBoundaryAllowanceMm?: number;
  buildPlate: BuildPlate;
  fdmBuildPlate: BuildPlate;
  fdm?: { costPerMl?: number };
  plaColors?: Array<{ id: string; name: string; tier: string }>;
  plaColorSurchargePct?: Record<string, number>;
  materials: Array<{ id: string; name: string }>;
  materialSurcharges?: Record<string, number>;
  assemblyBase: number;
  assemblyPerJoint: number;
  assemblyMax: number;
  primerTiers: Array<{ maxVolumeMl: number; price: number }>;
  primerMinPrice?: number;
  primerMaxPrice: number;
  extras: Array<{ id: string; name: string; price: number }>;
  minimumOrderTotal?: number;
  customQuoteOrderThreshold: number;
  supportSizeInflationPct?: number;
  supportHandlingFeePct?: number;
}

export interface ItemSettings {
  scale?: number;
  quantity?: number;
  materialId?: string;
  presupported?: boolean;
  plaColor?: string;
}

export interface GroupSettings {
  assembly?: boolean;
  primer?: string;
  extras?: string[];
  printMethod?: string;
}

export interface ItemCost {
  scale: number;
  quantity: number;
  materialName: string;
  presupported: boolean;
  scaledDims: Dimensions;
  scaledVolumeMl: number;
  tier: SizeTier | null;
  priceable: boolean;
  fitsBuildPlate: boolean;
  surchargePct: number;
  surchargeAmount?: number;
  baseCost?: number;
  colorSurchargePct?: number;
  colorSurchargeAmount?: number;
  supportHandlingFee: number;
  unitCost: number;
  totalCost: number;
}

export function getMaterial(
  config: PricingConfig,
  materialId?: string,
): { id: string; name: string } {
  return config.materials.find((m) => m.id === materialId) ?? config.materials[0];
}

// ---- Build plate fit check --------------------------------------------

/**
 * Does a model (any orientation) fit the printer's build plate, after
 * reducing the plate by supportMarginPct to leave room for supports? Sorts
 * both the model's dims and the plate's dims ascending and compares pairwise,
 * so rotation on the plate is accounted for.
 */
export function fitsBuildPlate(dims: Dimensions, buildPlate: BuildPlate): boolean {
  const margin = 1 - (buildPlate.supportMarginPct ?? 0) / 100;
  const usable = [buildPlate.x, buildPlate.y, buildPlate.z]
    .map((v) => v * margin)
    .sort((a, b) => a - b);
  const model = [dims.x, dims.y, dims.z].sort((a, b) => a - b);
  return model[0] <= usable[0] && model[1] <= usable[1] && model[2] <= usable[2];
}

// ---- Size tier lookup ---------------------------------------------------

/**
 * Decide a model's price tier from the MEDIAN (second-largest) of its three
 * scaled dimensions, not the longest one. A single thin protrusion (a sword,
 * spear, banner pole) inflates only one axis. Physical fit is checked first
 * against the full 3D bounding box, so an oversized protrusion that genuinely
 * will not fit the printer is rejected outright.
 *
 * Returns null if the model does not fit the build plate even with the
 * support margin — i.e. cannot be auto-priced.
 */
export function calcSizeTier(
  dims: Dimensions,
  config: PricingConfig,
): SizeTier | null {
  if (!fitsBuildPlate(dims, config.buildPlate)) return null;

  const [, tierDim] = [dims.x, dims.y, dims.z].sort((a, b) => a - b);
  const allowance = config.tierBoundaryAllowanceMm ?? 0;
  for (const tier of config.sizeTiers) {
    if (tierDim <= tier.maxDimensionMm + allowance) {
      return {
        name: tier.name,
        maxDimensionMm: tier.maxDimensionMm,
        price: tier.price,
      };
    }
  }
  return {
    name: "Max Plate",
    maxDimensionMm: null as unknown as number,
    price: config.maxPlatePrice,
  };
}

// ---- Per-file cost ---------------------------------------------------

/**
 * printMethod is a per-MODEL choice ('resin' or 'pla'), not per-part. Resin
 * keeps size-tiered pricing; PLA/FDM is priced purely by volume, with no size
 * tiers and no support handling fee, but IS still checked against
 * config.fdmBuildPlate.
 *
 * `priceable` is the generalized "does this item have a valid price" flag that
 * callers check instead of `tier` (always null for PLA by design).
 */
export function calcItemCost(
  stlData: { dimensions: Dimensions; volumeMl: number },
  settings: ItemSettings,
  config: PricingConfig,
  printMethod = "resin",
): ItemCost {
  const {
    scale = 1.0,
    quantity = 1,
    materialId,
    presupported = false,
    plaColor,
  } = settings;
  const material = getMaterial(config, materialId);

  const scaledDims = {
    x: stlData.dimensions.x * scale,
    y: stlData.dimensions.y * scale,
    z: stlData.dimensions.z * scale,
  };
  const scaledVolumeMl = stlData.volumeMl * Math.pow(scale, 3);

  if (printMethod === "pla") {
    if (!fitsBuildPlate(scaledDims, config.fdmBuildPlate)) {
      return {
        scale,
        quantity,
        materialName: "PLA",
        presupported: false,
        scaledDims,
        scaledVolumeMl,
        tier: null,
        priceable: false,
        fitsBuildPlate: false,
        surchargePct: 0,
        supportHandlingFee: 0,
        unitCost: 0,
        totalCost: 0,
      };
    }

    const costPerMl = config.fdm?.costPerMl ?? 0;
    const baseCost = scaledVolumeMl * costPerMl;
    const colorInfo = config.plaColors?.find((c) => c.id === plaColor);
    const colorSurchargePct = colorInfo
      ? (config.plaColorSurchargePct?.[colorInfo.tier] ?? 0)
      : 0;
    const colorSurchargeAmount = baseCost * (colorSurchargePct / 100);
    const unitCost = baseCost + colorSurchargeAmount;
    const totalCost = unitCost * quantity;
    return {
      scale,
      quantity,
      materialName: colorInfo ? `PLA (${colorInfo.name})` : "PLA",
      presupported: false,
      scaledDims,
      scaledVolumeMl,
      tier: null,
      priceable: true,
      fitsBuildPlate: true,
      baseCost,
      colorSurchargePct,
      colorSurchargeAmount,
      surchargePct: 0,
      supportHandlingFee: 0,
      unitCost,
      totalCost,
    };
  }

  // A standard (non pre-supported) file is bare — we add supports before
  // printing, which grows its real footprint beyond what is in the upload.
  // Inflate the tier-lookup dimensions to estimate that growth, so the SAME
  // model uploaded both ways lands in the same size tier. Never touches the
  // displayed print size or resin volume.
  const supportInflation = presupported
    ? 1
    : 1 + (config.supportSizeInflationPct ?? 0) / 100;
  const tierDims = {
    x: scaledDims.x * supportInflation,
    y: scaledDims.y * supportInflation,
    z: scaledDims.z * supportInflation,
  };

  const tier = calcSizeTier(tierDims, config);
  const surchargePct = config.materialSurcharges?.[materialId ?? ""] ?? 0;

  if (!tier) {
    return {
      scale,
      quantity,
      materialName: material.name,
      presupported,
      scaledDims,
      scaledVolumeMl,
      tier: null,
      priceable: false,
      fitsBuildPlate: false,
      surchargePct,
      supportHandlingFee: 0,
      unitCost: 0,
      totalCost: 0,
    };
  }

  // Fee for us adding supports ourselves, scaled to the tier price so
  // pre-supported uploads always come out a meaningful percentage cheaper.
  const supportHandlingFee = presupported
    ? 0
    : tier.price * ((config.supportHandlingFeePct ?? 0) / 100);

  const surchargeAmount = tier.price * (surchargePct / 100);
  const unitCost = tier.price + surchargeAmount + supportHandlingFee;
  const totalCost = unitCost * quantity;

  return {
    scale,
    quantity,
    materialName: material.name,
    presupported,
    scaledDims,
    scaledVolumeMl,
    tier,
    priceable: true,
    fitsBuildPlate: true,
    surchargePct,
    surchargeAmount,
    supportHandlingFee,
    unitCost,
    totalCost,
  };
}

// ---- Assembly cost ----------------------------------------------------
// Joints = parts - 1. First joint costs assemblyBase, each extra costs
// assemblyPerJoint, capped at assemblyMax.

export function calcAssemblyCost(partCount: number, config: PricingConfig): number {
  if (partCount <= 1) return 0;
  const joints = partCount - 1;
  const firstJoint = config.assemblyBase;
  const extraJoints = Math.max(0, joints - 1) * config.assemblyPerJoint;
  return Math.min(firstJoint + extraJoints, config.assemblyMax);
}

// ---- Primer cost --------------------------------------------------------
// Priced once per model group (not per part) from the group's combined print
// volume — config.primerTiers, ascending by maxVolumeMl.

export function calcPrimerCost(
  totalVolumeMl: number,
  primerType: string | undefined,
  config: PricingConfig,
): { total: number } {
  if (!primerType || primerType === "unprimed") {
    return { total: 0 };
  }
  const vol = Math.max(totalVolumeMl, 0);
  let price = config.primerMaxPrice;
  for (const tier of config.primerTiers) {
    if (vol <= tier.maxVolumeMl) {
      price = tier.price;
      break;
    }
  }
  price = Math.min(
    Math.max(price, config.primerMinPrice ?? 0),
    config.primerMaxPrice ?? price,
  );
  return { total: price };
}

// ---- Group-level cost --------------------------------------------------

export interface GroupItem {
  status: string;
  cost?: ItemCost;
  settings: ItemSettings;
}

export interface GroupCost {
  fileSubtotal: number;
  totalVolumeMl: number;
  totalPartCount: number;
  oversizedCount: number;
  extrasCost: number;
  assemblyCost: number;
  primerTotal: number;
  printMethod: string;
  plaColorCost: number;
  groupTotal: number;
  isPrimed: boolean;
  primerLabel: string;
}

export function calcGroupCost(
  items: GroupItem[],
  groupSettings: GroupSettings,
  config: PricingConfig,
): GroupCost {
  const readyItems = items.filter((i) => i.status === "ready" && i.cost);
  const priceableItems = readyItems.filter((i) => i.cost!.priceable);
  const oversizedCount = readyItems.length - priceableItems.length;

  const fileSubtotal = priceableItems.reduce((s, i) => s + i.cost!.totalCost, 0);
  const totalVolumeMl = priceableItems.reduce(
    (s, i) => s + i.cost!.scaledVolumeMl * (i.settings.quantity ?? 1),
    0,
  );
  const totalPartCount = priceableItems.reduce(
    (s, i) => s + (i.settings.quantity ?? 1),
    0,
  );

  const {
    assembly = false,
    primer = "unprimed",
    extras = [],
    printMethod = "resin",
  } = groupSettings;

  const extrasCost = extras.reduce((s, extraId) => {
    const extra = config.extras.find((e) => e.id === extraId);
    return s + (extra ? extra.price : 0);
  }, 0);

  const assemblyCost = assembly ? calcAssemblyCost(totalPartCount, config) : 0;
  const primerResult = calcPrimerCost(totalVolumeMl, primer, config);

  // PLA colour surcharge is priced per part (in calcItemCost) and is already
  // folded into fileSubtotal via each item's totalCost — this is just the sum
  // for display purposes.
  const plaColorCost = priceableItems.reduce(
    (s, i) => s + (i.cost!.colorSurchargeAmount ?? 0) * (i.settings.quantity ?? 1),
    0,
  );

  const groupTotal = fileSubtotal + extrasCost + assemblyCost + primerResult.total;

  return {
    fileSubtotal,
    totalVolumeMl,
    totalPartCount,
    oversizedCount,
    extrasCost,
    assemblyCost,
    primerTotal: primerResult.total,
    printMethod,
    plaColorCost,
    groupTotal,
    isPrimed: primer !== "unprimed",
    primerLabel: primer,
  };
}

// ---- Order total -----------------------------------------------------

/**
 * Grand total across all groups, floored at config.minimumOrderTotal once
 * there is at least one actually-priceable item (an empty cart, or one
 * containing only oversized files, is never bumped up to a fake minimum).
 */
export function calcOrderTotal(
  groupCosts: GroupCost[],
  config: PricingConfig,
): number {
  const rawTotal = groupCosts.reduce((s, g) => s + (g.groupTotal ?? 0), 0);
  const minimum = config?.minimumOrderTotal ?? 0;
  const hasPriceable = groupCosts.some((g) => (g.totalPartCount ?? 0) > 0);
  if (!minimum || !hasPriceable) return rawTotal;
  return Math.max(rawTotal, minimum);
}

export function exceedsCustomQuoteThreshold(
  grandTotal: number,
  config: PricingConfig,
): boolean {
  return grandTotal >= config.customQuoteOrderThreshold;
}

// ============================================================
// calculator.js — Pricing engine
// Fixed size-tier pricing for resin bodies/bases, flat extras,
// unchanged assembly/primer add-ons.
// ============================================================

import { getMaterial } from './config.js?v=15';

// ---- Build plate fit check --------------------------------------------

/**
 * Does a model (any orientation) fit the printer's build plate, after
 * reducing the plate by supportMarginPct to leave room for supports?
 * Sorts both the model's dims and the plate's dims ascending and compares
 * pairwise, so rotation on the plate is accounted for.
 */
export function fitsBuildPlate(dims, buildPlate) {
  const margin = 1 - (buildPlate.supportMarginPct ?? 0) / 100;
  const usable = [buildPlate.x, buildPlate.y, buildPlate.z].map(v => v * margin).sort((a, b) => a - b);
  const model  = [dims.x, dims.y, dims.z].sort((a, b) => a - b);
  return model[0] <= usable[0] && model[1] <= usable[1] && model[2] <= usable[2];
}

// ---- Size tier lookup ---------------------------------------------------

/**
 * Decide a model's price tier from the MEDIAN (second-largest) of its three
 * scaled dimensions, not the longest one. A single thin protrusion (a
 * sword, spear, banner pole) inflates only one axis — pricing off the
 * longest axis alone would charge for the whole model as if it were that
 * big in every direction. The median reflects the model's actual bulk
 * instead. A small boundary allowance (config.tierBoundaryAllowanceMm)
 * also keeps a dimension that's just barely over a tier's ceiling from
 * being bumped a whole tier up.
 *
 * Physical fit is checked first against the full 3D bounding box
 * (fitsBuildPlate) — an oversized protrusion that genuinely won't fit the
 * printer is rejected outright, before the median dimension ever gets a
 * chance to make it look like a cheap, small tier.
 *
 * Returns null if the model doesn't fit the build plate even with the
 * support margin — i.e. cannot be auto-priced.
 */
export function calcSizeTier(dims, config) {
  // A model that doesn't physically fit the build plate can't be
  // auto-priced at all, no matter how small its tier-lookup dimension
  // looks — this catches e.g. a spear/appendage so long it wouldn't fit
  // the printer, even though the model's bulk (median dimension) alone
  // would otherwise look small enough for a cheap tier.
  if (!fitsBuildPlate(dims, config.buildPlate)) return null;

  const [, tierDim] = [dims.x, dims.y, dims.z].sort((a, b) => a - b);
  const allowance = config.tierBoundaryAllowanceMm ?? 0;
  for (const tier of config.sizeTiers) {
    if (tierDim <= tier.maxDimensionMm + allowance) {
      return { name: tier.name, maxDimensionMm: tier.maxDimensionMm, price: tier.price };
    }
  }
  return { name: 'Max Plate', maxDimensionMm: null, price: config.maxPlatePrice };
}

// ---- Per-file cost ---------------------------------------------------

/**
 * printMethod is a per-MODEL choice ('resin' or 'pla'), not per-part —
 * every item in a group prints the same way. Resin keeps the existing
 * size-tiered pricing (see calcSizeTier). PLA/FDM is priced purely by
 * volume (config.fdm.costPerMl) — no size tiers, no support handling
 * fee (those are resin-specific) — but IS still checked against
 * config.fdmBuildPlate, since a print can be physically too big for the
 * printer regardless of pricing model.
 *
 * PLA colour, however, IS per-part (settings.plaColor) — each part
 * prints in exactly one colour, and its surcharge is a % of that part's
 * own cost (config.plaColorSurchargePct), so it scales with print size
 * instead of being a flat fee that overcharges small parts and
 * undercharges large ones.
 *
 * `priceable` is the generalized "does this item have a valid price" flag
 * that callers should check instead of `tier` (which is always null for
 * PLA by design, not because the item failed to price).
 */
export function calcItemCost(stlData, settings, config, printMethod = 'resin') {
  const { scale = 1.0, quantity = 1, materialId, presupported = false, plaColor } = settings;
  const material = getMaterial(config, materialId);

  const scaledDims = {
    x: stlData.dimensions.x * scale,
    y: stlData.dimensions.y * scale,
    z: stlData.dimensions.z * scale,
  };
  const scaledVolumeMl = stlData.volumeMl * Math.pow(scale, 3);

  if (printMethod === 'pla') {
    if (!fitsBuildPlate(scaledDims, config.fdmBuildPlate)) {
      return {
        scale, quantity,
        materialName: 'PLA',
        presupported: false,
        scaledDims, scaledVolumeMl,
        tier: null,
        priceable: false,
        fitsBuildPlate: false,
        surchargePct: 0,
        supportHandlingFee: 0,
        unitCost: 0,
        totalCost: 0,
      };
    }

    const costPerMl  = config.fdm?.costPerMl ?? 0;
    const baseCost   = scaledVolumeMl * costPerMl;
    const colorInfo  = config.plaColors?.find(c => c.id === plaColor);
    const colorSurchargePct = colorInfo ? (config.plaColorSurchargePct?.[colorInfo.tier] ?? 0) : 0;
    const colorSurchargeAmount = baseCost * (colorSurchargePct / 100);
    const unitCost  = baseCost + colorSurchargeAmount;
    const totalCost = unitCost * quantity;
    return {
      scale, quantity,
      materialName: colorInfo ? `PLA (${colorInfo.name})` : 'PLA',
      presupported: false,
      scaledDims, scaledVolumeMl,
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

  // A standard (non pre-supported) file is bare — we'll add supports before
  // printing, which grows its real footprint beyond what's in the upload.
  // A pre-supported file's own mesh already includes that support geometry,
  // so its measured size is honest as-is. Inflate a standard file's
  // tier-lookup dimensions to estimate that growth, so the SAME model
  // uploaded both ways lands in the same (or a very close) size tier
  // instead of the bare version gaming its way into a cheaper one. This
  // never touches the displayed print size or resin volume, only which
  // tier/build-plate-fit result is used.
  const supportInflation = presupported ? 1 : 1 + (config.supportSizeInflationPct ?? 0) / 100;
  const tierDims = {
    x: scaledDims.x * supportInflation,
    y: scaledDims.y * supportInflation,
    z: scaledDims.z * supportInflation,
  };

  const tier = calcSizeTier(tierDims, config);
  const surchargePct = config.materialSurcharges?.[materialId] ?? 0;

  if (!tier) {
    return {
      scale, quantity,
      materialName: material.name,
      presupported,
      scaledDims, scaledVolumeMl,
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
  // pre-supported uploads always come out a meaningful percentage cheaper
  // than an equivalent standard upload — even when both land in the same tier.
  const supportHandlingFee = presupported ? 0 : tier.price * ((config.supportHandlingFeePct ?? 0) / 100);

  const surchargeAmount = tier.price * (surchargePct / 100);
  const unitCost  = tier.price + surchargeAmount + supportHandlingFee;
  const totalCost = unitCost * quantity;

  return {
    scale, quantity,
    materialName: material.name,
    presupported,
    scaledDims, scaledVolumeMl,
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

// ---- Assembly cost (unchanged) ----------------------------------------
// Joints = parts - 1. First joint costs assemblyBase, each extra costs assemblyPerJoint.

export function calcAssemblyCost(partCount, config) {
  if (partCount <= 1) return 0;
  const joints     = partCount - 1;
  const firstJoint = config.assemblyBase;
  const extraJoints = Math.max(0, joints - 1) * config.assemblyPerJoint;
  return Math.min(firstJoint + extraJoints, config.assemblyMax);
}

// ---- Primer cost --------------------------------------------------------
// Priced once per model group (not per part) from the group's combined
// print volume — config.primerTiers, ascending by maxVolumeMl, same
// pattern as the size-tier ladder. Falls back to primerMaxPrice for
// anything bigger than the last tier, and primerMinPrice floors the
// result either way.

export function calcPrimerCost(totalVolumeMl, primerType, config) {
  if (!primerType || primerType === 'unprimed') {
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
  price = Math.min(Math.max(price, config.primerMinPrice ?? 0), config.primerMaxPrice ?? price);
  return { total: price };
}

// ---- Group-level cost --------------------------------------------------

export function calcGroupCost(items, groupSettings, config) {
  const readyItems     = items.filter(i => i.status === 'ready' && i.cost);
  const priceableItems = readyItems.filter(i => i.cost.priceable);
  const oversizedCount = readyItems.length - priceableItems.length;

  const fileSubtotal   = priceableItems.reduce((s, i) => s + i.cost.totalCost, 0);
  const totalVolumeMl  = priceableItems.reduce((s, i) => s + i.cost.scaledVolumeMl * i.settings.quantity, 0);
  const totalPartCount = priceableItems.reduce((s, i) => s + i.settings.quantity, 0);

  const {
    assembly = false, primer = 'unprimed', extras = [],
    printMethod = 'resin',
  } = groupSettings;

  const extrasCost = extras.reduce((s, extraId) => {
    const extra = config.extras.find(e => e.id === extraId);
    return s + (extra ? extra.price : 0);
  }, 0);

  const assemblyCost = assembly ? calcAssemblyCost(totalPartCount, config) : 0;
  const primerResult = calcPrimerCost(totalVolumeMl, primer, config);

  // PLA colour surcharge is priced per part (in calcItemCost) and is
  // already folded into fileSubtotal via each item's totalCost — this is
  // just the sum for display purposes (e.g. a "colour surcharge" line).
  const plaColorCost = priceableItems.reduce(
    (s, i) => s + (i.cost.colorSurchargeAmount ?? 0) * i.settings.quantity, 0
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
    isPrimed:    primer !== 'unprimed',
    primerLabel: primer,
  };
}

// ---- Order total -----------------------------------------------------

function sumGroupTotals(groups) {
  return groups.reduce((s, g) => s + (g.groupCost?.groupTotal ?? 0), 0);
}

function hasPriceableItems(groups) {
  return groups.some(g => (g.groupCost?.totalPartCount ?? 0) > 0);
}

/**
 * Grand total across all groups, floored at config.minimumOrderTotal once
 * there's at least one actually-priceable item (an empty cart, or one
 * containing only oversized/unpriceable files, is never bumped up to a
 * fake minimum).
 */
export function calcOrderTotal(groups, config) {
  const rawTotal = sumGroupTotals(groups);
  const minimum  = config?.minimumOrderTotal ?? 0;
  if (!minimum || !hasPriceableItems(groups)) return rawTotal;
  return Math.max(rawTotal, minimum);
}

/**
 * How much more (in currency units) the order needs to reach
 * config.minimumOrderTotal — 0 if the minimum doesn't apply or is
 * already met. Lets the UI nudge the customer to add more before they
 * hit the minimum anyway.
 */
export function calcOrderMinimumShortfall(groups, config) {
  const rawTotal = sumGroupTotals(groups);
  const minimum  = config?.minimumOrderTotal ?? 0;
  if (!minimum || !hasPriceableItems(groups) || rawTotal >= minimum) return 0;
  return minimum - rawTotal;
}

export function exceedsCustomQuoteThreshold(grandTotal, config) {
  return grandTotal >= config.customQuoteOrderThreshold;
}

// ---- Formatters -------------------------------------------------------

export function fmt(amount, symbol = '£') {
  return `${symbol}${amount.toFixed(2)}`;
}
export function fmtMl(ml) {
  return ml < 1 ? `${(ml * 1000).toFixed(1)} µL` : `${ml.toFixed(2)} mL`;
}
export function fmtMm(mm) { return `${mm.toFixed(1)} mm`; }
export function fmtHours(h) {
  if (h < 1 / 60) return '<1 min';
  if (h < 1)      return `${Math.round(h * 60)} min`;
  return `${h.toFixed(1)} hr`;
}

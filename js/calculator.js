// ============================================================
// calculator.js — Pricing engine
// Fixed size-tier pricing for resin bodies/bases, flat extras,
// unchanged assembly/primer add-ons.
// ============================================================

import { getMaterial } from './config.js?v=10';

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
 * Decide a model's price tier from its largest scaled dimension.
 * Returns null if it exceeds every defined tier AND doesn't fit the
 * build plate even with the support margin — i.e. cannot be auto-priced.
 */
export function calcSizeTier(dims, config) {
  const largest = Math.max(dims.x, dims.y, dims.z);
  for (const tier of config.sizeTiers) {
    if (largest <= tier.maxDimensionMm) {
      return { name: tier.name, maxDimensionMm: tier.maxDimensionMm, price: tier.price };
    }
  }
  if (fitsBuildPlate(dims, config.buildPlate)) {
    return { name: 'Max Plate', maxDimensionMm: null, price: config.maxPlatePrice };
  }
  return null;
}

// ---- Per-file cost ---------------------------------------------------

export function calcItemCost(stlData, settings, config) {
  const { scale = 1.0, quantity = 1, materialId, presupported = false } = settings;
  const material = getMaterial(config, materialId);

  const scaledDims = {
    x: stlData.dimensions.x * scale,
    y: stlData.dimensions.y * scale,
    z: stlData.dimensions.z * scale,
  };
  const scaledVolumeMl = stlData.volumeMl * Math.pow(scale, 3);

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
  // Small flat fee for us adding supports ourselves, so pre-supported always
  // prices a little cheaper than an equivalent standard upload — even when
  // both land in the same tier.
  const supportHandlingFee = presupported ? 0 : (config.unsupportedHandlingFee ?? 0);

  if (!tier) {
    return {
      scale, quantity,
      materialName: material.name,
      presupported,
      scaledDims, scaledVolumeMl,
      tier: null,
      fitsBuildPlate: false,
      surchargePct,
      supportHandlingFee,
      unitCost: 0,
      totalCost: 0,
    };
  }

  const surchargeAmount = tier.price * (surchargePct / 100);
  const unitCost  = tier.price + surchargeAmount + supportHandlingFee;
  const totalCost = unitCost * quantity;

  return {
    scale, quantity,
    materialName: material.name,
    presupported,
    scaledDims, scaledVolumeMl,
    tier,
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

// ---- Primer cost (unchanged) ------------------------------------------
// Material: flat fee per model group. Labour: scales with volume^(2/3)
// as a surface-area proxy, capped.

export function calcPrimerCost(totalVolumeMl, primerType, config) {
  if (!primerType || primerType === 'unprimed') {
    return { material: 0, labour: 0, total: 0 };
  }
  const material = config.primerMaterialCost;
  const labour   = Math.max(
    config.primerLabourMin,
    Math.min(
      Math.pow(Math.max(totalVolumeMl, 0.1), 2 / 3) * config.primerLabourMultiplier,
      config.primerLabourMax
    )
  );
  return { material, labour, total: material + labour };
}

// ---- Group-level cost --------------------------------------------------

export function calcGroupCost(items, groupSettings, config) {
  const readyItems     = items.filter(i => i.status === 'ready' && i.cost);
  const priceableItems = readyItems.filter(i => i.cost.tier);
  const oversizedCount = readyItems.length - priceableItems.length;

  const fileSubtotal   = priceableItems.reduce((s, i) => s + i.cost.totalCost, 0);
  const totalVolumeMl  = priceableItems.reduce((s, i) => s + i.cost.scaledVolumeMl * i.settings.quantity, 0);
  const totalPartCount = priceableItems.reduce((s, i) => s + i.settings.quantity, 0);

  const { assembly = false, primer = 'unprimed', extras = [] } = groupSettings;

  const extrasCost = extras.reduce((s, extraId) => {
    const extra = config.extras.find(e => e.id === extraId);
    return s + (extra ? extra.price : 0);
  }, 0);

  const assemblyCost = assembly ? calcAssemblyCost(totalPartCount, config) : 0;
  const primerResult = calcPrimerCost(totalVolumeMl, primer, config);

  const groupTotal = fileSubtotal + extrasCost + assemblyCost + primerResult.total;

  return {
    fileSubtotal,
    totalVolumeMl,
    totalPartCount,
    oversizedCount,
    extrasCost,
    assemblyCost,
    primerMaterial: primerResult.material,
    primerLabour:   primerResult.labour,
    primerTotal:    primerResult.total,
    groupTotal,
    isPrimed:    primer !== 'unprimed',
    primerLabel: primer,
  };
}

// ---- Order total -----------------------------------------------------

export function calcOrderTotal(groups) {
  return groups.reduce((s, g) => s + (g.groupCost?.groupTotal ?? 0), 0);
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

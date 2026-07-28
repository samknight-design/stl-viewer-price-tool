// ============================================================
// calculator.js — Pricing engine
// Per-file costs + per-group assembly / primer / labour
// ============================================================

import { getMaterial } from './config.js?v=6';

// ---- Per-file cost ---------------------------------------------------

export function calcItemCost(stlData, settings, config) {
  const { scale = 1.0, quantity = 1, materialId, presupported = false } = settings;
  const material = getMaterial(config, materialId);

  const scaledVolumeMl      = stlData.volumeMl * Math.pow(scale, 3);
  const effectiveSupportPct = presupported ? 0 : config.supportMaterial;
  const totalVolumeMl       = scaledVolumeMl * (1 + effectiveSupportPct / 100);

  const resinCost   = totalVolumeMl * material.costPerMl;
  const printHours  = totalVolumeMl / config.printSpeedMlPerHour;
  const machineCost = printHours * config.machineHourlyCost;

  const baseCost   = resinCost + machineCost;
  const withMarkup = baseCost * (1 + config.markupPercentage / 100);
  // No per-item minimum — minimum applies to the order total (see calcOrderTotal)
  const unitCost   = withMarkup;

  return {
    scale, quantity,
    materialName:       material.name,
    presupported,
    effectiveSupportPct,
    scaledVolumeMl,
    totalVolumeMl,
    scaledDims: {
      x: stlData.dimensions.x * scale,
      y: stlData.dimensions.y * scale,
      z: stlData.dimensions.z * scale,
    },
    resinCost, machineCost, baseCost,
    markupAmount:       withMarkup - baseCost,
    unitCost,
    totalCost:          unitCost * quantity,
    printHours,
  };
}

// ---- Assembly cost ---------------------------------------------------
// Joints = parts - 1. First joint costs assemblyBase, each extra costs assemblyPerJoint.
// Assembly only shown/charged when group has ≥ 2 parts AND assembly is toggled on.

export function calcAssemblyCost(partCount, config) {
  if (partCount <= 1) return 0;
  const joints    = partCount - 1;
  const firstJoint = config.assemblyBase;
  const extraJoints = Math.max(0, joints - 1) * config.assemblyPerJoint;
  return Math.min(firstJoint + extraJoints, config.assemblyMax);
}

// ---- Primer cost -----------------------------------------------------
// Material: flat £5 per model group.
// Labour: scales with surface area proxy → volume^(2/3), capped.
// This reflects that a bigger model needs more smoothing / filling work.

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

// ---- Group-level cost ------------------------------------------------
// totalVolumeMl = sum of each file's scaledVolumeMl × its quantity
// (represents the total resin printed for this model assembly)

export function calcGroupCost(items, groupSettings, config) {
  const readyItems = items.filter(i => i.status === 'ready' && i.cost);

  const fileSubtotal   = readyItems.reduce((s, i) => s + i.cost.totalCost, 0);
  const totalVolumeMl  = readyItems.reduce((s, i) => s + i.cost.scaledVolumeMl * i.settings.quantity, 0);
  const totalPartCount = readyItems.reduce((s, i) => s + i.settings.quantity, 0);

  const { assembly = false, primer = 'unprimed' } = groupSettings;

  const assemblyCost  = assembly ? calcAssemblyCost(totalPartCount, config) : 0;
  const primerResult  = calcPrimerCost(totalVolumeMl, primer, config);
  const labourBase    = config.labourBaseFee;

  // Labour surcharge for primer — already included in primerResult.labour
  // Labour surcharge for assembly — included in assemblyCost

  const groupTotal = fileSubtotal + assemblyCost + primerResult.total + labourBase;

  return {
    fileSubtotal,
    totalVolumeMl,
    totalPartCount,
    assemblyCost,
    primerMaterial:  primerResult.material,
    primerLabour:    primerResult.labour,
    primerTotal:     primerResult.total,
    labourBase,
    groupTotal,
    isPrimed:        primer !== 'unprimed',
    primerLabel:     primer,
  };
}

// ---- Order total -----------------------------------------------------
// config is optional — when supplied the minimum order floor is applied.

export function calcOrderTotal(groups, config) {
  const raw = groups.reduce((s, g) => s + (g.groupCost?.groupTotal ?? 0), 0);
  const floor = config?.minimumItemCost ?? 0;
  return floor > 0 ? Math.max(raw, floor) : raw;
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

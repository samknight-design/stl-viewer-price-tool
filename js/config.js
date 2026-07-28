// ============================================================
// config.js — Pricing configuration with localStorage persistence
// For Shopify: replace localStorage with Shopify metafields API
// ============================================================

const CONFIG_KEY = 'stl_calc_config_v1';

export const DEFAULT_CONFIG = {
  // --- Core resin pricing ---
  resinCostPerMl:      0.08,
  supportMaterial:     20,       // % extra volume for supports
  machineHourlyCost:   2.50,
  printSpeedMlPerHour: 15,
  markupPercentage:    40,
  minimumItemCost:     5.00,     // minimum per individual STL file

  // --- Labour (replaces handling fee) ---
  // Applied once per model group, scales up with finishing work
  labourBaseFee:       2.00,     // £ flat per model group

  // --- Assembly ---
  // Applied when a group has multiple parts and assembly is requested
  assemblyBase:        5.00,     // cost for joining 2 parts
  assemblyPerJoint:    3.50,     // cost per additional joint (3rd part, 4th, …)
  assemblyMax:         40.00,    // cap so large kits don't get absurd

  // --- Primer ---
  primerMaterialCost:       5.00,   // flat material cost per model (any primer colour)
  primerLabourMultiplier:   0.50,   // × volume^(2/3) → surface-area-based labour
  primerLabourMin:          1.50,   // minimum primer labour
  primerLabourMax:          12.00,  // cap on primer labour

  // --- Display ---
  currency:        'GBP',
  currencySymbol:  '£',
  businessName:    'Arcane Flame',
  businessEmail:   'orders@arcane-flame.com',
  showCostBreakdown: true,

  // --- Admin access (client-side only) ---
  adminPassword:   'admin123',

  // --- Materials ---
  materials: [
    { id: 'standard',  name: 'Standard Resin',  costPerMl: 0.08, color: '#b0c4de', description: 'Great for display models' },
    { id: 'tough',     name: 'Tough Resin',      costPerMl: 0.12, color: '#7ec8e3', description: 'Impact-resistant parts' },
    { id: 'flexible',  name: 'Flexible Resin',   costPerMl: 0.15, color: '#f0a830', description: 'Bendable / rubber-like' },
    { id: 'castable',  name: 'Castable Resin',   costPerMl: 0.28, color: '#ffd700', description: 'Lost-wax casting' },
    { id: 'dental',    name: 'Dental/Medical',   costPerMl: 0.35, color: '#e8d5c4', description: 'Biocompatible grade' },
  ],

  // --- Primer options (label only — cost controlled by fields above) ---
  primerOptions: [
    { id: 'unprimed', label: 'Unprimed' },
    { id: 'black',    label: 'Black Primer' },
    { id: 'grey',     label: 'Grey Primer' },
    { id: 'white',    label: 'White Primer' },
  ],
};

export function getConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      return {
        ...DEFAULT_CONFIG,
        ...saved,
        materials:     saved.materials?.length     ? saved.materials     : DEFAULT_CONFIG.materials,
        primerOptions: saved.primerOptions?.length  ? saved.primerOptions : DEFAULT_CONFIG.primerOptions,
      };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); return true; }
  catch (e) { console.error('Config save failed:', e); return false; }
}

export function resetConfig() {
  localStorage.removeItem(CONFIG_KEY);
  return { ...DEFAULT_CONFIG };
}

export function getMaterial(config, materialId) {
  return config.materials.find(m => m.id === materialId) ?? config.materials[0];
}

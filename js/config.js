// ============================================================
// config.js — Pricing configuration with localStorage persistence
// For Shopify: replace localStorage with Shopify metafields API
// ============================================================

const CONFIG_KEY = 'stl_calc_config_v1';

export const DEFAULT_CONFIG = {
  // --- Size tiers (resin) ---
  // A model's tier is decided by its LARGEST single scaled dimension (mm).
  // Ascending by maxDimensionMm. A model bigger than the last tier falls
  // back to the build-plate check (maxPlatePrice); if it doesn't fit the
  // plate either, it cannot be auto-priced at all.
  sizeTiers: [
    { name: 'XS',      maxDimensionMm: 15,  price: 1  },
    { name: 'Small',   maxDimensionMm: 30,  price: 3  },
    { name: 'Regular', maxDimensionMm: 50,  price: 6  },
    { name: 'Large',   maxDimensionMm: 100, price: 15 },
    { name: 'Large+',  maxDimensionMm: 120, price: 21 },
    { name: 'XL',      maxDimensionMm: 150, price: 30 },
    { name: 'XL+',     maxDimensionMm: 180, price: 45 },
  ],
  maxPlatePrice: 60,   // price for a model bigger than XL+ but still fits the build plate

  // --- Build plate (physical fit check) ---
  buildPlate: {
    x: 211.68, y: 118.37, z: 220,
    supportMarginPct: 20,   // usable space is reduced by this % to leave room for supports
  },

  // --- Assembly (unchanged) ---
  assemblyBase:        5.00,
  assemblyPerJoint:    3.50,
  assemblyMax:         40.00,

  // --- Primer (unchanged) ---
  primerMaterialCost:       5.00,
  primerLabourMultiplier:   0.50,
  primerLabourMin:          1.50,
  primerLabourMax:          12.00,

  // --- Resin material surcharges ---
  // % added on top of the tier price for non-standard resins.
  materialSurcharges: {
    standard: 0,
    tough:    15,
    flexible: 20,
    castable: 25,
    dental:   35,
  },

  // --- Extras (flat, fixed-price add-ons, available on every model) ---
  extras: [
    { id: 'wings',  name: 'Wings',          price: 3.00 },
    { id: 'weapon', name: 'Sword / Weapon', price: 1.50 },
    { id: 'shield', name: 'Shield',         price: 1.50 },
    { id: 'banner', name: 'Banner',         price: 2.50 },
  ],

  // --- Order guardrail ---
  customQuoteOrderThreshold: 150.00,

  // --- Support-fairness adjustment ---
  // Tier lookup is based on measured dimensions, but a "pre-supported" file's
  // own mesh already includes its support geometry (so its measured size is
  // honest), while a "standard" file is bare and gets supports added by us
  // afterwards — which grows its real printed footprint beyond what's in the
  // upload. Without correcting for this, uploading the same model without
  // supports would exploit a cheaper size tier. supportSizeInflationPct is
  // applied (for tier/build-plate purposes only, never to the displayed
  // print size) to a standard file's dimensions to estimate that growth.
  // unsupportedHandlingFee is a small flat fee on top, so a pre-supported
  // upload always comes out at least a little cheaper than an equivalent
  // standard one, even when both land in the same tier.
  supportSizeInflationPct: 8,
  unsupportedHandlingFee: 0.20,

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
    { id: 'standard',  name: 'Standard Resin',  color: '#b0c4de', description: 'Great for display models' },
    { id: 'tough',     name: 'Tough Resin',      color: '#7ec8e3', description: 'Impact-resistant parts' },
    { id: 'flexible',  name: 'Flexible Resin',   color: '#f0a830', description: 'Bendable / rubber-like' },
    { id: 'castable',  name: 'Castable Resin',   color: '#ffd700', description: 'Lost-wax casting' },
    { id: 'dental',    name: 'Dental/Medical',   color: '#e8d5c4', description: 'Biocompatible grade' },
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
        sizeTiers:     saved.sizeTiers?.length      ? saved.sizeTiers     : DEFAULT_CONFIG.sizeTiers,
        extras:        saved.extras?.length         ? saved.extras       : DEFAULT_CONFIG.extras,
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

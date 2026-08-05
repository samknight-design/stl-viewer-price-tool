// ============================================================
// config.js — Pricing configuration, backed by the Shopify relay
// (shop metafields via supabase/functions/shopify-relay). A localStorage
// cache is kept as a last-known-good fallback for when the relay is
// briefly unreachable — it is not the source of truth.
// ============================================================

const CONFIG_KEY = 'stl_calc_config_v1';
export const RELAY_BASE_URL = 'https://aqnpkvzycdjwbapfpvfl.supabase.co/functions/v1/shopify-relay';

export const DEFAULT_CONFIG = {
  // --- Size tiers (resin) ---
  // A model's tier is decided by the MEDIAN (second-largest) of its three
  // scaled dimensions, not the longest one — so a single thin protrusion
  // (a spear, sword, banner pole) sticking out on one axis doesn't alone
  // push a model into a much pricier tier than its actual bulk warrants.
  // The full 3D bounding box is still checked separately for physical
  // build-plate fit, so an oversized protrusion that genuinely won't fit
  // the printer is still caught.
  // Ascending by maxDimensionMm. A model bigger than the last tier falls
  // back to the build-plate check (maxPlatePrice); if it doesn't fit the
  // plate either, it cannot be auto-priced at all.
  //
  // 'Medium'/'Medium+' fill what used to be a single big 50→100mm jump
  // (£6 → £15, a 2.5x step) — that gap is exactly what caused a model
  // sitting right at the boundary to swing wildly in price between its
  // supported and unsupported version (the ~8% support-size inflation was
  // enough to tip it across the whole 50-100mm gap). 'XL'/'XL+'/'XXL' do
  // the same for the top of the ladder.
  //
  // IMPORTANT — the top of this ladder is bounded by physical reality, not
  // just choice: the tier-lookup dimension is the MEDIAN of a model's 3
  // scaled axes, and for a model to physically fit the build plate below
  // (any rotation), that median can never exceed the plate's own *middle*
  // usable axis — with the buildPlate values below that's
  // min(x,y,z-sorted)[1] * (1 - supportMarginPct/100) ≈ 169mm. A model can
  // still be much longer than that on its single longest axis (up to
  // ~176mm) or use the plate's full width/depth footprint — that's real,
  // and it's what makes a model expensive — but it can't happen on TWO
  // axes past ~169mm at once, so the median metric this ladder prices by
  // is hard-capped there regardless of how high we set maxDimensionMm.
  // The last tier below is deliberately set just under that real ceiling
  // so every step stays reachable; maxPlatePrice below covers the thin
  // sliver above it. If the build plate config is ever changed (bigger
  // printer), recalculate this ceiling and extend the ladder to match.
  sizeTiers: [
    { name: 'XS',      maxDimensionMm: 15,  price: 1  },
    { name: 'Small',   maxDimensionMm: 30,  price: 3  },
    { name: 'Regular', maxDimensionMm: 50,  price: 6  },
    { name: 'Medium',  maxDimensionMm: 65,  price: 9  },
    { name: 'Medium+', maxDimensionMm: 80,  price: 12 },
    { name: 'Large',   maxDimensionMm: 100, price: 15 },
    { name: 'Large+',  maxDimensionMm: 120, price: 21 },
    { name: 'XL',      maxDimensionMm: 130, price: 24 },
    { name: 'XL+',     maxDimensionMm: 145, price: 29 },
    { name: 'XXL',     maxDimensionMm: 158, price: 36 },
  ],
  // Note: tierBoundaryAllowanceMm (below) extends XXL's real reach to
  // ~163mm, leaving only a ~6mm sliver (163-169mm) where this actually
  // applies given the current build plate — that's expected, not a bug;
  // see the size-tier comment above.
  maxPlatePrice: 43,   // covers that sliver — a model bigger than every defined tier but still fits the plate

  // A model whose tier dimension is only a little over a tier's ceiling
  // still qualifies for that (cheaper) tier — avoids harsh price jumps for
  // models that just barely miss a boundary (e.g. 52mm vs a 50mm ceiling).
  tierBoundaryAllowanceMm: 5,

  // --- Build plate (physical fit check) ---
  buildPlate: {
    x: 211.68, y: 118.37, z: 220,
    supportMarginPct: 20,   // usable space is reduced by this % to leave room for supports
  },

  // --- Assembly (unchanged) ---
  assemblyBase:        5.00,
  assemblyPerJoint:    3.50,
  assemblyMax:         40.00,

  // --- Primer (volume-tiered) ---
  // Priced once per model group (not per part) from the combined volume
  // of all its parts — same ascending-ladder pattern as sizeTiers. A
  // model bigger than the last tier is capped at primerMaxPrice;
  // primerMinPrice floors the result either way.
  primerTiers: [
    { maxVolumeMl: 3,   price: 0.50  },
    { maxVolumeMl: 7,   price: 1.00  },
    { maxVolumeMl: 15,  price: 2.00  },
    { maxVolumeMl: 30,  price: 3.50  },
    { maxVolumeMl: 50,  price: 5.50  },
    { maxVolumeMl: 80,  price: 8.00  },
    { maxVolumeMl: 120, price: 11.00 },
    { maxVolumeMl: 180, price: 14.50 },
    { maxVolumeMl: 260, price: 18.00 },
  ],
  primerMinPrice: 0.50,
  primerMaxPrice: 20.00,

  // --- Resin material surcharges ---
  // % added on top of the tier price for non-standard resins.
  materialSurcharges: {
    standard: 0,
    tough:    15,
    flexible: 20,
    castable: 25,
    dental:   35,
  },

  // --- Print method (per model): Resin (size-tiered) vs PLA/FDM ---
  // FDM is priced purely by print volume (no size tiers, no support
  // handling fee — those are resin-specific), but IS still checked
  // against a build-plate fit (fdmBuildPlate below), since a print can
  // still be physically too big for the printer regardless of price model.
  fdm: {
    costPerMl: 0.12,
  },

  // Bambu Lab X1 Carbon's build volume is 256×256×256mm; usable space is
  // reduced by supportMarginPct to leave a safety margin (same mechanism
  // as the resin buildPlate below, just a flat 15% here rather than a
  // support-specific allowance).
  fdmBuildPlate: {
    x: 256, y: 256, z: 256,
    supportMarginPct: 15,
  },

  // PLA colours, loosely modelled on Bambu Lab's PLA range (Basic/Matte
  // for standard colours, Metal/Silk for metallic & pearlescent). 'tier'
  // drives the surcharge below — edit colours/tiers freely to match
  // actual stock. White/Black/Dark Grey are 'included' per the shop's
  // current filament stock. Colour is chosen per PART (not per model) —
  // each part prints in exactly one colour; this tool doesn't support
  // multi-colour/gradient printing on a single part (point customers to
  // request a custom quote for that instead).
  plaColors: [
    { id: 'white',       name: 'White',       hex: '#f2f2ee', tier: 'included' },
    { id: 'black',       name: 'Black',       hex: '#1c1c1c', tier: 'included' },
    { id: 'dark-grey',   name: 'Dark Grey',   hex: '#4d4d4d', tier: 'included' },
    { id: 'red',         name: 'Red',         hex: '#c0392b', tier: 'standard' },
    { id: 'orange',      name: 'Orange',      hex: '#e2711d', tier: 'standard' },
    { id: 'yellow',      name: 'Yellow',      hex: '#f0c414', tier: 'standard' },
    { id: 'green',       name: 'Green',       hex: '#1f8a3d', tier: 'standard' },
    { id: 'blue',        name: 'Blue',        hex: '#1a5fb4', tier: 'standard' },
    { id: 'purple',      name: 'Purple',      hex: '#7d3c98', tier: 'standard' },
    { id: 'pink',        name: 'Pink',        hex: '#e88ab0', tier: 'standard' },
    { id: 'brown',       name: 'Brown',       hex: '#6d4c33', tier: 'standard' },
    { id: 'gold',        name: 'Gold',        hex: '#cfa036', tier: 'metallic' },
    { id: 'silver',      name: 'Silver',      hex: '#b8bcc0', tier: 'metallic' },
    { id: 'copper',      name: 'Copper',      hex: '#b3673f', tier: 'metallic' },
    { id: 'pearl-white', name: 'Pearl White', hex: '#efe8df', tier: 'pearlescent' },
    { id: 'pearl-blue',  name: 'Pearl Blue',  hex: '#a9c3d6', tier: 'pearlescent' },
  ],
  // % added on top of a part's own PLA cost — scales with print size
  // instead of a flat fee (which overcharges small parts and undercharges
  // large ones).
  plaColorSurchargePct: {
    included:    0,
    standard:    10,
    metallic:    20,
    pearlescent: 20,
  },

  // --- Extras (flat, fixed-price add-ons, available on every model) ---
  extras: [
    { id: 'wings',  name: 'Wings',          price: 3.00 },
    { id: 'weapon', name: 'Sword / Weapon', price: 1.50 },
    { id: 'shield', name: 'Shield',         price: 1.50 },
    { id: 'banner', name: 'Banner',         price: 2.50 },
  ],

  // --- Order guardrails ---
  customQuoteOrderThreshold: 150.00,
  minimumOrderTotal:         5.00,   // whole-order floor; individual items can be cheaper than this

  // --- Support-fairness adjustment ---
  // Tier lookup is based on measured dimensions, but a "pre-supported" file's
  // own mesh already includes its support geometry (so its measured size is
  // honest), while a "standard" file is bare and gets supports added by us
  // afterwards — which grows its real printed footprint beyond what's in the
  // upload. Without correcting for this, uploading the same model without
  // supports would exploit a cheaper size tier. supportSizeInflationPct is
  // applied (for tier/build-plate purposes only, never to the displayed
  // print size) to a standard file's dimensions to estimate that growth.
  // supportHandlingFeePct is charged on top of a standard upload's tier
  // price (0 for pre-supported), so a pre-supported upload always comes out
  // a meaningful percentage cheaper than an equivalent standard one, even
  // when both land in the same tier.
  supportSizeInflationPct: 8,
  supportHandlingFeePct: 40,

  // --- Display ---
  currency:        'GBP',
  currencySymbol:  '£',
  businessName:    'Arcane Flame',
  businessEmail:   'orders@arcane-flame.com',
  showCostBreakdown: true,

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

/**
 * Fetch the current config plus where it actually came from. Most callers
 * just want the config (use getConfig() below) — this variant exists for
 * callers that need to know whether the relay was actually reached (e.g.
 * admin.js's password check, which must not silently save a stale/default
 * config back to the shop if the relay call fell back to cache/defaults).
 */
export async function getConfigWithSource() {
  try {
    const res = await fetch(`${RELAY_BASE_URL}/config`);
    if (res.ok) {
      const { config: saved } = await res.json();
      // A fresh shop's metafield is genuinely unset on first use — GET
      // /config correctly returns { config: null } with a 200 OK for that
      // case. That is NOT a failure to reach the relay, so source is still
      // 'relay' here (letting a fresh shop's admin pass the login check and
      // bootstrap their first config) — only fetch failures / non-ok
      // responses below fall back to 'cache'/'default'.
      if (saved) {
        const merged = {
          ...DEFAULT_CONFIG,
          ...saved,
          materials:     saved.materials?.length     ? saved.materials     : DEFAULT_CONFIG.materials,
          primerOptions: saved.primerOptions?.length  ? saved.primerOptions : DEFAULT_CONFIG.primerOptions,
          sizeTiers:     saved.sizeTiers?.length      ? saved.sizeTiers     : DEFAULT_CONFIG.sizeTiers,
          primerTiers:   saved.primerTiers?.length    ? saved.primerTiers   : DEFAULT_CONFIG.primerTiers,
          plaColors:     saved.plaColors?.length      ? saved.plaColors     : DEFAULT_CONFIG.plaColors,
          extras:        saved.extras?.length         ? saved.extras       : DEFAULT_CONFIG.extras,
        };
        // Cache locally so the calculator still works if the relay is briefly unreachable.
        try { localStorage.setItem(CONFIG_KEY, JSON.stringify(merged)); } catch { /* ignore */ }
        return { config: merged, source: 'relay' };
      }
      // Relay reached fine, nothing saved yet — use defaults but still
      // report 'relay' since we know for certain that's really the state.
      return { config: { ...DEFAULT_CONFIG }, source: 'relay' };
    }
  } catch { /* fall through to cache below */ }

  // Relay unreachable or errored — fall back to last-known-good cache, then defaults.
  try {
    const cached = localStorage.getItem(CONFIG_KEY);
    if (cached) return { config: { ...DEFAULT_CONFIG, ...JSON.parse(cached) }, source: 'cache' };
  } catch { /* ignore */ }
  return { config: { ...DEFAULT_CONFIG }, source: 'default' };
}

export async function getConfig() {
  const { config } = await getConfigWithSource();
  return config;
}

export async function saveConfig(config, adminPassword) {
  const res = await fetch(`${RELAY_BASE_URL}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
    body: JSON.stringify({ config }),
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error('Incorrect admin password.');
    throw new Error(`Save failed: HTTP ${res.status}`);
  }
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); } catch { /* ignore */ }
  return true;
}

export function getMaterial(config, materialId) {
  return config.materials.find(m => m.id === materialId) ?? config.materials[0];
}

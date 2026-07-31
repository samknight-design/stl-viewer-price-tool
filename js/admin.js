// ============================================================
// admin.js — Admin pricing configuration page
// ============================================================

import { getConfig, saveConfig, resetConfig, DEFAULT_CONFIG } from './config.js?v=6';
import { calcItemCost, fmt, fmtMl, fmtHours } from './calculator.js?v=6';

let config;

document.addEventListener('DOMContentLoaded', () => {
  // Simple password gate
  const stored = sessionStorage.getItem('admin_auth');
  if (!stored) {
    showAuthModal();
  } else {
    bootAdmin();
  }
});

// ---- Auth ------------------------------------------------------------

function showAuthModal() {
  document.getElementById('auth-overlay').style.display = 'flex';
  document.getElementById('auth-panel').style.display   = 'block';

  document.getElementById('auth-form').addEventListener('submit', e => {
    e.preventDefault();
    const pw = document.getElementById('auth-password').value;
    const cfg = getConfig();
    if (pw === cfg.adminPassword) {
      sessionStorage.setItem('admin_auth', '1');
      document.getElementById('auth-overlay').style.display = 'none';
      bootAdmin();
    } else {
      document.getElementById('auth-error').textContent = 'Incorrect password.';
    }
  });

  document.getElementById('auth-reset-btn')?.addEventListener('click', () => {
    if (!confirm('Reset admin password back to "admin123"?\n\nThis will not affect any other settings.')) return;
    try {
      const raw = localStorage.getItem('stl_calc_config_v1');
      const cfg = raw ? JSON.parse(raw) : {};
      cfg.adminPassword = 'admin123';
      localStorage.setItem('stl_calc_config_v1', JSON.stringify(cfg));
    } catch { /* ignore */ }
    const err = document.getElementById('auth-error');
    err.style.color = 'var(--green, #16a34a)';
    err.textContent = 'Password reset to "admin123". Enter it above to log in.';
    document.getElementById('auth-password').value = '';
    document.getElementById('auth-password').focus();
  });
}

function bootAdmin() {
  config = getConfig();
  renderForm();
  renderMaterials();
  updatePreview();
  setupEvents();
}

// ---- Form rendering --------------------------------------------------

function renderForm() {
  const f = id => document.getElementById(id);

  f('inp-resin-cost').value          = config.resinCostPerMl;
  f('inp-support').value             = config.supportMaterial;
  f('inp-machine-hourly').value      = config.machineHourlyCost;
  f('inp-print-speed').value         = config.printSpeedMlPerHour;
  f('inp-markup').value              = config.markupPercentage;
  f('inp-minimum').value             = config.minimumOrderTotal;
  f('inp-labour-base').value         = config.labourBaseFee;
  f('inp-currency-symbol').value     = config.currencySymbol;
  f('inp-biz-name').value            = config.businessName;
  f('inp-biz-email').value           = config.businessEmail;
  f('inp-admin-pw').value            = config.adminPassword;
  f('chk-show-breakdown').checked    = config.showCostBreakdown;

  // Assembly
  f('inp-assembly-base').value       = config.assemblyBase;
  f('inp-assembly-per-joint').value  = config.assemblyPerJoint;
  f('inp-assembly-max').value        = config.assemblyMax;

  // Primer
  f('inp-primer-min').value          = config.primerMinPrice;
  f('inp-primer-max').value          = config.primerMaxPrice;
}

// ---- Materials -------------------------------------------------------

function renderMaterials() {
  const list = document.getElementById('materials-list');
  list.innerHTML = config.materials.map((m, i) => `
    <div class="mat-row" data-idx="${i}">
      <input class="mat-name"  value="${esc(m.name)}"  placeholder="Material name"   title="Name">
      <div class="mat-cost-wrap">
        <span class="currency-prefix">${esc(config.currencySymbol)}</span>
        <input class="mat-cost" type="number" value="${m.costPerMl}" min="0" step="0.001" title="Cost per mL">
        <span class="cost-suffix">/mL</span>
      </div>
      <input class="mat-color" type="color" value="${m.color}" title="Swatch colour">
      <input class="mat-desc"  value="${esc(m.description || '')}" placeholder="Description" title="Description">
      <button class="btn btn-ghost btn-sm mat-del" data-idx="${i}" title="Remove material">✕</button>
    </div>`
  ).join('');

  list.querySelectorAll('.mat-del').forEach(btn =>
    btn.addEventListener('click', () => {
      config.materials.splice(parseInt(btn.dataset.idx), 1);
      renderMaterials();
      updatePreview();
    })
  );
}

function collectMaterials() {
  return [...document.querySelectorAll('.mat-row')].map(row => {
    const i = parseInt(row.dataset.idx);
    const existing = config.materials[i] || {};
    return {
      id:          existing.id || `mat_${Date.now()}_${i}`,
      name:        row.querySelector('.mat-name').value.trim() || 'Material',
      costPerMl:   parseFloat(row.querySelector('.mat-cost').value) || 0,
      color:       row.querySelector('.mat-color').value,
      description: row.querySelector('.mat-desc').value.trim(),
    };
  });
}

// ---- Events ----------------------------------------------------------

function setupEvents() {
  // Live preview on any input change
  document.getElementById('config-form').addEventListener('input', () => updatePreview());

  // Add material
  document.getElementById('add-material').addEventListener('click', () => {
    config.materials.push({ id: `mat_${Date.now()}`, name: 'New Material', costPerMl: 0.10, color: '#aabbcc', description: '' });
    renderMaterials();
    updatePreview();
  });

  // Save
  document.getElementById('save-btn').addEventListener('click', () => {
    collectForm();
    if (saveConfig(config)) {
      showToast('Settings saved ✓', 'success');
      renderForm();
      renderMaterials();
    } else {
      showToast('Save failed.', 'error');
    }
  });

  // Reset
  document.getElementById('reset-btn').addEventListener('click', () => {
    if (confirm('Reset all settings to defaults?')) {
      config = resetConfig();
      renderForm();
      renderMaterials();
      updatePreview();
      showToast('Reset to defaults.', 'info');
    }
  });

  // Export JSON (for Shopify metafield)
  document.getElementById('export-btn').addEventListener('click', () => {
    collectForm();
    const json = JSON.stringify(config, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = 'stl_calculator_config.json';
    a.click();
    showToast('Config exported as JSON.', 'info');
  });
}

function collectForm() {
  const num = (id, fallback) => { const v = parseFloat(document.getElementById(id)?.value); return isNaN(v) ? fallback : v; };
  const str = (id, fallback) => document.getElementById(id)?.value.trim() || fallback;

  config.resinCostPerMl         = num('inp-resin-cost',          DEFAULT_CONFIG.resinCostPerMl);
  config.supportMaterial        = num('inp-support',              DEFAULT_CONFIG.supportMaterial);
  config.machineHourlyCost      = num('inp-machine-hourly',       DEFAULT_CONFIG.machineHourlyCost);
  config.printSpeedMlPerHour    = num('inp-print-speed',          DEFAULT_CONFIG.printSpeedMlPerHour);
  config.markupPercentage       = num('inp-markup',               DEFAULT_CONFIG.markupPercentage);
  config.minimumOrderTotal      = num('inp-minimum',              DEFAULT_CONFIG.minimumOrderTotal);
  config.labourBaseFee          = num('inp-labour-base',          DEFAULT_CONFIG.labourBaseFee);
  config.currencySymbol         = str('inp-currency-symbol',      '£');
  config.businessName           = str('inp-biz-name',             DEFAULT_CONFIG.businessName);
  config.businessEmail          = str('inp-biz-email',            DEFAULT_CONFIG.businessEmail);
  config.adminPassword          = str('inp-admin-pw',             DEFAULT_CONFIG.adminPassword);
  config.showCostBreakdown      = document.getElementById('chk-show-breakdown')?.checked ?? true;

  // Assembly
  config.assemblyBase           = num('inp-assembly-base',        DEFAULT_CONFIG.assemblyBase);
  config.assemblyPerJoint       = num('inp-assembly-per-joint',   DEFAULT_CONFIG.assemblyPerJoint);
  config.assemblyMax            = num('inp-assembly-max',         DEFAULT_CONFIG.assemblyMax);

  // Primer
  config.primerMinPrice         = num('inp-primer-min',           DEFAULT_CONFIG.primerMinPrice);
  config.primerMaxPrice         = num('inp-primer-max',           DEFAULT_CONFIG.primerMaxPrice);

  config.materials              = collectMaterials();
}

// ---- Live preview ----------------------------------------------------

function updatePreview() {
  collectForm();
  const sym = config.currencySymbol;

  // Sample volumes to preview
  const samples = [
    { label: 'Small (5 mL)',   volumeMl: 5,   dimensions: { x:20, y:20, z:15 } },
    { label: 'Medium (25 mL)', volumeMl: 25,  dimensions: { x:50, y:50, z:30 } },
    { label: 'Large (100 mL)', volumeMl: 100, dimensions: { x:80, y:80, z:60 } },
  ];

  const tbody = document.getElementById('preview-tbody');
  try {
    tbody.innerHTML = samples.map(s => {
      const cost = calcItemCost(s, { scale: 1, quantity: 1, materialId: config.materials[0]?.id }, config);
      return `
        <tr>
          <td>${esc(s.label)}</td>
          <td>${fmtMl(s.volumeMl)}</td>
          <td colspan="6"><strong>${fmt(cost.unitCost, sym)}</strong> (${cost.tier ? esc(cost.tier.name) + ' tier' : 'no tier'})</td>
        </tr>`;
    }).join('');
  } catch (e) {
    console.warn('Preview unavailable:', e);
    tbody.innerHTML = `<tr><td colspan="8">Preview unavailable — pricing model has changed. This will be resolved when admin moves to Shopify.</td></tr>`;
  }
}

// ---- Utilities -------------------------------------------------------

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

let toastTimer;
function showToast(msg, type = 'info') {
  let toast = document.getElementById('toast');
  if (!toast) { toast = document.createElement('div'); toast.id = 'toast'; document.body.appendChild(toast); }
  toast.textContent = msg;
  toast.className   = `toast toast-${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

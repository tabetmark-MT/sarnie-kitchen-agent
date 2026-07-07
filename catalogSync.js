// Supplier/item catalogue sync — SARNIE OS (inventory app) is the SOURCE OF
// TRUTH for suppliers and their items; this pulls its catalogue and mirrors it
// into the kitchen app's supplier list. Reverse direction of the allergen
// bridge (there the kitchen is the source and SARNIE OS consumes).
//
// Merge rules (kitchen-side data is EHO evidence — protect it):
//   • Suppliers are matched by normalised name. Matched → products REPLACED
//     with the source list; certificates, contacts, approval number, delivery
//     days, notes and status are NEVER touched.
//   • Suppliers new at the source → created here (empty certificates).
//   • Suppliers that exist here but not at the source → left untouched.
//   • Empty/invalid source payload → sync ABORTS (never wipes the catalogue),
//     mirroring the backup empty-read guard.
//
// Config: SARNIE_CATALOG_URL / SARNIE_CATALOG_TOKEN env vars, falling back to
// `sarnie_catalog_url` / `sarnie_catalog_token` rows in app_settings — same
// pattern as the intel/allergen tokens, so it works without Render env changes.
import { supabase, getSetting, upsertSetting } from './supabase.js';

async function getConfig() {
  const url = process.env.SARNIE_CATALOG_URL || (await getSetting('sarnie_catalog_url'));
  const token = process.env.SARNIE_CATALOG_TOKEN || (await getSetting('sarnie_catalog_token'));
  return { url, token };
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Pure merge (exported for tests): applies the source catalogue to the kitchen
// supplier list IN PLACE per the rules above; returns the summary counters.
export function mergeCatalog(suppliers, src) {
  let updated = 0, added = 0, itemsTotal = 0;
  const changes = [];
  for (const s of src) {
    if (!s?.name) continue;
    const items = (Array.isArray(s.items) ? s.items : [])
      .filter((it) => it && it.name)
      .map((it) => ({
        id: it.code || it.id || `SRC-${norm(it.name).replace(/[^a-z0-9]+/g, '-')}`,
        name: String(it.name),
        category: it.category || 'Uncategorised',
        pack: it.pack || '',
      }));
    itemsTotal += items.length;
    const local = suppliers.find((x) => norm(x.name) === norm(s.name));
    if (local) {
      const before = JSON.stringify(local.products || []);
      local.products = items;               // source of truth for items
      if (s.category && !local.category) local.category = s.category;
      if (JSON.stringify(local.products) !== before) { updated++; changes.push(`${local.name}: ${items.length} items`); }
    } else {
      suppliers.push({
        id: `sup-${Date.now()}-${added}`,
        name: String(s.name),
        category: s.category || 'general',
        status: 'active',
        contactName: '', contactPhone: '', contactEmail: '', address: '',
        approvalNumber: '', deliveryDays: '', notes: 'Added by SARNIE OS catalogue sync.',
        products: items,
        certificates: [],
      });
      added++; changes.push(`NEW ${s.name}: ${items.length} items`);
    }
  }
  return { updated, added, itemsTotal, changes };
}

export async function syncSupplierCatalog() {
  const { url, token } = await getConfig();
  if (!url || !token) return { ok: false, reason: 'Catalog sync not configured (set sarnie_catalog_url + sarnie_catalog_token).' };

  // 1. Pull the source catalogue.
  let payload;
  try {
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return { ok: false, reason: `Source returned HTTP ${res.status}` };
    payload = await res.json();
  } catch (e) {
    return { ok: false, reason: `Could not reach SARNIE OS catalogue: ${e.message}` };
  }

  const src = Array.isArray(payload?.suppliers) ? payload.suppliers : null;
  if (!src || src.length === 0) {
    // Guard: an empty source must never wipe the kitchen catalogue.
    return { ok: false, aborted: true, reason: 'Source catalogue empty/invalid — sync aborted, kitchen catalogue preserved.' };
  }

  // 2. Load the kitchen's current suppliers.
  const { data: row, error } = await supabase.from('app_settings').select('value').eq('key', 'suppliers').maybeSingle();
  if (error) return { ok: false, reason: error.message };
  const suppliers = Array.isArray(row?.value) ? row.value : [];

  // 3. Merge (pure logic above — tested independently).
  const { updated, added, itemsTotal, changes } = mergeCatalog(suppliers, src);

  // 4. Write back only if something changed.
  if (updated || added) {
    const up = await supabase.from('app_settings').upsert(
      [{ key: 'suppliers', value: suppliers, updated_at: new Date().toISOString() }],
      { onConflict: 'key' },
    );
    if (up.error) return { ok: false, reason: up.error.message };
  }
  const summary = {
    ok: true, at: new Date().toISOString(),
    sourceSuppliers: src.length, itemsSeen: itemsTotal,
    suppliersUpdated: updated, suppliersAdded: added,
    unchanged: !updated && !added, changes: changes.slice(0, 20),
  };
  await upsertSetting('last_catalog_sync', summary);
  return summary;
}

// Supplier & item ingest — SARNIE OS (inventory app) is the SINGLE SOURCE OF
// TRUTH for suppliers and items. This app READS the feed and mirrors it into
// app_settings.suppliers (the list the delivery screens consume). Read-only:
// we NEVER write supplier/item data back — every edit happens in SARNIE OS.
//
// Feed: GET https://sarnie-inventory-app.vercel.app/api/suppliers
//   Authorization: Bearer <SUPPLIER_FEED_TOKEN>
//   { generatedAt, site, suppliers: [{ id, name, contactName, email, phone,
//     leadTimeDays, orderDays, deliveryDays, cutoffTime, minOrderValue,
//     paymentTerms, notes, items: [{ id, name, productCode, category,
//     baseUnit, packagings: [{ name, qtyInBase, priceExVat, preferred }] }] }] }
//
// Merge rules:
//   • Match on STABLE ids (names may change). Supplier: feed `id` slug vs local
//     `sourceId`; one-time fallback to normalised name so the pre-existing seed
//     suppliers ADOPT the feed slug instead of duplicating. Item: feed `id` (SS-xxx).
//   • Matched supplier → master fields (contact, lead time, order/delivery days,
//     etc.) and the full item list are REPLACED from the feed; certificates,
//     approvalNumber and status are kitchen-owned EHO data and are NEVER touched.
//   • New feed supplier → created (active, empty certificates).
//   • A feed-managed supplier (has sourceId) that DISAPPEARS from the feed →
//     DEACTIVATED (status:'inactive'), never deleted — history + certs preserved.
//   • Kitchen-only suppliers (no sourceId) → left untouched.
//   • Empty/invalid feed → sync ABORTS (never wipes the catalogue).
//
// Config: SUPPLIER_FEED_URL / SUPPLIER_FEED_TOKEN env vars, falling back to
// `sarnie_suppliers_url` / `sarnie_supplier_feed_token` app_settings rows — same
// pattern as the intel/allergen tokens, so it works before the Render env is set.
import { supabase, getSetting, upsertSetting } from './supabase.js';

const DEFAULT_URL = 'https://sarnie-inventory-app.vercel.app/api/suppliers';

async function getConfig() {
  const url = process.env.SUPPLIER_FEED_URL || (await getSetting('sarnie_suppliers_url')) || DEFAULT_URL;
  const token = process.env.SUPPLIER_FEED_TOKEN || (await getSetting('sarnie_supplier_feed_token'));
  return { url, token };
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Map one feed item → the product shape the delivery screen consumes. Keeps the
// stable id (SS-xxx) and name it reads, plus useful reference fields.
function mapItem(it) {
  const pkgs = Array.isArray(it.packagings) ? it.packagings : [];
  const preferred = pkgs.find((p) => p && p.preferred) || pkgs[0] || null;
  return {
    id: it.id || it.productCode || `SRC-${norm(it.name).replace(/[^a-z0-9]+/g, '-')}`,
    name: String(it.name || ''),
    code: it.productCode || '',
    category: it.category || 'Uncategorised',
    unit: it.baseUnit || '',
    pack: preferred ? preferred.name : '',
    packagings: pkgs,
  };
}

// Pure merge (exported for tests): applies the feed to the local supplier list
// IN PLACE per the rules above; returns summary counters.
export function mergeCatalog(suppliers, feed) {
  const bySourceId = new Map();
  const byName = new Map();
  for (const s of suppliers) {
    if (s.sourceId) bySourceId.set(s.sourceId, s);
    byName.set(norm(s.name), s);
  }

  const seen = new Set();
  let updated = 0, added = 0, deactivated = 0, itemsTotal = 0;
  const changes = [];

  for (const f of feed) {
    if (!f?.id || !f?.name) continue;
    const items = (Array.isArray(f.items) ? f.items : []).filter((it) => it && it.name).map(mapItem);
    itemsTotal += items.length;

    // id-first, then a one-time name fallback (adopts the feed slug thereafter).
    let local = bySourceId.get(f.id) || byName.get(norm(f.name));

    if (local) {
      seen.add(local);
      const before = JSON.stringify([local.products, local.name, local.category]);
      local.sourceId = f.id;                       // lock to the stable id
      local.name = String(f.name);                 // feed owns the name
      if (f.category) local.category = f.category;
      // Master (non-EHO) fields from the feed — safe to overwrite.
      local.contactName = f.contactName || local.contactName || '';
      local.contactEmail = f.email || local.contactEmail || '';
      local.contactPhone = f.phone || local.contactPhone || '';
      local.leadTimeDays = f.leadTimeDays ?? local.leadTimeDays;
      local.orderDays = f.orderDays || local.orderDays || '';
      local.deliveryDays = f.deliveryDays || local.deliveryDays || '';
      local.cutoffTime = f.cutoffTime || local.cutoffTime || '';
      local.minOrderValue = f.minOrderValue ?? local.minOrderValue;
      local.paymentTerms = f.paymentTerms || local.paymentTerms || '';
      local.products = items;                      // feed owns the item list
      if (local.status === 'inactive') local.status = 'active'; // re-appeared
      // certificates, approvalNumber, notes = kitchen EHO data — untouched.
      if (JSON.stringify([local.products, local.name, local.category]) !== before) {
        updated++; changes.push(`${local.name}: ${items.length} items`);
      }
    } else {
      const created = {
        id: `sup-${f.id}`,
        sourceId: f.id,
        name: String(f.name),
        category: f.category || 'general',
        status: 'active',
        contactName: f.contactName || '', contactEmail: f.email || '', contactPhone: f.phone || '',
        address: '', approvalNumber: '',
        leadTimeDays: f.leadTimeDays ?? null, orderDays: f.orderDays || '',
        deliveryDays: f.deliveryDays || '', cutoffTime: f.cutoffTime || '',
        minOrderValue: f.minOrderValue ?? null, paymentTerms: f.paymentTerms || '',
        notes: f.notes || 'Synced from SARNIE OS.',
        products: items,
        certificates: [],
      };
      suppliers.push(created); seen.add(created);
      added++; changes.push(`NEW ${created.name}: ${items.length} items`);
    }
  }

  // Deactivate feed-managed suppliers that vanished (keep kitchen-only ones).
  for (const s of suppliers) {
    if (s.sourceId && !seen.has(s) && s.status !== 'inactive') {
      s.status = 'inactive';
      deactivated++; changes.push(`DEACTIVATED ${s.name} (gone from feed)`);
    }
  }

  return { updated, added, deactivated, itemsTotal, changes };
}

export async function syncSupplierCatalog() {
  const { url, token } = await getConfig();
  if (!token) return { ok: false, reason: 'Supplier feed not configured (set SUPPLIER_FEED_TOKEN or sarnie_supplier_feed_token).' };

  // 1. Pull the feed (Bearer — keeps the token out of URLs/logs).
  let payload;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return { ok: false, reason: `Feed returned HTTP ${res.status}` };
    payload = await res.json();
  } catch (e) {
    return { ok: false, reason: `Could not reach SARNIE OS supplier feed: ${e.message}` };
  }

  const feed = Array.isArray(payload?.suppliers) ? payload.suppliers : null;
  if (!feed || feed.length === 0) {
    return { ok: false, aborted: true, reason: 'Feed empty/invalid — sync aborted, catalogue preserved.' };
  }

  // 2. Load current local suppliers.
  const { data: row, error } = await supabase.from('app_settings').select('value').eq('key', 'suppliers').maybeSingle();
  if (error) return { ok: false, reason: error.message };
  const suppliers = Array.isArray(row?.value) ? row.value : [];

  // 3. Merge (pure logic above — unit-tested).
  const { updated, added, deactivated, itemsTotal, changes } = mergeCatalog(suppliers, feed);

  // 4. Write back only on change.
  if (updated || added || deactivated) {
    const up = await supabase.from('app_settings').upsert(
      [{ key: 'suppliers', value: suppliers, updated_at: new Date().toISOString() }],
      { onConflict: 'key' },
    );
    if (up.error) return { ok: false, reason: up.error.message };
  }
  const summary = {
    ok: true, at: new Date().toISOString(), site: payload.site || null,
    feedSuppliers: feed.length, feedItems: itemsTotal,
    suppliersUpdated: updated, suppliersAdded: added, suppliersDeactivated: deactivated,
    unchanged: !updated && !added && !deactivated, changes: changes.slice(0, 30),
  };
  await upsertSetting('last_catalog_sync', summary);
  return summary;
}

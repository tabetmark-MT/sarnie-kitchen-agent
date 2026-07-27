// Ordering & stock brief from SARNIE OS (the source of truth for what needs ordering).
//
//   GET /api/intel/brief[?site=SS-ISL]
//   → { headline, lines[], ordering: { due[], missed[] },
//       stock: { atRisk[], unknownStock }, unscheduledSuppliers[] }
//
// Auth: INTEL_API_TOKEN on the SARNIE OS side — a DIFFERENT secret from the
// SUPPLIER_FEED_TOKEN behind /api/sales and /api/suppliers. Set SARNIE_INTEL_TOKEN
// (or the sarnie_intel_token app_settings row); do not reuse this app's own
// INTEL_API_TOKEN, which guards our snapshot for Cowork and is ours to rotate.
//
// WHY THIS EXISTS. The morning debrief is generated with no tools, so it cannot
// ask the costing brain anything — it can only be told. Without this it knew
// nothing about a cutoff closing tonight or a line about to run out, which is
// exactly the half of the day that is time-critical. SARNIE OS phrases the lines
// itself: it owns the interpretation of its own data, and we relay rather than
// re-derive, the same rule the recipe and allergen bridges follow.
import { getSetting } from './supabase.js';

const DEFAULT_URL = 'https://sarnie-inventory-app.vercel.app/api/intel/brief';

// Shorter than the sales TTL on purpose. Sales are settled history; a cutoff is a
// moving edge, and telling Mark at 14:20 that a 14:00 deadline is still open is
// the specific failure this feed exists to prevent.
const TTL_MS = 5 * 60 * 1000;
let cache = null;

export async function fetchBrief({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  try {
    const url = process.env.SARNIE_BRIEF_URL || (await getSetting('sarnie_brief_url')) || DEFAULT_URL;
    const token = process.env.SARNIE_INTEL_TOKEN || (await getSetting('sarnie_intel_token'));
    if (!token) return null;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cache = { at: Date.now(), data };
    return data;
  } catch (e) {
    console.error('[Brief] fetch failed:', e.message);
    // Serve a stale copy rather than nothing — an hour-old deadline list still
    // names the right supplier — but never invent one.
    return cache?.data ?? null;
  }
}

/** The ORDERING & STOCK block for the kitchen context. Never guesses. */
export async function buildOrderingBlock() {
  const b = await fetchBrief();
  if (!b) {
    return `\nORDERING & STOCK: not reachable right now — the SARNIE OS brief did not respond. ` +
      `If Mark asks what needs ordering or how much of something is left, say the inventory system is ` +
      `unavailable and he should check the Suggested order screen himself. Do NOT guess a stock level, ` +
      `a cover figure or an order deadline.`;
  }

  const due = b.ordering?.due ?? [];
  const missed = b.ordering?.missed ?? [];
  const atRisk = b.stock?.atRisk ?? [];

  const lines = [];
  for (const d of due) lines.push(`  • ${d.supplier} — order by ${d.orderBy} TODAY for delivery ${d.deliveryDate}. Still open.`);
  for (const m of missed) lines.push(`  • ${m.supplier} — today's ${m.orderBy} cutoff has PASSED. Next reachable delivery ${m.nextDeliveryDate ?? 'unknown'}.`);
  for (const r of atRisk) {
    lines.push(`  • ${r.product} — ${r.onHand}${r.unit} left, about ${r.coverDays} days' cover, ` +
      `next ${r.supplier} delivery ${r.arrivesInDays}d away. RUNS OUT FIRST.`);
  }

  // Two caveats that stop silence reading as reassurance. Uncounted items cannot be
  // assessed at all, and a supplier with no rhythm recorded has no deadline to miss
  // as far as this feed is concerned — neither is the same as "you're covered".
  const caveats = [];
  if (b.stock?.unknownStock > 0) {
    caveats.push(`  NOTE: ${b.stock.unknownStock} item(s) have never been counted, so their stock is unknown and NOT assessed above. "Nothing at risk" does not mean everything is covered.`);
  }
  const uns = b.unscheduledSuppliers ?? [];
  if (uns.length) {
    caveats.push(`  NOTE: no delivery rhythm recorded for ${uns.map(u => u.supplier).join(', ')} — ordered ad hoc, so no deadline is tracked for them.`);
  }

  return `
ORDERING & STOCK (live from SARNIE OS — the source of truth for stock and order deadlines):
  ${b.headline}
${lines.length ? lines.join('\n') : '  • Nothing needs ordering today.'}
${caveats.join('\n')}
  RULES: these deadlines are London time and already account for lead time and the days each
  supplier accepts orders. A PASSED cutoff cannot be rescued — say so plainly and give the next
  reachable date rather than implying he can still squeeze it in. Never invent a stock figure,
  a cover estimate or a deadline that is not listed above.`.trimEnd();
}

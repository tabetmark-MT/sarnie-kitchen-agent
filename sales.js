// Sales feed from SARNIE OS (the source of truth for revenue).
//
// SARNIE OS is building `GET /api/sales` to the spec below; until it exists this
// module simply returns null and the agent says nothing about sales rather than
// guessing. Never fabricate a revenue figure — a wrong sales number makes every
// labour-percentage downstream wrong too.
//
// Expected shape:
//   { days: [ { date: 'YYYY-MM-DD', gross: 420.20, net: 350.17, orders: 17 } ] }
// `date` (Europe/London) and `gross` are required; `net`/`orders` optional.
//
// Config: SALES_URL + SALES_TOKEN env, with app_settings fallback
// (sarnie_sales_url / sarnie_sales_token) so it can be switched on without a
// redeploy — same pattern as the costing brain.
import { getSetting } from './supabase.js';

const DEFAULT_URL = 'https://sarnie-inventory-app.vercel.app/api/sales';

let cache = null; // { at, data }
const TTL_MS = 10 * 60 * 1000;

// Returns { days:[...] } or null when the feed isn't configured/reachable.
export async function fetchSales({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  try {
    const url = process.env.SALES_URL || (await getSetting('sarnie_sales_url')) || DEFAULT_URL;
    const token = process.env.SALES_TOKEN || (await getSetting('sarnie_sales_token'));
    if (!token) return null; // not wired up yet — stay quiet

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const days = Array.isArray(json?.days) ? json.days : [];
    if (!days.length) return null;

    const data = { days: days.filter(d => d?.date && Number.isFinite(Number(d.gross))) };
    cache = { at: Date.now(), data };
    return data;
  } catch { return null; }
}

const gross = (d) => Number(d?.gross) || 0;

// Sum sales from a London date key (inclusive) to today.
export function sumFrom(days, fromKey) {
  return (days || []).filter(d => d.date >= fromKey)
    .reduce((s, d) => ({ gross: s.gross + gross(d), orders: s.orders + (Number(d.orders) || 0), n: s.n + 1 }),
      { gross: 0, orders: 0, n: 0 });
}

// Labour as a % of sales — the number that actually matters. Returns null when
// either side is missing or sales are zero (dividing by a closed day is noise).
export function labourPct(labourCost, salesGross) {
  if (!Number.isFinite(labourCost) || !Number.isFinite(salesGross) || salesGross <= 0) return null;
  return Math.round((labourCost / salesGross) * 1000) / 10;
}

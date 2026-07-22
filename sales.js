// Sales feed from SARNIE OS (the source of truth for revenue).
//
//   GET /api/sales[?from=YYYY-MM-DD&to=YYYY-MM-DD]
//   → { days: [ { date, gross, net, commission, orders, cancelled, closed,
//                 source, commissionEstimated } ] }
//
// Auth: the shared SUPPLIER_FEED_TOKEN (same one behind /api/suppliers and
// /api/recipes). Override with SALES_TOKEN / SALES_URL env or the
// sarnie_sales_token / sarnie_sales_url app_settings rows if that ever changes.
//
// Three rules from SARNIE OS that this module must not get wrong:
//  1. Divide labour by `net`, NOT `gross`. Gross includes Deliveroo's ~27%
//     commission, which never reaches us — using it flatters every ratio.
//  2. `closed: true` (Sunday) means labour ÷ sales is UNDEFINED, not zero.
//     Excluded from every total and average.
//  3. `closed: false` with `orders: 0` is a HOLE in their history (missing
//     upload), not a zero-sales day. Also excluded, and counted separately so
//     we can say how complete the picture is.
import { getSetting } from './supabase.js';

const DEFAULT_URL = 'https://sarnie-inventory-app.vercel.app/api/sales';
const SHARED_TOKEN = 'sarnie_supplier_feed_token'; // app_settings key

let cache = null;
const TTL_MS = 10 * 60 * 1000;

export async function fetchSales({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  try {
    const url = process.env.SALES_URL || (await getSetting('sarnie_sales_url')) || DEFAULT_URL;
    const token =
      process.env.SALES_TOKEN ||
      process.env.SUPPLIER_FEED_TOKEN ||
      (await getSetting('sarnie_sales_token')) ||
      (await getSetting(SHARED_TOKEN));
    if (!token) return null;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const days = Array.isArray(json?.days) ? json.days : [];
    if (!days.length) return null;

    const data = { days: days.filter(d => d?.date) };
    cache = { at: Date.now(), data };
    return data;
  } catch { return null; }
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Revenue that actually reaches us. Prefer `net`; if it's absent fall back to
// gross minus commission, and only then to gross (flagged by the caller).
export function netOf(d) {
  if (Number.isFinite(Number(d?.net))) return Number(d.net);
  if (Number.isFinite(Number(d?.gross)) && Number.isFinite(Number(d?.commission))) {
    return Number(d.gross) - Number(d.commission);
  }
  return num(d?.gross);
}

export const isClosed  = (d) => d?.closed === true;
// A day we'd normally trade but hold nothing for — a gap, not a zero.
export const isMissing = (d) => d?.closed === false && num(d?.orders) === 0;
export const isTrading = (d) => !isClosed(d) && !isMissing(d);
// Any day that actually took money. A "closed" Sunday can still carry a stray
// order (19 Jul 2026 did: 1 order, £21.05) — that revenue is real and must not
// vanish from a total just because the kitchen was nominally shut.
export const hasSales  = (d) => num(d?.orders) > 0 || netOf(d) > 0;

// Totals from a London date key (inclusive).
//   money  → every day that actually took sales, closed or not
//   counts → only proper open trading days, so averages aren't dragged down
export function sumFrom(days, fromKey) {
  const inRange = (days || []).filter(d => d.date >= fromKey);
  const earning = inRange.filter(hasSales);
  const trading = inRange.filter(isTrading);
  return {
    net:       earning.reduce((s, d) => s + netOf(d), 0),
    gross:     earning.reduce((s, d) => s + num(d.gross), 0),
    orders:    earning.reduce((s, d) => s + num(d.orders), 0),
    tradingDays: trading.length,
    closedDays:  inRange.filter(isClosed).length,
    missingDays: inRange.filter(isMissing).length,
    // Revenue taken on a nominally-closed day — worth knowing about, not hiding.
    closedDaySales: earning.filter(isClosed).reduce((s, d) => s + netOf(d), 0),
    estimated:   earning.some(d => d?.commissionEstimated === true),
  };
}

// Labour as a % of NET sales. null when either side is missing or there is no
// trading revenue to divide by.
export function labourPct(labourCost, netSales) {
  if (!Number.isFinite(labourCost) || !Number.isFinite(netSales) || netSales <= 0) return null;
  return Math.round((labourCost / netSales) * 1000) / 10;
}

export const fmtGBP = (n) => `£${(Math.round(n * 100) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

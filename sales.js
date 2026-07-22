// Sales feed from SARNIE OS (the source of truth for revenue).
//
//   GET /api/sales[?from=YYYY-MM-DD&to=YYYY-MM-DD]
//   → { coverage, days: [ { date, gross, net, commission, orders, cancelled,
//                           scheduledClosed, traded, closed (deprecated),
//                           source, commissionEstimated } ] }
//
// Auth: the shared SUPPLIER_FEED_TOKEN (same one behind /api/suppliers and
// /api/recipes). Override with SALES_TOKEN / SALES_URL env or the
// sarnie_sales_token / sarnie_sales_url app_settings rows.
//
// Semantics, after SARNIE OS split the old `closed` flag:
//   scheduledClosed — the rota says we don't trade (Sundays). Excluded from day
//                     counts and averages: labour ÷ sales is undefined, not zero.
//   traded          — money actually came in. Revenue counts whenever this is
//                     true, INCLUDING on a scheduledClosed day, so a genuine
//                     Sunday sale can never vanish.
//   neither         — a day we'd normally trade but hold no data for. A HOLE in
//                     their history, not a zero-sales day. Excluded from both.
//
// `closed` is kept as a deprecated fallback so an older payload still works.
import { getSetting } from './supabase.js';

const DEFAULT_URL = 'https://sarnie-inventory-app.vercel.app/api/sales';
const SHARED_TOKEN = 'sarnie_supplier_feed_token'; // app_settings key

// Reporting baseline: the date from which sales/labour reporting is considered
// clean and official. Aggregates never reach back before this once it has
// passed, so a patchy earlier period can't distort a trend. Overridable via
// SALES_BASELINE_DATE env or the sales_baseline_date app_settings row.
export const DEFAULT_BASELINE = '2026-08-01';

let cache = null;
const TTL_MS = 10 * 60 * 1000;

// A known problem with the upstream feed, if any. While this is set, the agent
// must not quote net revenue or any labour percentage derived from it — a wrong
// number is worse than no number, especially one that drives staffing decisions.
export async function getFeedIssue() {
  if (process.env.SALES_FEED_ISSUE) return process.env.SALES_FEED_ISSUE;
  return (await getSetting('sales_feed_issue')) || null;
}

// VAT rate applied to menu prices, used to convert Deliveroo's Total Order
// Value (which customers pay VAT-inclusive) into ex-VAT turnover — the
// standard denominator for a restaurant labour %. Configurable because not
// every line is standard-rated: hot food is 20% but cold takeaway is
// zero-rated, so a menu that shifts cold would need this revisited.
export async function getVatRate() {
  const v = process.env.SALES_VAT_RATE || (await getSetting('sales_vat_rate'));
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 1 ? n : 0.20;
}

// Turnover excluding VAT from a VAT-inclusive order value.
export const exVat = (orderValueIncVat, vatRate = 0.20) =>
  (Number(orderValueIncVat) || 0) / (1 + vatRate);

export async function getBaseline() {
  return process.env.SALES_BASELINE_DATE || (await getSetting('sales_baseline_date')) || DEFAULT_BASELINE;
}

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

    const data = { days: days.filter(d => d?.date), coverage: json.coverage || null };
    cache = { at: Date.now(), data };
    return data;
  } catch { return null; }
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Revenue that actually reaches us. Prefer `net`; fall back to gross minus
// commission, then gross.
export function netOf(d) {
  if (Number.isFinite(Number(d?.net))) return Number(d.net);
  if (Number.isFinite(Number(d?.gross)) && Number.isFinite(Number(d?.commission))) {
    return Number(d.gross) - Number(d.commission);
  }
  return num(d?.gross);
}

// Rota says we don't trade. New field, falling back to the deprecated one.
export const isScheduledClosed = (d) =>
  (typeof d?.scheduledClosed === 'boolean' ? d.scheduledClosed : d?.closed === true);

// Money actually came in. Trust the explicit flag; infer only if absent.
export const isTraded = (d) =>
  (typeof d?.traded === 'boolean' ? d.traded : (num(d?.orders) > 0 || netOf(d) > 0));

// A day we'd normally trade but hold nothing for — a gap, not a zero.
export const isMissing = (d) => !isScheduledClosed(d) && !isTraded(d);

// Counts toward day counts and averages: a normal open day that took money.
export const countsForAverage = (d) => isTraded(d) && !isScheduledClosed(d);

// Totals from a London date key (inclusive), clamped to the reporting baseline.
//   money  → every day that TRADED, including a traded scheduled-closed day
//   counts → open trading days only, so averages aren't dragged down
export function sumFrom(days, fromKey, baselineKey = null) {
  const from = baselineKey && baselineKey > fromKey ? baselineKey : fromKey;
  const inRange = (days || []).filter(d => d.date >= from);
  const earning = inRange.filter(isTraded);
  return {
    from,
    clampedToBaseline: !!(baselineKey && baselineKey > fromKey),
    net:       earning.reduce((s, d) => s + netOf(d), 0),
    // `gross` from the feed IS Deliveroo's Total Order Value — verified against
    // the 13-19 Jul remittance statement (343 orders, £7,268.90 vs £7,269.89).
    // This is the only revenue field we trust; the feed's `net` overstates the
    // actual payout by ~18% because it omits commission VAT and additional fees.
    gross:     earning.reduce((s, d) => s + num(d.gross), 0),
    orderValue: earning.reduce((s, d) => s + num(d.gross), 0),
    orders:    earning.reduce((s, d) => s + num(d.orders), 0),
    tradingDays: inRange.filter(countsForAverage).length,
    closedDays:  inRange.filter(isScheduledClosed).length,
    missingDays: inRange.filter(isMissing).length,
    // Revenue taken on a day the rota said we were shut — visible, not hidden.
    closedDaySales: earning.filter(isScheduledClosed).reduce((s, d) => s + netOf(d), 0),
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

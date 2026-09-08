// SARNIE OS intelligence feeds — the two OS endpoints the agent could not
// reach until 8 Sep 2026.
//
// The costing brain (/api/agent/chat) is excellent at what it covers: dish
// costing, ingredient prices, supplier spend, stock value. Tested against it
// directly, it returns an EMPTY reply for menu engineering ("best and worst
// performers by contribution") and for profit/P&L, and it cannot see the
// customer-quality data at all — asked about yesterday's ratings it reported
// "rating 0★" while the trading feed held 2 ratings, a 3.0 average, one low
// rating, a refund of £12.95 and a missing item. So these are real gaps, not
// prompt-tuning problems.
//
//   GET /api/intel/trading   — small (~1.3 KB). Per-day and per-hour revenue,
//                              orders, AOV, commission, cancellations, and the
//                              quality block: ratings, comments, refunds,
//                              missing/incorrect items. Cheap enough to sit in
//                              every data block.
//   GET /api/intel/snapshot  — large (~21 KB). Menu engineering by quadrant,
//                              contribution per dish, GP%, attach rates, loss
//                              makers, pricing suggestions. Tool-only: putting
//                              it in every message would cost more context than
//                              it earns.
//
// Auth: SARNIE_OS_INTEL_TOKEN (or INTEL_API_TOKEN) env, falling back to the
// sarnie_os_intel_token app_settings row — the same env-then-settings pattern
// as sales.js and the costing brain, so it works before Render env is set.
import { getSetting } from './supabase.js';

const BASE = 'https://sarnie-inventory-app.vercel.app/api/intel';
const TTL_MS = 10 * 60 * 1000;
const cache = new Map();

async function token() {
  return (
    process.env.SARNIE_OS_INTEL_TOKEN ||
    process.env.INTEL_API_TOKEN ||
    (await getSetting('sarnie_os_intel_token')) ||
    null
  );
}

async function get(path, { ttl = TTL_MS } = {}) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const t = await token();
  if (!t) return { ok: false, error: 'SARNIE OS intel token not configured (set SARNIE_OS_INTEL_TOKEN).' };
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { ok: false, error: `SARNIE OS intel returned HTTP ${res.status}` };
    const data = { ok: true, data: await res.json() };
    cache.set(path, { at: Date.now(), data });
    return data;
  } catch (e) {
    return { ok: false, error: `Could not reach SARNIE OS intel: ${e.message}` };
  }
}

export async function fetchTrading({ from, to } = {}) {
  const qs = from && to ? `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : '';
  return get(`/trading${qs}`);
}

export async function fetchMenuIntel() {
  return get('/snapshot', { ttl: 60 * 60 * 1000 }); // menu mix moves slowly
}

const gbp = (n) => `£${(Number(n) || 0).toFixed(2)}`;
const pct = (n) => `${(Number(n) * 100).toFixed(1)}%`;

// Compact enough for every message. Deliberately excludes revenue totals — the
// SALES block already owns those and two revenue figures in one prompt is how
// an agent ends up quoting the wrong one.
export function tradingQualityBlock(res) {
  if (!res?.ok) return `\nCUSTOMER QUALITY (SARNIE OS): unavailable — ${res?.error || 'no data'}.`;
  const d = res.data || {};
  const q = d.quality || {};
  const t = d.trading || {};
  const day = d.range?.from === d.range?.to ? d.range?.from : `${d.range?.from}–${d.range?.to}`;
  const hours = (d.perHour || [])
    .slice()
    .sort((a, b) => (b.revenue || 0) - (a.revenue || 0))
    .slice(0, 3)
    .map((h) => `${String(h.hour).padStart(2, '0')}:00 ${gbp(h.revenue)} (${h.orders})`)
    .join(', ');
  const comments = (q.comments || [])
    .slice(0, 3)
    .map((c) => `${c.stars}★ "${String(c.comment || '').slice(0, 160)}"`)
    .join(' | ');
  const issues = (q.topIssueItems || []).slice(0, 4).map((i) => i.name || i.item || i).join(', ');
  return `\nCUSTOMER QUALITY & TRADING DETAIL (SARNIE OS, ${day} — the ONLY source for ratings, refunds and hourly split):
  Ratings: ${q.ratings ?? 0} left${q.ratings ? `, average ${q.avgRating}★, ${q.lowRatings ?? 0} low (≤3★)` : ''}. Refunds: ${q.refunds ?? 0}${q.refundPaidByUs ? ` (${gbp(q.refundPaidByUs)} paid by US)` : ''}. Missing items: ${q.missingItems ?? 0} · Incorrect: ${q.incorrectItems ?? 0}.
  Orders ${t.orders ?? 0} · AOV ${gbp(t.aov)} · cancelled ${t.cancelled ?? 0}${t.cancelledValue ? ` (${gbp(t.cancelledValue)})` : ''} · Deliveroo commission ${gbp(t.commission)} (${t.commissionPct}%).
  Busiest hours: ${hours || 'n/a'}.${issues ? `\n  Most-complained items: ${issues}.` : ''}${comments ? `\n  Recent comments: ${comments}` : ''}
  RULES: a rating average from 1-2 ratings is not a trend — say how many it is based on. "Paid by us" refunds are a real cost; Deliveroo-funded ones are not.`;
}

// Tool output. Trimmed hard: 19 dishes with 8 fields each would swamp the reply.
export function menuIntelSummary(res, { limit = 8 } = {}) {
  if (!res?.ok) return { ok: false, error: res?.error || 'no data' };
  const d = res.data || {};
  const k = d.kpis || {};
  const me = (d.menuEngineering || []).slice();
  const byContribution = me.slice().sort((a, b) => (b.totalContribution || 0) - (a.totalContribution || 0));
  const row = (i) => ({
    dish: i.name,
    quadrant: i.quadrant,
    units: i.units,
    mix: i.mixPct != null ? pct(i.mixPct) : null,
    plateCost: gbp(i.plateCost),
    sellPrice: gbp(i.sellPrice),
    gp: i.gpPct != null ? pct(i.gpPct) : null,
    contributionPerUnit: gbp(i.contributionPerUnit),
    totalContribution: gbp(i.totalContribution),
  });
  return {
    ok: true,
    range: d.range,
    overall: {
      unitsSold: k.unitsSold,
      grossRevenue: gbp(k.grossRevenue),
      totalContribution: gbp(k.totalContribution),
      blendedGp: k.blendedGpPct != null ? pct(k.blendedGpPct) : null,
      avgFoodCost: k.avgFoodCostPct != null ? pct(k.avgFoodCostPct) : null,
    },
    topByContribution: byContribution.slice(0, limit).map(row),
    bottomByContribution: byContribution.slice(-limit).reverse().map(row),
    quadrantCounts: me.reduce((a, i) => ((a[i.quadrant] = (a[i.quadrant] || 0) + 1), a), {}),
    lossMakers: (d.attachRates?.lossMakers || []).slice(0, limit),
    pricingSuggestions: (d.pricing || []).slice(0, limit),
    note: 'Menu engineering from SARNIE OS. Quadrants: Star = high margin + high volume, Plowhorse = high volume low margin, Puzzle = high margin low volume, Dog = neither. Contribution is per-unit margin x units, the figure that actually pays the rent.',
  };
}

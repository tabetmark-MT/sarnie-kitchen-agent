// Watcher 2 — the checks the flag feed cannot make.
//
// DIVISION OF LABOUR, and it matters. `/api/compliance` is the kitchen app's own
// compliance verdict: what is due, what is overdue, deep clean, probe, allergen
// review. This watcher does NOT recompute any of that. It reads the bridge and
// relays it.
//
// SARNIE OS put the reason better than I can: two apps deciding the same thing
// separately disagree within a month. The deep-clean state in particular is
// already structured data on the bridge (`periodic`, shipped 21 Sep) with
// required/done/overdue per week — re-deriving it from `completions` here would
// create a second source of truth for the number that decides a £20 bonus.
//
// What IS new here is TIMING, which no flag covers and the bridge does not model:
//   - hot-holding logged 1.65 times a day against a 4-a-day requirement, so the
//     gaps matter more than the count;
//   - whether the closing checklist was signed at a plausible hour.
// Those two read `completions` directly, and nothing else does.
import { getCompletionsRange, getComplianceSnapshot, getWatchState, setWatchState, markRun } from './supabase.js';

const LDN = 'Europe/London';
const ldnDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: LDN });
const ldnTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: LDN, hour: '2-digit', minute: '2-digit' });
const ldnMins = (d = new Date()) => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: LDN, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return Number(p.hour) * 60 + Number(p.minute);
};
const minsOf = (iso) => ldnMins(new Date(iso));

const WINDOW_OPEN  = 11 * 60;          // 11:00
const WINDOW_CLOSE = 22 * 60 + 30;     // 22:30

// CALIBRATION — read this before changing a number.
//
// The runbook proposed flagging any closing signed before 21:30, on the basis
// that closings average 19:36 with none after 21:00. The data says otherwise:
// across 69 August closings the average is 21:15, and across 17 September ones
// it is 21:38, with exactly one before 21:00 all month. The 19:36 figure is not
// in the record.
//
// More importantly, shifts now END at 21:15 — Mark moved them from 22:00. So a
// closing clean signed at 21:10 is somebody doing it properly on their way out,
// and a 21:30 threshold would have fired on 3 of the last 14 nights, all of them
// legitimate. On a food-safety channel that is how alerts get muted.
//
// 20:30 is set well clear of normal behaviour: nothing in September comes near
// it, so a hit means the checklist really was signed hours before close.
const CLOSING_EARLY_BEFORE = 20 * 60 + 30;   // 20:30
const HOTHOLD_GAP_HOURS    = 2;
const HOTHOLD_FROM         = 12 * 60;
const HOTHOLD_TO           = 21 * 60;
const CLOSING_DUE_AT       = 22 * 60 + 15;   // 22:15
const OPENING_DUE_AT       = 11 * 60 + 30;   // 11:30

export async function runComplianceWatch({ force = false } = {}) {
  const now = ldnMins();
  if (!force && (now < WINDOW_OPEN || now > WINDOW_CLOSE)) {
    return { skipped: `outside 11:00–22:30 London` };
  }

  const today = ldnDate();
  const state = await getWatchState('compliance_watch');
  const alerts = [];
  // One alert per check per day. Marked BEFORE sending would risk losing it on a
  // send failure, so the caller marks only what it actually delivered.
  const fired = (check) => !!state[`${check}:${today}`];

  const rows = await getCompletionsRange(2);
  const todays = rows.filter((r) => ldnDate(new Date(r.date)) === today);
  const newest = (cid, sid) => todays
    .filter((r) => r.checklist_id === cid && (!sid || r.section_id === sid))
    .sort((a, b) => new Date(b.date) - new Date(a.date))[0] || null;

  // ── 1. Hot-holding gap ──
  // Frequency is the exposure here: 1.65 logs a day against a 4-a-day rule.
  if (now >= HOTHOLD_FROM && now <= HOTHOLD_TO && !fired('hothold')) {
    const last = newest('hotholding');
    const gapH = last ? (Date.now() - new Date(last.date).getTime()) / 3600000 : null;
    if (!last) {
      alerts.push({ check: 'hothold', text: `No hot-holding temperature logged today. Required four times a day; the last one was yesterday.` });
    } else if (gapH > HOTHOLD_GAP_HOURS) {
      alerts.push({ check: 'hothold', text: `Hot-holding last logged at ${ldnTime(last.date)} — ${gapH.toFixed(1)}h ago. Due every 2h during service.` });
    }
  }

  // ── 2. Opening not logged ──
  if (now >= OPENING_DUE_AT && !fired('opening') && !newest('daily', 'opening')) {
    alerts.push({ check: 'opening', text: `Opening checklist not signed and the kitchen has been open since 10:00.` });
  }

  // ── 3. Closing not signed ──
  if (now >= CLOSING_DUE_AT && !fired('closing_missing') && !newest('daily', 'closing')) {
    alerts.push({ check: 'closing_missing', text: `Closing checklist not signed.` });
  }

  // ── 4. Closing signed implausibly early ──
  // Worded plainly on purpose: the record asserts end-of-day checks were done.
  const closing = newest('daily', 'closing');
  if (closing && !fired('closing_early') && minsOf(closing.date) < CLOSING_EARLY_BEFORE) {
    alerts.push({
      check: 'closing_early',
      text: `Closing checklist signed at <b>${ldnTime(closing.date)}</b>, hours before the kitchen closed. `
          + `It records that end-of-day checks were done — an EHO reads it the same way.`,
    });
  }

  // ── 5. Periodic tasks — RELAYED from the bridge, never recomputed ──
  // The app owns this verdict and SARNIE OS scores the bonus off the same feed.
  const snap = await getComplianceSnapshot();
  if (snap && Array.isArray(snap.periodic)) {
    for (const p of snap.periodic) {
      if (!p.required || !p.overdue) continue;
      if (fired(`periodic_${p.key}`)) continue;
      alerts.push({ check: `periodic_${p.key}`, text: `<b>${p.label}</b> was not done — the ${p.cadence === 'weekly' ? 'week' : 'month'} ending ${p.periodEnd} closed without it.` });
    }
  }

  await markRun('compliance_watch');
  return { ok: true, alerts, today, state, bridgeReachable: !!snap };
}

// Called by the sender once a message is actually delivered, so a Telegram
// failure does not silently consume the day's only alert.
export async function markComplianceAlerted(state, today, checks) {
  for (const c of checks) state[`${c}:${today}`] = new Date().toISOString();
  await setWatchState('compliance_watch', state);
}

export function formatComplianceWatch(r) {
  if (!r?.alerts?.length) return null;
  const lines = ['⚠️ <b>Compliance</b>', ''];
  for (const a of r.alerts) lines.push(`• ${a.text}`);
  return lines.join('\n');
}

// Weekly scorecard for the Monday heartbeat — the trend, not the incident.
export async function complianceScorecard(days = 7) {
  const rows = await getCompletionsRange(days);
  const byDay = new Set(rows.map((r) => ldnDate(new Date(r.date))));
  const count = (cid, sid) => rows.filter((r) => r.checklist_id === cid && (!sid || r.section_id === sid)).length;
  const tradingDays = byDay.size || 1;
  return {
    days,
    tradingDays,
    opening: count('daily', 'opening'),
    closing: count('daily', 'closing'),
    hotholdingPerDay: Math.round((count('hotholding') / tradingDays) * 100) / 100,
    cookchill: count('cookchill'),
    deepClean: count('weekly'),
  };
}

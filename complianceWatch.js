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
//   - a same-day nudge while there is still time to log hot-holding and the
//     service temperature round (the bridge only judges them after close);
//   - whether the closing checklist was signed at a plausible hour.
// Those read `completions` directly, and nothing else does.
//
// THE RULE (Mark, 26 Sep 2026): an open day needs at least ONE hot-holding log
// and THREE temperature rounds — opening, service, closing, every fridge each.
// Earlier versions of this file said "four times a day" and alerted on 2-hour
// gaps; that was never the kitchen's rule and it is gone.
//
// CLOSED DAYS: it reads the roster (schedule.<weekday>.open + schedule.closures)
// the same way the kitchen app does. On Sunday 27 Sep 2026 it sent "opening
// checklist not signed" and "no hot-holding" with the kitchen shut, because it
// never looked. A closed day now sends nothing.
import { getCompletionsRange, getComplianceSnapshot, getWatchState, setWatchState, markRun, getSetting } from './supabase.js';

const LDN = 'Europe/London';
const ldnDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: LDN });
const ldnTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: LDN, hour: '2-digit', minute: '2-digit' });
const ldnMins = (d = new Date()) => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: LDN, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return Number(p.hour) * 60 + Number(p.minute);
};
const minsOf = (iso) => ldnMins(new Date(iso));
const ldnDay = (iso) => new Date(iso).toLocaleDateString('en-GB', { timeZone: LDN, weekday: 'short', day: 'numeric', month: 'short' });

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
// Same-day nudges, once each, while there is still time before close.
const NUDGE_AT             = 18 * 60;        // 18:00
const OPENING_GRACE        = 60;             // matches the kitchen app's compliance feed
const CLOSING_GRACE        = 45;             // close 21:30 -> due 22:15, as before
const FRIDGE_UNITS = {
  'd-o-3': 1, 'd-c-11c': 1, 'd-d-f1': 1,
  'd-o-2': 2, 'd-c-11b': 2, 'd-d-f2': 2,
  'd-o-4': 3, 'd-c-11d': 3, 'd-d-f3': 3,
  'd-o-1': 4, 'd-c-11a': 4, 'd-d-f4': 4,
};
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const hhmm = (v, fb) => { const [h, m] = String(v || fb).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const fmt = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

// Today's roster, read exactly as the kitchen app reads it. `null` schedule =
// unknown: treated as open, the old behaviour, rather than silencing alerts.
async function todaysHours(today) {
  const sched = await getSetting('schedule').catch(() => null);
  if (!sched || typeof sched !== 'object') return { open: true, openAt: 10 * 60, closeAt: 21 * 60 + 30, known: false };
  const wd = WEEKDAYS[new Date(`${today}T12:00:00Z`).getUTCDay()];
  const cfg = sched[wd] || {};
  const closed = Array.isArray(sched.closures) && sched.closures.some((x) => (x?.date || x) === today);
  return { open: cfg.open !== false && !closed, openAt: hhmm(cfg.openTime, '10:00'), closeAt: hhmm(cfg.closeTime, '21:30'), known: true };
}

export async function runComplianceWatch({ force = false } = {}) {
  const now = ldnMins();
  if (!force && (now < WINDOW_OPEN || now > WINDOW_CLOSE)) {
    return { skipped: `outside 11:00–22:30 London` };
  }

  const today = ldnDate();
  const hours = await todaysHours(today);
  if (!hours.open) {
    // Still a successful run — the Monday heartbeat must not read a closed
    // Sunday as the watcher having stopped.
    await markRun('compliance_watch');
    return { skipped: 'kitchen closed today (roster)' };
  }
  const OPENING_DUE_AT = hours.openAt + OPENING_GRACE;
  const CLOSING_DUE_AT = hours.closeAt + CLOSING_GRACE;
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

  // ── 0. Hot-holding board ──
  // A log is only written when a board item is CLOSED. Readings on the board
  // today are real hot holding even before that, so they satisfy the nudge;
  // and an item left open overnight is itself the problem to flag — on 29 Sep
  // 2026 Beef sat open with three good readings and the day had no log.
  const board = await getSetting('hh_board').catch(() => null);
  const items = Array.isArray(board) ? board : [];
  const readToday = items.some((it) => (it.readings || []).some((r) => r?.time && ldnDate(new Date(r.time)) === today));
  const staleOpen = items.filter((it) => !it.outcome && it.startTime && ldnDate(new Date(it.startTime)) < today);
  if (staleOpen.length && !fired('hh_open')) {
    const list = staleOpen.map((it) => `${String(it.foodItem || 'item').trim()}${it.batchNumber ? ` (batch ${it.batchNumber})` : ''}, started ${ldnDay(it.startTime)} ${ldnTime(it.startTime)}`).join('; ');
    alerts.push({ check: 'hh_open', text: `Still open on the hot-holding board: ${list}. Close it as served or discarded — until it is closed it is not recorded as a hot-holding log.` });
  }

  // ── 1. Hot-holding: at least one before close ──
  if (now >= NUDGE_AT && now < hours.closeAt && !fired('hothold') && !newest('hotholding') && !readToday) {
    alerts.push({ check: 'hothold', text: `No hot-holding log yet today. At least one is required before close (${fmt(hours.closeAt)}), or today is not all-clear.` });
  }

  // ── 1b. Service temperature round — one of the three required ──
  const fullRound = (r) => new Set(Object.entries(r?.temperatures || {})
    .filter(([tid, v]) => FRIDGE_UNITS[tid] && v !== '' && v != null && !isNaN(parseFloat(v)))
    .map(([tid]) => FRIDGE_UNITS[tid])).size === 4;
  const serviceDone = todays.some((r) => r.checklist_id === 'daily' && r.section_id === 'during' && fullRound(r));
  if (now >= NUDGE_AT && now < hours.closeAt && !fired('service_round') && !serviceDone) {
    alerts.push({ check: 'service_round', text: `Service temperature round not logged yet (all 4 fridges, in the During Service clean). It is one of the 3 rounds required today.` });
  }

  // ── 2. Opening not logged ──
  if (now >= OPENING_DUE_AT && !fired('opening') && !newest('daily', 'opening')) {
    alerts.push({ check: 'opening', text: `Opening checklist not signed and the kitchen has been open since ${fmt(hours.openAt)}.` });
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
  const at = new Date().toLocaleTimeString('en-GB', { timeZone: LDN, hour: '2-digit', minute: '2-digit' });
  lines.push('', `<i>Source: kitchen checklists · hot-holding board · opening hours — checked ${at}</i>`);
  return lines.join('\n');
}

// Weekly scorecard for the Monday heartbeat — the trend, not the incident.
const RULE_FROM = '2026-09-26';   // hot-holding + 3 rounds mandatory from this day

export async function complianceScorecard(days = 7) {
  const rows = await getCompletionsRange(days);
  const today = ldnDate();
  const dayKeys = [...new Set(rows.map((r) => ldnDate(new Date(r.date))))];
  const count = (cid, sid) => rows.filter((r) => r.checklist_id === cid && (!sid || r.section_id === sid)).length;
  const tradingDays = dayKeys.length || 1;
  // Finished trading days under the new rule — today is still in progress.
  const ruled = dayKeys.filter((k) => k >= RULE_FROM && k < today);
  const board = await getSetting('hh_board').catch(() => null);
  const boardDays = new Set((Array.isArray(board) ? board : []).flatMap((it) => (it.readings || [])
    .filter((r) => r?.time && Number(r.temp) >= 63).map((r) => ldnDate(new Date(r.time)))));
  const onDay = (k) => rows.filter((r) => ldnDate(new Date(r.date)) === k);
  const roundsOn = (k) => new Set(onDay(k).filter((r) => r.checklist_id === 'daily' && new Set(Object.entries(r.temperatures || {})
    .filter(([tid, v]) => FRIDGE_UNITS[tid] && v !== '' && v != null && !isNaN(parseFloat(v))).map(([tid]) => FRIDGE_UNITS[tid])).size === 4)
    .map((r) => r.section_id)).size;
  return {
    days,
    tradingDays,
    opening: count('daily', 'opening'),
    closing: count('daily', 'closing'),
    hotholdingPerDay: Math.round((count('hotholding') / tradingDays) * 100) / 100,
    ruledDays: ruled.length,
    // Same evidence as the kitchen app's verdict: a closed log OR a probe
    // reading on the board that day (an item left open still has readings).
    hotholdingDaysMet: ruled.filter((k) => onDay(k).some((r) => r.checklist_id === 'hotholding')
      || boardDays.has(k)).length,
    roundsDaysMet: ruled.filter((k) => roundsOn(k) >= 3).length,
    cookchill: count('cookchill'),
    deepClean: count('weekly'),
  };
}

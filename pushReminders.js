// Server-sent reminders (30 Sep 2026). The same schedule the manager sets in
// the app (Settings → Reminders, app_settings.reminders_v2), sent as Web Push
// to every registered device — so a reminder arrives with the app closed.
//
// Rules, so every notification means something:
//  - London time, whatever timezone the server or device is in.
//  - Closed days (weekly pattern + schedule.closures): nothing is sent.
//  - Each reminder fires once a day. If the server was asleep at the exact
//    minute it still fires within CATCH_UP_MIN, never later — a 10:00 opening
//    reminder at 13:00 is noise, not help.
//  - Skipped when the job is already done: opening/closing clean signed,
//    weekly clean / monthly audit / probe calibration / allergen review done in
//    their period, or a hot-holding probe reading in the last hour.
import { getSiteSetting, getTradingSites, getCompletionsRange, getWatchState, setWatchState, markRun, HOME_SITE } from './supabase.js';
import { sendPush } from './push.js';

const LDN = 'Europe/London';
const CATCH_UP_MIN = 15;
const parts = (d = new Date()) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
  timeZone: LDN, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
}).formatToParts(d).map((p) => [p.type, p.value]));
const ldnDate = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: LDN });
const toMin = (hhmm) => { const [h, m] = String(hhmm || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

const META = {
  openingClean:     { title: '☀️ Opening clean due',       body: 'Start the opening kitchen checklist.', url: '/daily' },
  closingClean:     { title: '🌙 Closing clean due',       body: 'Start the closing checklist — all 4 fridge temperatures.', url: '/daily' },
  cookChill:        { title: '🧊 Cook-chill log',          body: 'Log the cook-chill record if batch cooking today.', url: '/cookchill' },
  hotHolding:       { title: '🌡️ Hot-holding probe due',   body: 'Probe everything on the hot-holding board (≥63°C). Discard anything held 4 hours.', url: '/hotholding', requireInteraction: true },
  deliveryLog:      { title: '🚚 Delivery log',            body: 'Check and log any deliveries received.', url: '/delivery/log' },
  weeklyClean:      { title: '🧹 Weekly deep clean due',   body: 'The weekly deep clean is due today.', url: '/weekly' },
  monthlyAudit:     { title: '🗓️ Monthly audit due',       body: 'The monthly cleaning audit is due today.', url: '/monthly' },
  probeCalibration: { title: '🌡️ Probe calibration due',   body: 'Two-point check this week: ice water and boiling water.', url: '/probe-calibration' },
  allergenReview:   { title: '🥜 Allergen review due',     body: 'The 4-weekly allergen review is due.', url: '/allergens/review' },
};

// Multi-site (K3): one pass per trading kitchen, each with its own schedule,
// reminders, records and devices. Islington's pass is the job as it was
// (same settings, same history key 'push_reminders', its devices only).
export async function runPushReminders({ now = new Date(), dryRun = false } = {}) {
  const sites = await getTradingSites();
  const results = {};
  for (const site of sites) {
    try { results[site] = await runForSite(site, { now, dryRun }); }
    catch (e) { results[site] = { error: String(e?.message || e) }; if (site === HOME_SITE) throw e; }
  }
  if (!dryRun) await markRun('push_reminders');
  return sites.length === 1 ? results[HOME_SITE] : results;
}

async function runForSite(site, { now, dryRun }) {
  const stateKey = site === HOME_SITE ? 'push_reminders' : `push_reminders_${site}`;
  const p = parts(now);
  const today = `${p.year}-${p.month}-${p.day}`;
  const nowMin = Number(p.hour) * 60 + Number(p.minute);
  const [r, sched] = await Promise.all([getSiteSetting(site, 'reminders_v2'), getSiteSetting(site, 'schedule')]);
  if (!r || typeof r !== 'object') return { skipped: 'no reminder schedule saved' };

  const wdLong = new Date(`${today}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toLowerCase();
  const closed = (Array.isArray(sched?.closures) && sched.closures.some((c) => (c?.date || c) === today))
    || (sched && sched[wdLong]?.open === false);
  if (closed) return { skipped: 'closed today' };

  // What is DUE in the catch-up window.
  const due = [];
  // One-off hours (schedule.specialHours[date], festive days 9 Nov 2026): the
  // opening/closing reminders move to that day's open/close, and nothing else
  // is sent outside those hours.
  const special = sched?.specialHours?.[today] || null;
  const at = (key, time, meta) => {
    const t = toMin(time);
    if (special && key !== 'openingClean' && key !== 'closingClean'
      && (t < toMin(special.openTime) || t > toMin(special.closeTime))) return;
    if (nowMin >= t && nowMin < t + CATCH_UP_MIN) due.push({ key: `${key}@${time}`, base: key, time, ...meta });
  };
  const day = Number(p.day);
  if (r.openingClean?.enabled) at('openingClean', special ? special.openTime : r.openingClean.time, META.openingClean);
  if (r.closingClean?.enabled) at('closingClean', special ? special.closeTime : r.closingClean.time, META.closingClean);
  if (r.cookChill?.enabled) at('cookChill', r.cookChill.time, META.cookChill);
  if (r.hotHolding?.enabled) (r.hotHolding.times || []).forEach((t) => at('hotHolding', t, META.hotHolding));
  if (r.deliveryLog?.enabled) (r.deliveryLog.times || []).forEach((t) => at('deliveryLog', t, META.deliveryLog));
  if (r.weeklyClean?.enabled && r.weeklyClean.day === p.weekday) at('weeklyClean', r.weeklyClean.time, META.weeklyClean);
  if (r.probeCalibration?.enabled && r.probeCalibration.day === p.weekday) at('probeCalibration', r.probeCalibration.time, META.probeCalibration);
  if (r.monthlyAudit?.enabled && Number(r.monthlyAudit.dayOfMonth) === day) at('monthlyAudit', r.monthlyAudit.time, META.monthlyAudit);
  if (r.allergenReview?.enabled && Number(r.allergenReview.dayOfMonth) === day) at('allergenReview', r.allergenReview.time, META.allergenReview);
  (r.custom || []).forEach((c) => {
    if (c?.enabled && (c.frequency !== 'Weekly' || c.day === p.weekday)) {
      at(`custom-${c.id || c.label}`, c.time, { title: `🔔 ${c.label}`, body: 'Scheduled reminder.', url: '/' });
    }
  });
  if (!due.length) return { ok: true, due: 0 };

  // Already done? (read only when something is due — most minutes nothing is)
  const state = await getWatchState(stateKey);
  const rows = await getCompletionsRange(31, site);
  const todays = rows.filter((c) => ldnDate(c.date) === today);
  const monIdx = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  const weekStart = ldnDate(new Date(new Date(`${today}T12:00:00Z`).getTime() - monIdx * 86400000));
  const inWeek = (c) => ldnDate(c.date) >= weekStart;
  const inMonth = (c) => ldnDate(c.date).slice(0, 7) === today.slice(0, 7);
  const board = (await getSiteSetting(site, 'hh_board')) || [];
  const cals = ((await getSiteSetting(site, 'probe_calibration')) || []).filter((e) => e?.kind === 'cal' && ldnDate(e.createdAt || e.date) >= weekStart && e.pass !== false);
  const done = {
    openingClean: todays.some((c) => c.checklist_id === 'daily' && c.section_id === 'opening'),
    closingClean: todays.some((c) => c.checklist_id === 'daily' && c.section_id === 'closing'),
    weeklyClean: rows.some((c) => c.checklist_id === 'weekly' && inWeek(c)),
    monthlyAudit: rows.some((c) => c.checklist_id === 'monthly' && inMonth(c)),
    probeCalibration: cals.some((e) => e.method === 'ice') && cals.some((e) => e.method === 'boil'),
    allergenReview: rows.some((c) => c.checklist_id === 'allergen_monthly' && (now - new Date(c.date)) < 28 * 86400000),
    hotHolding: (Array.isArray(board) ? board : []).some((it) => (it.readings || []).some((x) => x?.time && (now - new Date(x.time)) < 60 * 60000)),
  };

  const out = { ok: true, due: due.length, sent: [], skippedDone: [], alreadySent: [] };
  for (const d of due) {
    const mark = `${d.key}:${today}`;
    if (state[mark]) { out.alreadySent.push(d.key); continue; }
    if (done[d.base]) { out.skippedDone.push(d.key); state[mark] = 'done-already'; continue; }
    if (dryRun) { out.sent.push(d.key); continue; }
    const res = await sendPush({ title: d.title, body: d.body, url: d.url, tag: d.base, requireInteraction: !!d.requireInteraction }, { site });
    state[mark] = new Date().toISOString();
    out.sent.push({ key: d.key, devices: res.devices, ok: res.sent, failed: res.failed });
  }
  if (!dryRun) await setWatchState(stateKey, state);
  return out;
}

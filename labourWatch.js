// Labour band watch (Mark, 2 Nov 2026: "make sure our forecasting and target
// stay in the range 18–25"; widened to 18–28% the same evening). The band itself is read from the OS. Two jobs, both reading SARNIE OS's labour plan —
// the one projection both apps show (contract v2) — never a local estimate:
//
//  1. runLabourWatch() — from the day watch, hourly 11:00–22:00. Telegrams
//     Mark when the week's projection LEAVES the band (over → hours to cut and
//     who carries the most planned hours; under → hours available), and once
//     more when it comes back inside. Silent while nothing changes.
//  2. runClockInLabourPush() — every minute. When someone clocks IN while the
//     week is projected over the band, a push goes to manager/admin devices
//     only (never staff). At most one per hour, so a busy morning isn't a
//     stream of identical buzzes.
import { supabase, getSetting, getWatchState, setWatchState, markRun } from './supabase.js';
import { sendPush } from './push.js';

const OS_PLAN = 'https://sarnie-inventory-app.vercel.app/api/intel/labour-plan?site=SS-ISL';
let cache = { at: 0, plan: null };

export async function fetchLabourPlan({ maxAgeMs = 10 * 60000 } = {}) {
  if (cache.plan && Date.now() - cache.at < maxAgeMs) return cache.plan;
  const token = process.env.SUPPLIER_FEED_TOKEN || (await getSetting('sarnie_supplier_feed_token'));
  if (!token) throw new Error('labour plan token not configured');
  const r = await fetch(OS_PLAN, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`labour plan HTTP ${r.status}`);
  cache = { at: Date.now(), plan: await r.json() };
  return cache.plan;
}

const gbp = (n) => (Number.isFinite(n) ? `£${Math.round(n).toLocaleString('en-GB')}` : 'n/a');

async function topPlanned(plan, n = 3) {
  const staff = (await getSetting('employees')) || [];
  const nameOf = (ref) => (Array.isArray(staff) ? staff : []).find((e) => String(e.id) === String(ref))?.name || ref;
  return (plan.people || [])
    .filter((p) => Number(p.plannedHours) > 0)
    .sort((a, b) => b.plannedHours - a.plannedHours)
    .slice(0, n)
    .map((p) => `${nameOf(p.ref).split(' ')[0]} ${p.plannedHours}h`)
    .join(', ');
}

export async function runLabourWatch() {
  const plan = await fetchLabourPlan();
  const wk = plan.week?.id || 'week';
  const t = plan.target || {};
  const state = await getWatchState('labour_band');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const alerts = [];
  for (const [key, label] of [['onPace', 'On pace'], ['ifPlanned', 'If everyone works their plan']]) {
    const p = plan.projected?.[key];
    if (!p?.status) continue;
    const mark = `${wk}:${key}:${today}`;
    const prev = Object.entries(state).filter(([k]) => k.startsWith(`${wk}:${key}:`)).sort().pop()?.[1];
    if (prev === p.status) continue;                       // no change → silent
    if (!prev && p.status === 'within') { state[mark] = p.status; continue; }   // first look, all fine
    state[mark] = p.status;
    if (p.status === 'over') alerts.push(`🔴 <b>${label}: ${p.pct}%</b> — over the ${t.minPct}–${t.maxPct}% band. Cut <b>${p.hoursToCut}h</b> this week to get back to ${t.maxPct}%.`);
    else if (p.status === 'under') alerts.push(`🔵 <b>${label}: ${p.pct}%</b> — under ${t.minPct}%. <b>${p.hoursAvailable}h</b> still available inside the band.`);
    else alerts.push(`🟢 <b>${label}: ${p.pct}%</b> — back inside the ${t.minPct}–${t.maxPct}% band.`);
  }
  await setWatchState('labour_band', state);
  await markRun('labour_watch');
  if (!alerts.length) return { msg: null };
  const top = await topPlanned(plan);
  const b = plan.budget || {};
  return {
    msg: `👷 <b>Labour vs the ${t.minPct}–${t.maxPct}% band</b> · week ${String(wk).split('-W')[1] || wk}\n\n${alerts.join('\n')}\n\n` +
      `Budget to stay in band: ${gbp(b.atMin)}–${gbp(b.atMax)} (${b.hoursAtMin}–${b.hoursAtMax} paid hours).` +
      (top ? `\nMost planned hours: ${top}.` : ''),
  };
}

export async function runClockInLabourPush() {
  const state = await getWatchState('labour_clockin');
  const since = state.lastSeen || new Date(Date.now() - 2 * 60000).toISOString();
  const { data: rows, error } = await supabase.from('time_entries')
    .select('id,employee_name,clock_in').gt('clock_in', since).order('clock_in', { ascending: true }).limit(20);
  if (error) throw new Error(`time_entries read failed: ${error.message}`);
  if (!rows?.length) return { new: 0 };
  state.lastSeen = rows[rows.length - 1].clock_in;
  const out = { new: rows.length, pushed: false };
  const lastPush = state.lastPushAt ? Date.parse(state.lastPushAt) : 0;
  if (Date.now() - lastPush >= 60 * 60000) {
    const plan = await fetchLabourPlan();
    const p = plan.projected?.onPace;
    if (p?.status === 'over') {
      // Push subscriptions are keyed by auth user; the role lives in their
      // server-written app_metadata.
      const { data: list } = await supabase.auth.admin.listUsers({ perPage: 200 });
      const ids = (list?.users || []).filter((u) => ['admin', 'manager'].includes(u.app_metadata?.role)).map((u) => u.id);
      const who = rows.map((r) => (r.employee_name || '').split(' ')[0]).filter(Boolean).join(', ');
      for (const userId of ids) {
        await sendPush({
          title: `👷 Labour ${p.pct}% — over ${plan.target?.maxPct}%`,
          body: `${who} just clocked in. This week is projected over the band — cut ${p.hoursToCut}h to get back to ${plan.target?.maxPct}%.`,
          url: '/employees', tag: 'labour-band',
        }, { userId });
      }
      state.lastPushAt = new Date().toISOString();
      out.pushed = ids.length;
    }
  }
  await setWatchState('labour_clockin', state);
  return out;
}

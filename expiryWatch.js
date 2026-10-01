// Expiry nudges (1 Oct 2026, Mark). Warn BEFORE a visa or certificate lapses,
// not on the day: once at 30 days, once at 7 days, once when it has expired.
// Covers active staff only:
//   - right to work: a time-limited permission end date and its re-check date
//     (employee_hr), and the expiry on an uploaded right-to-work document
//   - Level 2 / Level 3 food hygiene and allergen certificates (their expiry)
// Each warning fires once per item per milestone (watch_state_expiry_watch).
import { supabase, getSetting, getWatchState, setWatchState, markRun } from './supabase.js';

const LDN = 'Europe/London';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: LDN });
const daysTo = (d) => Math.round((new Date(`${d}T12:00:00Z`) - new Date(`${today()}T12:00:00Z`)) / 86400000);
const fmt = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const LABEL = { l2_hygiene: 'Level 2 food hygiene', l3_hygiene: 'Level 3 food safety', allergen: 'Allergen training', rtw: 'Right-to-work document' };

export async function runExpiryWatch() {
  const [emps, hrRes] = await Promise.all([
    getSetting('employees'),
    supabase.from('employee_hr').select('employee_id,rtw_time_limited,rtw_expires,rtw_recheck_due'),
  ]);
  if (hrRes.error) throw new Error(`employee_hr read failed: ${hrRes.error.message}`);
  const hr = Object.fromEntries((hrRes.data || []).map((r) => [r.employee_id, r]));
  const items = [];
  for (const e of (Array.isArray(emps) ? emps : []).filter((x) => x && x.active !== false)) {
    const h = hr[e.id] || {};
    if (h.rtw_time_limited && h.rtw_expires) items.push({ id: `${e.id}:rtw_expires:${h.rtw_expires}`, who: e.name, what: 'Right to work (visa) ends', date: h.rtw_expires, legal: true });
    if (h.rtw_time_limited && h.rtw_recheck_due) items.push({ id: `${e.id}:rtw_recheck:${h.rtw_recheck_due}`, who: e.name, what: 'Right-to-work re-check due', date: h.rtw_recheck_due, legal: true });
    // Only the LATEST certificate of each type: an old expired one sitting next
    // to its renewal is history, not a lapse.
    const latest = {};
    for (const c of e.certs || []) {
      if (!c?.expiry || !LABEL[c.type]) continue;
      if (!latest[c.type] || c.expiry > latest[c.type].expiry) latest[c.type] = c;
    }
    for (const c of Object.values(latest)) {
      items.push({ id: `${e.id}:${c.type}:${c.expiry}`, who: e.name, what: `${LABEL[c.type]} expires`, date: c.expiry, legal: c.type === 'rtw' });
    }
  }

  const state = await getWatchState('expiry_watch');
  const alerts = [];
  for (const it of items) {
    const d = daysTo(it.date);
    const milestone = d < 0 ? 'expired' : d <= 7 ? '7d' : d <= 30 ? '30d' : null;
    if (!milestone) continue;
    const key = `${it.id}:${milestone}`;
    if (state[key]) continue;
    alerts.push({ key, text: milestone === 'expired'
      ? (/ due$/.test(it.what)
        ? `🔴 <b>${it.who}</b> — ${it.what.replace(/ due$/, '')} <b>OVERDUE</b> since ${fmt(it.date)}. Re-check now — they must not work on lapsed permission.`
        : `🔴 <b>${it.who}</b> — ${it.what.replace(/ (ends|expires)$/, '')} <b>EXPIRED</b> on ${fmt(it.date)}.${it.legal ? ' They must not work until it is re-checked — legal requirement.' : ' Renew it — it no longer counts as evidence.'}`)
      : `${milestone === '7d' ? '🟠' : '🟡'} <b>${it.who}</b> — ${it.what} on <b>${fmt(it.date)}</b> (${d} day${d === 1 ? '' : 's'}).${it.legal ? ' Arrange the re-check before then.' : ' Book the renewal.'}` });
  }
  await markRun('expiry_watch');
  return { ok: true, checked: items.length, alerts, state };
}

export async function markExpiryAlerted(state, keys) {
  const now = new Date().toISOString();
  for (const k of keys) {
    state[k] = now;
    // A later milestone covers the earlier ones, so they are never sent late.
    const base = k.replace(/:(30d|7d|expired)$/, '');
    if (k.endsWith(':7d')) state[`${base}:30d`] ||= now;
    if (k.endsWith(':expired')) { state[`${base}:30d`] ||= now; state[`${base}:7d`] ||= now; }
  }
  await setWatchState('expiry_watch', state, 3650);
}

export function formatExpiryWatch(r) {
  if (!r?.alerts?.length) return null;
  return ['📅 <b>Coming up — staff documents</b>', '', ...r.alerts.map((a) => `• ${a.text}`)].join('\n');
}

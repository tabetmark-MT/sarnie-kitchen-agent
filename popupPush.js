// Pop-up temperature check pushes (29 Oct 2026). Mark: checks every 2 hours
// through trading at off-site events. Hours come from SARNIE OS
// (/api/popups → hours: [{date, opens, closes}], London time) — the same slots
// the kitchen app's pop-up page shows (12:00, 14:00 … closing).
//
// Kept SEPARATE from the Deliveroo reminders: kitchen closed days don't stop
// these, and these never touch the kitchen checklists.
//  - Each slot fires once, within CATCH_UP_MIN of its time, never later.
//  - Skipped when a reading was already logged for the event from 15 min
//    before the slot onwards.
//  - The OS feed is read at most every 10 minutes.
import { supabase, getSetting, getWatchState, setWatchState, markRun } from './supabase.js';
import { sendPush } from './push.js';

const LDN = 'Europe/London';
const OS_POPUPS = 'https://sarnie-inventory-app.vercel.app/api/popups';
const SLOT_MIN = 120;
const CATCH_UP_MIN = 15;
const toMin = (hhmm) => { const [h, m] = String(hhmm || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

let cache = { at: 0, popups: [] };
async function popups() {
  if (Date.now() - cache.at < 10 * 60000) return cache.popups;
  const token = process.env.SUPPLIER_FEED_TOKEN || await getSetting('sarnie_supplier_feed_token');
  if (!token) throw new Error('pop-ups feed token not configured');
  const r = await fetch(OS_POPUPS, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`pop-ups feed HTTP ${r.status}`);
  const j = await r.json();
  cache = { at: Date.now(), popups: Array.isArray(j.popups) ? j.popups : [] };
  return cache.popups;
}

export function slotsFor(day) {
  const open = toMin(day.opens); const close = toMin(day.closes);
  const s = [];
  for (let m = open; m <= close; m += SLOT_MIN) s.push(m);
  if (s[s.length - 1] !== close) s.push(close);
  return s;
}

export async function runPopupPush({ now = new Date(), dryRun = false } = {}) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: LDN, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  const today = `${p.year}-${p.month}-${p.day}`;
  const nowMin = Number(p.hour) * 60 + Number(p.minute);

  const due = [];
  for (const ev of await popups()) {
    if (ev.status === 'cancelled' || ev.status === 'closed') continue;
    const day = (ev.hours || []).find((h) => h?.date === today && h.opens && h.closes);
    if (!day) continue;
    for (const m of slotsFor(day)) if (nowMin >= m && nowMin < m + CATCH_UP_MIN) due.push({ ev, m });
  }
  if (!due.length) { if (!dryRun) await markRun('popup_push'); return { ok: true, due: 0 }; }

  const state = await getWatchState('popup_push');
  const out = { ok: true, due: due.length, sent: [], skippedDone: [], alreadySent: [] };
  for (const { ev, m } of due) {
    const key = `${ev.id}@${hhmm(m)}:${today}`; // trailing date → setWatchState prunes it
    if (state[key]) { out.alreadySent.push(key); continue; }
    // Wall-clock London slot → instant: now minus the minutes elapsed since it.
    const slotAt = new Date(now.getTime() - (nowMin - m) * 60000);
    const { count, error } = await supabase.from('popup_temp_logs').select('id', { count: 'exact', head: true })
      .eq('event_id', ev.id).gte('ts', new Date(slotAt.getTime() - 15 * 60000).toISOString());
    if (error) throw new Error(`popup_temp_logs read failed: ${error.message}`);
    if (count > 0) { out.skippedDone.push(key); state[key] = 'done-already'; continue; }
    if (dryRun) { out.sent.push(key); continue; }
    const res = await sendPush({
      title: `🎪 ${hhmm(m)} pop-up temperature check`,
      body: `${ev.name}: probe the chicken and cauliflower and log it on the pop-up page.`,
      url: `/popups?id=${encodeURIComponent(ev.id)}`, tag: `popup-${ev.id}`, requireInteraction: true,
    });
    state[key] = new Date().toISOString();
    out.sent.push({ key, devices: res.devices, ok: res.sent, failed: res.failed });
  }
  if (!dryRun) { await setWatchState('popup_push', state); await markRun('popup_push'); }
  return out;
}

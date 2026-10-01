// Live hot-holding policy alerts, checked EVERY MINUTE (1 Oct 2026).
//
// Policy (FS-006 / Mark, 30 Sep 2026): probe every 2 hours, discard after 4
// hours total. These alerts used to ride on the hourly compliance watcher, so
// a warning could land up to an hour late: on 30 Sep Beef reached 4h at 20:40,
// the warning arrived 20:51, and it was closed as SERVED at 20:51. A warning
// after the deadline is a record of failure, not a control. Now:
//   - probe due   → the minute 2h passes since the last reading
//   - 15 min left → at 3h45, with the exact discard time
//   - discard now → the minute 4h is reached (also to Mark on Telegram)
// Each fires once per item (per reading, for probe-due). Items started today
// only. The after-close breach report stays in complianceWatch.js.
import { getSetting, getWatchState, setWatchState } from './supabase.js';
import { sendPush } from './push.js';

const LDN = 'Europe/London';
const ldnDate = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: LDN });
const hm = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: LDN });

export async function runHotHoldLive({ now = new Date(), notifyOwner = null, dryRun = false } = {}) {
  const board = await getSetting('hh_board');
  const today = ldnDate(now);
  const open = (Array.isArray(board) ? board : []).filter((it) => !it.outcome && it.startTime && ldnDate(it.startTime) === today);
  if (!open.length) return { ok: true, open: 0 };

  const state = await getWatchState('hh_live');
  const t = now.getTime();
  const out = { ok: true, open: open.length, sent: [] };
  for (const it of open) {
    const id = it.id || it.startTime;
    const name = `${String(it.foodItem || 'Item').trim()}${it.batchNumber ? ` (batch ${it.batchNumber})` : ''}`;
    const start = new Date(it.startTime).getTime();
    const limit = start + 4 * 3600000;
    const rs = (it.readings || []).filter((r) => r?.time).sort((a, b) => new Date(a.time) - new Date(b.time));
    const last = rs[rs.length - 1];
    const alerts = [];
    if (t >= limit) {
      alerts.push({ key: `4h_${id}`, title: '🗑️ Discard now — 4 hours', body: `${name} started ${hm(start)}: the 4-hour limit was reached at ${hm(limit)}. Discard it and close it on the board as DISCARDED.`, owner: true });
    } else if (t >= limit - 15 * 60000) {
      alerts.push({ key: `345_${id}`, title: '⏳ 15 minutes left', body: `${name} started ${hm(start)} must be discarded at ${hm(limit)}. Probe it now if it is still being served.` });
    }
    if (last && t < limit && t >= new Date(last.time).getTime() + 2 * 3600000) {
      alerts.push({ key: `2h_${id}_${last.time}`, title: '🌡️ Probe due', body: `${name}: last probe ${hm(new Date(last.time))} (${last.temp}°C) — 2 hours ago. Probe and record it now (≥63°C).` });
    }
    for (const a of alerts) {
      const mark = `${a.key}:${today}`;
      if (state[mark]) continue;
      if (!dryRun) {
        await sendPush({ title: a.title, body: a.body, url: '/hotholding', tag: `hh-${id}`, requireInteraction: true });
        if (a.owner && notifyOwner) await notifyOwner(`🗑️ <b>Hot holding — discard now</b>\n\n${a.body}`);
      }
      state[mark] = new Date().toISOString();
      out.sent.push(a.key);
    }
  }
  if (!dryRun && out.sent.length) await setWatchState('hh_live', state);
  return out;
}

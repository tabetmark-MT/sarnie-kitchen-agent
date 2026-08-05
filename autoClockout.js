// Auto clock-out rule: if an employee forgets to clock out, after 22:00 (London)
// the open shift is closed automatically at 22:00 of that day and the manager is
// notified. Runs server-side (nightly), so it works even when the tablets are
// asleep. Writes to the same app_settings.time_entries the app + clock station
// use, so the closed shift shows up everywhere. Idempotent — already-closed and
// already-auto-closed shifts are skipped.
import { getSetting, upsertSetting } from './supabase.js';

const TZ = 'Europe/London';
const CLOSE_HOUR = 22; // "after ten o'clock"
// The rule goes live from this date — shifts that started before it are left
// alone (no retroactive auto-closing of existing open shifts).
const EFFECTIVE_FROM = process.env.AUTO_CLOCKOUT_FROM || '2026-06-27';

function offsetMs(date) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - Math.floor(date.getTime() / 1000) * 1000;
}

// London calendar parts of an instant.
function londonYMD(date) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { y: +p.year, m: +p.month, d: +p.day, ymd: `${p.year}-${p.month}-${p.day}` };
}

// 22:00 London on the calendar day of `dateIso`, as a UTC timestamp (ms).
function closeCutoff(dateIso) {
  const { y, m, d } = londonYMD(new Date(dateIso));
  const guessUTC = Date.UTC(y, m - 1, d, CLOSE_HOUR, 0, 0);
  return guessUTC - offsetMs(new Date(guessUTC));
}

const fmtDur = (mins) => {
  const t = Math.round(mins), h = Math.floor(t / 60), m = t % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
};
const fmtHM = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));

export async function runAutoClockOut(nowMs = Date.now()) {
  const entries = await getSetting('time_entries');
  if (!Array.isArray(entries) || entries.length === 0) return { ok: true, closed: [] };
  const employees = (await getSetting('employees')) || [];
  const nameFor = (e) => e.employeeName
    || (Array.isArray(employees) ? employees.find(x => x.id === e.employeeId)?.name : null)
    || 'Employee';

  const closed = [];
  const next = entries.map((e) => {
    if (e.clockOut) return e;
    if (londonYMD(new Date(e.clockIn)).ymd < EFFECTIVE_FROM) return e; // rule not yet in effect for this shift
    const cutoff = closeCutoff(e.clockIn);
    if (nowMs < cutoff) return e; // not yet 22:00 on that shift's day
    // The cutoff must never land BEFORE the clock-in. Someone who clocks in at
    // 22:32 (after the 22:00 cutoff) would otherwise be stamped with a 22:00
    // clock-out and stored as a NEGATIVE shift — which is exactly what happened
    // to one entry on 25 Jul (-32 min). `mins` was clamped for the notification,
    // so the message read "0m" while the saved record stayed negative and fed
    // straight into hours and pay.
    const startMs = new Date(e.clockIn).getTime();
    const endMs   = Math.max(cutoff, startMs);
    const mins    = Math.max(0, (endMs - startMs) / 60000);
    const afterCutoff = startMs > cutoff;
    closed.push({ name: nameFor(e), mins, clockIn: e.clockIn, cutoff: endMs, afterCutoff });
    return {
      ...e,
      clockOut: new Date(endMs).toISOString(),
      autoClockOut: true,
      autoNote: afterCutoff
        ? 'Clocked in after the 22:00 cut-off — auto closed at the clock-in time. Needs a manager to set the real hours.'
        : 'Forgot to clock out — auto closed at 22:00',
    };
  });

  if (closed.length) await upsertSetting('time_entries', next);
  return { ok: true, closed };
}

export function formatAutoClockOut(result) {
  if (!result?.closed?.length) return null;
  const lines = result.closed.map(c =>
    `• ${c.name} — clocked in ${fmtHM(new Date(c.clockIn).getTime())}, auto-out 22:00 (${fmtDur(c.mins)})`);
  const s = result.closed.length > 1 ? 's' : '';
  return `⚠️ Forgot to clock out — ${result.closed.length} shift${s} auto-closed at 22:00\n\n${lines.join('\n')}\n\nReview or adjust in Employee Management if needed.`;
}

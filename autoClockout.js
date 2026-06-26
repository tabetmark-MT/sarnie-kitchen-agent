// Auto clock-out rule: if an employee forgets to clock out, after 22:00 (London)
// the open shift is closed automatically at 22:00 of that day and the manager is
// notified. Runs server-side (nightly), so it works even when the tablets are
// asleep. Writes to the same app_settings.time_entries the app + clock station
// use, so the closed shift shows up everywhere. Idempotent — already-closed and
// already-auto-closed shifts are skipped.
import { getSetting, upsertSetting } from './supabase.js';

const TZ = 'Europe/London';
const CLOSE_HOUR = 22; // "after ten o'clock"

function offsetMs(date) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - Math.floor(date.getTime() / 1000) * 1000;
}

// 22:00 London on the calendar day of `dateIso`, as a UTC timestamp (ms).
function closeCutoff(dateIso) {
  const date = new Date(dateIso);
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const guessUTC = Date.UTC(+p.year, +p.month - 1, +p.day, CLOSE_HOUR, 0, 0);
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
    const cutoff = closeCutoff(e.clockIn);
    if (nowMs < cutoff) return e; // not yet 22:00 on that shift's day
    const mins = Math.max(0, (cutoff - new Date(e.clockIn).getTime()) / 60000);
    closed.push({ name: nameFor(e), mins, clockIn: e.clockIn, cutoff });
    return {
      ...e,
      clockOut: new Date(cutoff).toISOString(),
      autoClockOut: true,
      autoNote: 'Forgot to clock out — auto closed at 22:00',
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

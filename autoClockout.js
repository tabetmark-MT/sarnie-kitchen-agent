// Auto clock-out rule: if an employee forgets to clock out, after 22:00 (London)
// the open shift is closed automatically at 22:00 of that day and the manager is
// notified. Runs server-side (nightly), so it works even when the tablets are
// asleep.
//
// The rule itself now lives in the database, as auto_close_open_shifts() — a
// single UPDATE over rows of public.time_entries. This file used to read the
// whole app_settings.time_entries array, rewrite it in JavaScript and write it
// back. That read-modify-write is what lost two days of hours for five people
// in August: any other writer holding a stale copy of the array silently
// reverted this one's work, and nothing anywhere reported a failure.
//
// Doing it in one statement means it cannot half-apply, and the table's
// constraints reject a negative or 18h+ shift outright rather than letting it
// reach payroll. The same SQL is also run by pg_cron at 22:10, so a Render cold
// start or a dead GitHub runner no longer means the rule simply does not happen.
//
// The exported shape is unchanged, so index.js needs no edit.
import { supabase } from './supabase.js';

const TZ = 'Europe/London';

const fmtDur = (mins) => {
  const t = Math.round(mins), h = Math.floor(t / 60), m = t % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
};
const fmtHM = (ms) => new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(ms));

export async function runAutoClockOut(nowMs = Date.now()) {
  const { data, error } = await supabase.rpc('auto_close_open_shifts', {
    p_now: new Date(nowMs).toISOString(),
  });

  // Never swallow this. The August incident was invisible for two days because
  // a failed write returned quietly — the caller reports throws to Telegram.
  if (error) throw new Error(`auto_close_open_shifts failed: ${error.message}`);

  const closed = (data || []).map((r) => {
    const startMs = new Date(r.clock_in).getTime();
    const endMs = new Date(r.closed_at).getTime();
    const mins = Math.max(0, (endMs - startMs) / 60000);
    return {
      name: r.employee || 'Employee',
      mins,
      clockIn: r.clock_in,
      cutoff: endMs,
      // Clocked in after 22:00: closed at the clock-in time, so a manager has
      // to set the real hours. Worth saying out loud rather than showing 0m.
      afterCutoff: startMs >= endMs,
      // Closed at the 18h limit rather than at 22:00 — a shift that began after
      // midnight. The stored figure is a placeholder, not the hours worked, so
      // it must be called out or somebody gets paid the placeholder.
      capped: mins >= 18 * 60 - 1,
    };
  });

  if (closed.length) console.log(`[AutoClockOut] closed ${closed.length} shift(s)`);
  return { ok: true, closed };
}

export function formatAutoClockOut(result) {
  if (!result?.closed?.length) return null;
  const lines = result.closed.map((c) => {
    const at = fmtHM(new Date(c.clockIn).getTime());
    if (c.afterCutoff) return `• ${c.name} — clocked in ${at}, after the 22:00 cut-off — needs real hours setting`;
    if (c.capped)      return `• ${c.name} — clocked in ${at} and left open over 18h. Closed at the 18h limit, NOT at 22:00 — ⚠️ placeholder, set the real finish time before payroll`;
    return `• ${c.name} — clocked in ${at}, auto-out 22:00 (${fmtDur(c.mins)})`;
  });
  const s = result.closed.length > 1 ? 's' : '';
  const needsAction = result.closed.filter(c => c.afterCutoff || c.capped).length;
  const tail = needsAction
    ? `\n\n⚠️ ${needsAction} of these are placeholders, not real hours. Fix them in Employee Management before running payroll.`
    : '\n\nReview or adjust in Employee Management if needed.';
  return `⚠️ Forgot to clock out — ${result.closed.length} shift${s} auto-closed at 22:00\n\n${lines.join('\n')}${tail}`;
}

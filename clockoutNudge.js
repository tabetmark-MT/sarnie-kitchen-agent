// Watcher 1 — prevention, not correction.
//
// auto_close_open_shifts() runs at 22:10 London and pg_cron repeats it at 23:10.
// By then the shift is already closed at a PLACEHOLDER time that somebody has to
// notice and correct before payroll. 14.4% of all shifts on record were closed
// that way, and those shifts read longer than ones closed properly — so every
// labour figure in the system, including the rota savings, rests partly on
// guesses.
//
// This fires at 21:45, BEFORE the cut-off, so the person closes their own shift
// at the time they actually left. One message, to the manager, naming who is
// still open.
//
// It sends nothing when there is nothing to say. That is deliberate: a nudge
// that arrives every night becomes wallpaper. The Monday heartbeat is what
// proves it ran on the quiet nights.
import { getTimeEntries, getWatchState, setWatchState, markRun } from './supabase.js';

const LDN = 'Europe/London';
const ldnDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: LDN });
const ldnTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', {
  timeZone: LDN, hour: '2-digit', minute: '2-digit',
});
const ldnHourMin = () => {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: LDN, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return Number(p.hour) * 60 + Number(p.minute);
};

// The window this is allowed to speak in. Before it, people are legitimately
// still working; after 22:00 the auto-close has taken over and a nudge is just
// noise about something already done.
const WINDOW_OPEN  = 21 * 60 + 40;   // 21:40
const WINDOW_CLOSE = 22 * 60;        // 22:00

export async function runClockoutNudge({ force = false } = {}) {
  const mins = ldnHourMin();
  if (!force && (mins < WINDOW_OPEN || mins >= WINDOW_CLOSE)) {
    return { skipped: `outside 21:40–22:00 London (now ${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')})` };
  }

  const today = ldnDate();
  const state = await getWatchState('clockout_nudge');
  if (!force && state[`sent:${today}`]) {
    await markRun('clockout_nudge');            // it ran; it simply had nothing new to do
    return { ok: true, alreadySent: true };
  }

  // Only today's London date — a shift left open from a previous day is the
  // auto-close's problem and nudging about it helps nobody.
  const since = Date.now() - 36 * 3600000;
  const entries = await getTimeEntries(since);
  const open = entries.filter((e) => !e.clockOut && ldnDate(new Date(e.clockIn)) === today);

  await markRun('clockout_nudge');

  if (!open.length) return { ok: true, open: 0 };   // silence is correct

  state[`sent:${today}`] = new Date().toISOString();
  await setWatchState('clockout_nudge', state);

  return {
    ok: true,
    open: open.length,
    people: open.map((e) => ({
      name: e.employeeName || 'Unknown',
      clockIn: e.clockIn,
      hours: (Date.now() - new Date(e.clockIn).getTime()) / 3600000,
    })),
  };
}

export function formatClockoutNudge(r) {
  if (!r?.ok || !r.open) return null;
  const lines = [
    `⏰ <b>Still clocked in</b> — auto-close runs at 22:10`,
    '',
  ];
  for (const p of r.people) {
    lines.push(`• <b>${p.name}</b> — in since ${ldnTime(p.clockIn)} (${p.hours.toFixed(1)}h)`);
  }
  lines.push('');
  lines.push('If they clock out themselves the time is right. After 22:10 it gets a placeholder that has to be corrected before payroll.');
  return lines.join('\n');
}

// Trend, for the Monday heartbeat: the share of shifts closed automatically
// over the last 7 days. The point of this watcher is to drive it down, so the
// number belongs where you will actually see it week to week.
export async function autoCloseRate(days = 7) {
  const since = Date.now() - days * 86400000;
  const entries = await getTimeEntries(since);
  const closed = entries.filter((e) => e.clockOut);
  if (!closed.length) return null;
  const auto = closed.filter((e) => e.autoClockOut).length;
  return {
    days,
    total: closed.length,
    auto,
    pct: Math.round((auto / closed.length) * 1000) / 10,
  };
}

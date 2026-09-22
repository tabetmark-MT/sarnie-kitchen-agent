// Watcher 0 — proof of life.
//
// Not a feature. Every other watcher is silent when things are fine, which is
// correct — but silence then means two different things, "nothing to report"
// and "I stopped running", and you cannot tell them apart. This makes the
// difference visible once a week.
//
// The history this exists for: auto clock-out failed silently for two days and
// left five people on 53–59 hour shifts; the nightly Dropbox backup truncated at
// 1000 rows for months; the in-app snapshot stopped for four days in August and
// again on 21 Sep. Every one of those was a job that had quietly stopped doing
// its work while everything around it looked normal.
//
// It reports on Monday WHETHER OR NOT anything is stale. A monitor that only
// speaks up when there is bad news is itself unmonitored.
import { supabase, getSetting, upsertSetting, markRun } from './supabase.js';

// Job → how many hours may pass between successful runs before it is stale.
// Deliberately generous: this catches "stopped", not "ran late". A watcher that
// cries wolf over a 20-minute delay gets muted, and then it protects nothing.
//
// Only jobs listed here are checked, so an unbuilt watcher is never reported as
// broken — add the line when you add the job.
const EXPECTED_HOURS = {
  debrief:          26,   // daily 10:00
  backup:           26,   // nightly 22:00 (Dropbox)
  snapshot:         26,   // nightly 22:00 (in-app restore point)
  riskcheck:         2,   // every 30 min, 07:00–22:00
  backup_watch:     26,   // daily 09:15
  clockout_nudge:   26,   // daily 21:45
  compliance_watch:  3,   // hourly 11:00–22:30
};

// The six pg_cron jobs live in the DATABASE, not in this process, so no amount
// of last_run_* markers here would ever see them. They are checked from their
// own run table instead. auto-close-open-shifts is on this list because it is
// the one that has already failed silently and cost real money.
const PG_CRON_EXPECTED_HOURS = {
  'auto-close-open-shifts': 26,
  'alarm-open-shifts':      26,
  'wake-kitchen-agent':      2,
  'prune-app-backups':      26,
  'prune-http-responses':   26,
  'prewarm-agent-backup':   26,
};

const ldn = (iso) => new Date(iso).toLocaleString('en-GB', {
  timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit',
});
const hoursSince = (iso) => (Date.now() - new Date(iso).getTime()) / 3600000;

async function checkAgentJobs() {
  const healthy = [], stale = [], missing = [];
  for (const [job, maxH] of Object.entries(EXPECTED_HOURS)) {
    const at = await getSetting(`last_run_${job}`);
    if (!at) { missing.push({ job, maxH }); continue; }
    const age = hoursSince(at);
    (age > maxH ? stale : healthy).push({ job, at, age, maxH });
  }
  return { healthy, stale, missing };
}

// pg_cron records every run itself, which is better evidence than a marker we
// write about ourselves: it cannot claim success for a run that did not happen.
async function checkPgCron() {
  const healthy = [], stale = [];
  const { data, error } = await supabase.rpc('cron_job_health');
  if (error) return { healthy, stale, unavailable: error.message };
  for (const row of data || []) {
    const maxH = PG_CRON_EXPECTED_HOURS[row.jobname];
    if (!maxH) continue;
    const age = row.last_success ? hoursSince(row.last_success) : Infinity;
    const entry = { job: row.jobname, at: row.last_success, age, maxH, fails: row.recent_failures };
    (age > maxH || row.recent_failures > 0 ? stale : healthy).push(entry);
  }
  return { healthy, stale };
}

export async function runHeartbeat() {
  const agents = await checkAgentJobs();
  const db = await checkPgCron();
  const stale = [...agents.stale, ...db.stale];
  const healthy = [...agents.healthy, ...db.healthy];
  await markRun('heartbeat');
  return {
    ok: stale.length === 0,
    stale, healthy,
    missing: agents.missing,
    dbUnavailable: db.unavailable || null,
  };
}

export function formatHeartbeat(r) {
  const lines = [];

  if (r.stale.length) {
    lines.push(`🔴 <b>${r.stale.length} job${r.stale.length > 1 ? 's have' : ' has'} gone quiet</b>`);
    for (const s of r.stale) {
      const when = s.at ? `last ran ${ldn(s.at)}, ${Math.floor(s.age)}h ago` : 'has never run';
      const fails = s.fails ? ` · ${s.fails} recent failure${s.fails > 1 ? 's' : ''}` : '';
      lines.push(`• <b>${s.job}</b> — ${when} (expected within ${s.maxH}h)${fails}`);
    }
    lines.push('');
  } else {
    lines.push('✅ <b>All jobs alive</b>');
    lines.push('');
  }

  if (r.healthy.length) {
    lines.push('<b>Last successful run</b>');
    for (const h of [...r.healthy].sort((a, b) => a.job.localeCompare(b.job))) {
      lines.push(`• ${h.job} — ${ldn(h.at)}`);
    }
  }

  // A job with no marker yet is NOT a failure — it has simply never run since
  // the marker was added. Said plainly so it does not read as an alarm.
  if (r.missing.length) {
    lines.push('');
    lines.push(`<i>No marker yet (will appear after the first run): ${r.missing.map(m => m.job).join(', ')}</i>`);
  }
  if (r.dbUnavailable) {
    lines.push('');
    lines.push(`<i>Database job health unavailable: ${r.dbUnavailable}</i>`);
  }

  return lines.join('\n');
}

// Once per London week, so repeated Monday pings send one message.
export async function heartbeatAlreadySentThisWeek() {
  const d = new Date();
  const ldnDate = d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const [y, m, day] = ldnDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  const thursday = new Date(dt); thursday.setUTCDate(dt.getUTCDate() + 4 - (dt.getUTCDay() || 7));
  const week = `${thursday.getUTCFullYear()}-W${String(Math.ceil((((thursday - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / 86400000) + 1) / 7)).padStart(2, '0')}`;
  const prev = await getSetting('last_heartbeat_week');
  if (prev === week) return true;
  await upsertSetting('last_heartbeat_week', week);
  return false;
}

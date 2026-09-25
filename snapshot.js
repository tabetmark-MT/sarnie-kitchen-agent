// Server-side in-app snapshot.
//
// `public.backups` is the app's own restore-point history, shown in Settings →
// Data & Backup and read by the restore button. Until now it was written BY THE
// BROWSER, which meant it only happened when someone had the app open and
// signed in. On 21 Sep 2026 the 23:00 end-of-day snapshot fired with no session,
// was refused at the insert, and told nobody. That is not a bug you fix by
// reporting it better — a backup that depends on a human being logged in at
// 23:00 is not a backup.
//
// So it now runs here, next to the nightly Dropbox job, with the service key.
// No session, no device, no browser. It reuses getAllData(), which already
// pages explicitly, verifies every table against a COUNT, ABORTS on a short
// read rather than writing something that looks complete, and redacts secrets.
//
// WHAT THIS IS NOT: the disaster-recovery copy. That is the Dropbox file, which
// carries everything. This is the in-app restore point, and it deliberately
// leaves out inline file payloads — see stripInlineFiles below.
import { supabase, getAllData } from './supabase.js';

const DATA_VERSION = 7;          // must match src/lib/backup.js in the kitchen app
const SNAPSHOT_TYPE = 'daily';   // the type the app's UI and prune_backups know

const ldnDayKey = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });

// time_entries rows → the camelCase entry objects the app works with.
// MUST stay in step with fromTimeEntryRow in the kitchen app's src/lib/rows.js:
// the restore path feeds these straight back through toTimeEntryRow, so a field
// dropped here is a field lost on restore.
function fromTimeEntryRow(r) {
  const e = {
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_name ?? undefined,
    clockIn: r.clock_in,
    clockOut: r.clock_out,
    by: r.recorded_by ?? undefined,
  };
  if (r.auto_clock_out) e.autoClockOut = true;
  if (r.auto_note) e.autoNote = r.auto_note;
  if (r.original_clock_out) e.originalClockOut = r.original_clock_out;
  if (r.in_site) e.inSite = r.in_site;
  if (r.out_site) e.outSite = r.out_site;
  if (r.edited_by) e.editedBy = r.edited_by;
  if (r.edited_at) e.editedAt = r.edited_at;
  return e;
}

// Certificates normally live in Supabase Storage and the record holds a
// `filePath` pointing at them. One legacy record still carries the file itself
// inline in `fileData` — a single 13 MB base64 blob, which is the whole reason
// app_settings.employees is 13 MB.
//
// Writing that into every daily row would put ~390 MB into a 67 MB database
// within the 30-day retention window. The metadata and the filePath are kept,
// so a restored record still points at its document; only the embedded bytes
// go. This matches what the browser-written snapshots already contained, so it
// is not a reduction in what restore has ever recovered.
//
// NOTE: it does mean this copy cannot rebuild a certificate FILE on its own.
// Neither could the old one. The files' durability is Supabase Storage's, and
// the full inline blob is still in the nightly Dropbox file.
function stripInlineFiles(employees) {
  if (!Array.isArray(employees)) return { employees: [], stripped: 0 };
  let stripped = 0;
  const out = employees.map((emp) => {
    if (!Array.isArray(emp?.certs)) return emp;
    const certs = emp.certs.map((c) => {
      if (!c || c.fileData == null) return c;
      stripped++;
      const { fileData, ...rest } = c;
      return { ...rest, fileInline: false };
    });
    return { ...emp, certs };
  });
  return { employees: out, stripped };
}

// DB tables → the snapshot shape the kitchen app restores from.
// The app reads `users` from app_settings.team (its source of truth on boot),
// NOT from app_users — app_users holds the login PINs and is redacted anyway.
function toAppSnapshot(db) {
  const settings = Object.fromEntries((db.app_settings || []).map((r) => [r.key, r.value]));

  const defaults = {};
  const custom = [];
  for (const row of db.checklists || []) {
    if (row.is_custom) custom.push(row.data);
    else defaults[row.id] = row.data;
  }

  const { employees, stripped: strippedCount } = stripInlineFiles(settings.employees);

  return {
    snapshot: {
      version: DATA_VERSION,
      backedUpAt: new Date().toISOString(),
      users:            Array.isArray(settings.team) ? settings.team : [],
      checklists:       defaults,
      customChecklists: custom,
      completions:      db.completions || [],
      reminders:        settings.reminders ?? null,
      schedule:         settings.schedule ?? null,
      auditLog:         db.audit_log || [],
      employees,
      timeEntries:      (db.time_entries || []).map(fromTimeEntryRow),
      // Manager-visible HR fields only. employee_hr_private (legal name, DOB,
      // address, NI number, health) is deliberately absent: `backups` can be
      // read by MANAGERS, and admin-only data must not travel through it. The
      // private table lives in the Dropbox copy, which is Mark's alone.
      hr:               db.employee_hr || [],
    },
    strippedCount,
  };
}

// The UTC instant of a given hour on today's London date. Offsets come from
// Intl and the solve is iterated, never a hardcoded +1 — this codebase has been
// bitten by BST/GMT day boundaries in the backups, the labour feed and the
// closures list.
function ldnHourUtcIso(hour = 0) {
  const [y, m, d] = ldnDayKey().split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, hour, 0, 0);
  const offsetAt = (t) => {
    const probe = new Date(t);
    return new Date(probe.toLocaleString('en-US', { timeZone: 'Europe/London' }))
         - new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }));
  };
  let t = naive;
  for (let i = 0; i < 2; i++) t = naive - offsetAt(t);
  return new Date(t).toISOString();
}

// Has an EVENING snapshot already landed today?
//
// This asks "since 21:00 London", not "since midnight", and the difference is
// the whole point. The nightly chain is triggered twice: Render's in-process
// cron at 22:00 London, and the GitHub Actions workflow — scheduled for 21:00
// UTC but in practice started 1.5-2.75 hours late by GitHub's queue (22:36 to
// 23:45 UTC across 16-23 Sep 2026). In BST a 23:25 UTC start is 00:25, i.e.
// already the NEXT London day. (This was once blamed on an "external pinger";
// run timestamps proved it was GitHub itself.) So a midnight cutoff meant the
// 00:25 run filled that day's slot with a snapshot of the PREVIOUS day's
// trading, and the 22:00 run that evening — the fullest one, after a whole day
// of service — found the slot taken and skipped.
//
// Observed exactly that on 23 Sep 2026: the day's only restore point was taken
// at 00:24 and held 1,935 audit rows while the live table had moved to 1,939 by
// lunchtime, with no further snapshot due.
//
// This is the same rule the browser version used and which I dropped when
// moving the job server-side: "a backup from earlier today must not suppress
// this one — it is the fullest." An extra row costs 800 kB for a few hours;
// prune_backups keeps the fullest per London day at 03:40 and drops the rest.
const EVENING_FROM_HOUR = 21;

async function eveningSnapshotExists() {
  const sinceIso = ldnHourUtcIso(EVENING_FROM_HOUR);
  const { count, error } = await supabase
    .from('backups')
    .select('id', { count: 'exact', head: true })
    .eq('backup_type', SNAPSHOT_TYPE)
    .gte('created_at', sinceIso);
  if (error) throw new Error(`backups check failed: ${error.message}`);
  return (count ?? 0) > 0;
}

export async function runInAppSnapshot({ force = false } = {}) {
  if (!force && await eveningSnapshotExists()) {
    return { ok: true, skipped: true, reason: 'evening_snapshot_already_done' };
  }

  // Throws on a short read — a truncated restore point is worse than none, and
  // the caller turns that into a Telegram alert.
  const db = await getAllData();
  const { snapshot, strippedCount } = toAppSnapshot(db);

  // Never write an empty restore point over a good history.
  if (!snapshot.users.length && !snapshot.completions.length) {
    throw new Error('snapshot ABORTED — no users and no completions read. Refusing to write an empty restore point.');
  }

  const payload = {
    backup_type: SNAPSHOT_TYPE,
    version: DATA_VERSION,
    data: snapshot,
    size_bytes: JSON.stringify(snapshot).length,
    record_count: {
      completions:      snapshot.completions.length,
      users:            snapshot.users.length,
      customChecklists: snapshot.customChecklists.length,
      auditEntries:     snapshot.auditLog.length,
      employees:        snapshot.employees.length,
      timeEntries:      snapshot.timeEntries.length,
      // Always true here: getAllData reads with the service key and verifies
      // every table against a COUNT, so a partial read throws instead of
      // arriving labelled. The browser could only ever promise this when an
      // admin happened to be the one holding the app open.
      auditComplete: true,
      source: 'server',
      inlineFilesStripped: strippedCount,
      hrRecords: (db.employee_hr || []).length,
    },
    backed_up_by: 'kitchen-agent',
  };

  const { error } = await supabase.from('backups').insert([payload]);
  if (error) throw new Error(`backups insert failed: ${error.message}`);

  return {
    ok: true,
    at: new Date().toISOString(),
    sizeBytes: payload.size_bytes,
    counts: payload.record_count,
  };
}

export function formatSnapshotResult(r) {
  if (r.skipped) return null;                       // nothing worth a message
  const c = r.counts || {};
  const mb = (r.sizeBytes / 1048576).toFixed(2);
  return `🗂 <b>In-app restore point saved</b>\n`
    + `${c.completions} completions · ${c.auditEntries} audit · ${c.timeEntries} shifts · ${c.employees} staff\n`
    + `${mb} MB · full audit log verified`;
}

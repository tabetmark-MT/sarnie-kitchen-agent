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
    },
    strippedCount,
  };
}

// Has a snapshot already landed today (London)? The browser can still write one
// via the manual button, and prune_backups keeps only the fullest per day, so a
// duplicate is harmless — but there is no reason to write 800 kB for nothing.
// The UTC instant of London midnight today. Offsets come from Intl and the
// solve is iterated, never a hardcoded +1 — this codebase has been bitten by
// BST/GMT day boundaries in the backups, the labour feed and the closures list.
function ldnMidnightUtcIso() {
  const [y, m, d] = ldnDayKey().split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offsetAt = (t) => {
    const probe = new Date(t);
    return new Date(probe.toLocaleString('en-US', { timeZone: 'Europe/London' }))
         - new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }));
  };
  let t = naive;
  for (let i = 0; i < 2; i++) t = naive - offsetAt(t);
  return new Date(t).toISOString();
}

async function snapshotExistsToday() {
  const sinceIso = ldnMidnightUtcIso();
  const { count, error } = await supabase
    .from('backups')
    .select('id', { count: 'exact', head: true })
    .eq('backup_type', SNAPSHOT_TYPE)
    .gte('created_at', sinceIso);
  if (error) throw new Error(`backups check failed: ${error.message}`);
  return (count ?? 0) > 0;
}

export async function runInAppSnapshot({ force = false } = {}) {
  if (!force && await snapshotExistsToday()) {
    return { ok: true, skipped: true, reason: 'already_done_today' };
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

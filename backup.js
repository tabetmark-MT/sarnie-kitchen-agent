import { getAllData, getSetting, upsertSetting, markRun } from './supabase.js';
import { uploadToDropbox, dropboxConfigured } from './dropbox.js';

const londonDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }); // YYYY-MM-DD

// ── Off-site nightly backup: full Supabase snapshot → Dropbox ────────────────
// Two schedulers call this: Render's in-process cron at 22:00 London, and the
// GitHub workflow, scheduled for 21:00 UTC but started 1.5-2.75 h late by
// GitHub's queue — often after midnight London. Pass { force: true } for an
// on-demand /backup.
//
// De-duplicated by ELAPSED TIME, not by calendar date. The date rule
// ("skip if last_dropbox_backup == today") let the late GitHub run at ~00:23
// claim the NEXT London day, so the 22:00 run that evening skipped. While
// GitHub kept firing, that only shifted each backup by a couple of hours. On
// 24 Sep 2026 GitHub fired no scheduled runs at all, and the rule would have
// left 00:23 on the 24th to 22:00 on the 25th with no off-site copy: 45 hours,
// against an accepted exposure of ~24. The in-app snapshot had the same flaw and
// was fixed the day before.
//
// 12 h means one backup per night whichever scheduler arrives first. The 22:00
// run always goes ahead, and a late GitHub run 2-3 hours after it is skipped.
// If Render was asleep at 22:00, the GitHub run is more than 12 h after the
// previous night and does the work instead.
const MIN_INTERVAL_H = 12;

export async function runNightlyBackup({ force = false } = {}) {
  if (!dropboxConfigured()) {
    return { ok: false, reason: 'Dropbox not configured (set DROPBOX_APP_KEY / SECRET / REFRESH_TOKEN)' };
  }

  const today = londonDate();
  if (!force) {
    const lastAt = await getSetting('last_run_backup');       // ISO, written on success only
    const ageH = lastAt ? (Date.now() - new Date(lastAt).getTime()) / 3600000 : Infinity;
    if (ageH < MIN_INTERVAL_H) {
      return { ok: true, skipped: true, reason: `backed up ${ageH.toFixed(1)}h ago`, date: today };
    }
  }

  const data = await getAllData();

  // ── Empty-read guard ────────────────────────────────────────────────────
  // Core tables are seeded and never legitimately empty in production. If they
  // come back empty, the read FAILED (e.g. service-role key missing / RLS lock)
  // — as happened 24–25 Jun 2026. Abort WITHOUT uploading and WITHOUT marking
  // the day done, so (a) the last good backup is preserved, (b) it retries, and
  // (c) the failure is surfaced instead of silently saving an empty file.
  //
  // time_entries joined this list on 14 Aug 2026, when the hours moved out of
  // the app_settings blob into their own table. It is the one dataset nobody
  // can reconstruct — an unbacked-up payroll table that reads empty is the
  // worst possible silent failure, and the guard is worth more here than on
  // any of the others.
  const count = (t) => (Array.isArray(data?.[t]) ? data[t].length : 0);
  const CORE = ['app_users', 'app_settings', 'checklists', 'time_entries'];
  const emptyCore = CORE.filter((t) => count(t) === 0);
  if (emptyCore.length) {
    return {
      ok: false,
      aborted: true,
      reason: `backup ABORTED — core table(s) empty: ${emptyCore.join(', ')}. ` +
        `Supabase read failed (check SUPABASE_SERVICE_ROLE_KEY / RLS). Nothing was written; ` +
        `last good backup is preserved.`,
      counts: Object.fromEntries(Object.keys(data || {}).map((k) => [k, count(k)])),
    };
  }

  const payload = {
    backedUpAt: new Date().toISOString(),
    source: 'sarnie-kitchen-agent',
    project: process.env.SUPABASE_URL,
    tables: data,
  };
  const json = JSON.stringify(payload, null, 2);

  // Default to the Dropbox app's own root folder (/Apps/Sarnie Social Backups).
  // The old default added a second "Sarnie Social Backups" level — nesting.
  // (If a DROPBOX_BACKUP_PATH env is set on Render, it still wins; clear it to
  // use the tidy root.)
  const folder = (process.env.DROPBOX_BACKUP_PATH || '').replace(/\/$/, '');
  const path = `${folder}/sarnie-backup-${today}.json`;

  await uploadToDropbox(path, Buffer.from(json, 'utf8'));
  await upsertSetting('last_dropbox_backup', today); // mark done so later triggers skip

  const counts = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])
  );
  await markRun('backup');
  return { ok: true, path, sizeKB: Math.round(json.length / 1024), counts };
}

// Human-readable summary for Telegram
export function formatBackupResult(r) {
  if (!r.ok) return `⚠️ Nightly backup did not run: ${r.reason}`;
  const c = r.counts || {};
  return `💾 Nightly backup complete\n\n` +
    `📁 ${r.path}\n` +
    `📦 ${r.sizeKB} KB\n\n` +
    `• ${c.completions ?? 0} records (history)\n` +
    `• ${c.app_users ?? 0} users\n` +
    `• ${c.checklists ?? 0} checklists\n` +
    `• ${c.audit_log ?? 0} audit entries\n` +
    `• ${c.app_settings ?? 0} settings (incl. documents & team)`;
}

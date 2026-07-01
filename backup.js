import { getAllData, getSetting, upsertSetting } from './supabase.js';
import { uploadToDropbox, dropboxConfigured } from './dropbox.js';

const londonDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }); // YYYY-MM-DD

// ── Off-site nightly backup: full Supabase snapshot → Dropbox ────────────────
// Idempotent per calendar day: multiple schedulers (GitHub Actions, in-process
// cron, external pinger) can all call this, but only the first run each day
// actually backs up. Pass { force: true } for an on-demand /backup.
export async function runNightlyBackup({ force = false } = {}) {
  if (!dropboxConfigured()) {
    return { ok: false, reason: 'Dropbox not configured (set DROPBOX_APP_KEY / SECRET / REFRESH_TOKEN)' };
  }

  const today = londonDate();
  if (!force) {
    const last = await getSetting('last_dropbox_backup');
    if (last === today) return { ok: true, skipped: true, reason: 'already backed up today', date: today };
  }

  const data = await getAllData();

  // ── Empty-read guard ────────────────────────────────────────────────────
  // Core tables are seeded and never legitimately empty in production. If they
  // come back empty, the read FAILED (e.g. service-role key missing / RLS lock)
  // — as happened 24–25 Jun 2026. Abort WITHOUT uploading and WITHOUT marking
  // the day done, so (a) the last good backup is preserved, (b) it retries, and
  // (c) the failure is surfaced instead of silently saving an empty file.
  const count = (t) => (Array.isArray(data?.[t]) ? data[t].length : 0);
  const CORE = ['app_users', 'app_settings', 'checklists'];
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

  const folder = (process.env.DROPBOX_BACKUP_PATH || '/Sarnie Social Backups').replace(/\/$/, '');
  const path = `${folder}/sarnie-backup-${today}.json`;

  await uploadToDropbox(path, Buffer.from(json, 'utf8'));
  await upsertSetting('last_dropbox_backup', today); // mark done so later triggers skip

  const counts = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])
  );
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

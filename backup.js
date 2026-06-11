import { getAllData } from './supabase.js';
import { uploadToDropbox, dropboxConfigured } from './dropbox.js';

// ── Off-site nightly backup: full Supabase snapshot → Dropbox ────────────────
export async function runNightlyBackup() {
  if (!dropboxConfigured()) {
    return { ok: false, reason: 'Dropbox not configured (set DROPBOX_APP_KEY / SECRET / REFRESH_TOKEN)' };
  }

  const data = await getAllData();
  const payload = {
    backedUpAt: new Date().toISOString(),
    source: 'sarnie-kitchen-agent',
    project: process.env.SUPABASE_URL,
    tables: data,
  };
  const json = JSON.stringify(payload, null, 2);

  const folder = (process.env.DROPBOX_BACKUP_PATH || '/Sarnie Social Backups').replace(/\/$/, '');
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const path = `${folder}/sarnie-backup-${date}.json`;

  await uploadToDropbox(path, Buffer.from(json, 'utf8'));

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

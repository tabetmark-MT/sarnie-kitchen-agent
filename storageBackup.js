// Off-site mirror of Supabase Storage.
//
// THE GAP THIS CLOSES. The nightly Dropbox job backs up TABLES. Certificates,
// right-to-work documents and supplier paperwork are not rows — they are files
// in a Storage bucket, and the tables only hold a `filePath` pointing at them.
// So every backup we have ever taken would restore a complete set of records
// that all point at documents that no longer exist. 23 files, 18 MB, copied
// nowhere. Found in the 24 Sep 2026 health check.
//
// WHY A FILE MIRROR AND NOT BASE64 IN THE JSON. Inlining 18 MB of PDFs would
// add ~24 MB of base64 to a 15 MB backup and re-upload all of it every single
// night, for a set of files that changes perhaps twice a month. This mirrors
// them as real files and uploads only what has actually changed — verified by
// etag, not by timestamp, so a file that is re-saved without edits is skipped.
//
// NOTHING IS EVER DELETED. If an object disappears from Storage the Dropbox copy
// stays and is reported as `orphaned`. A backup that deletes on the strength of
// something being missing upstream is a backup that can be emptied by a bug —
// and this system has already been bitten by a 24-25 June incident where empty
// reads were written over good backups as "success".
import { supabase, markRun } from './supabase.js';
import { uploadToDropbox, downloadFromDropbox, dropboxConfigured } from './dropbox.js';

const ROOT = (process.env.DROPBOX_BACKUP_PATH || '') + '/storage';
const MANIFEST_PATH = `${ROOT}/_manifest.json`;

// Dropbox rejects these in path components; Supabase object names allow them.
const safeSegment = (s) => s.replace(/[\\:?*<>"|]/g, '_').replace(/\s+$/g, '_');
const dropboxPathFor = (bucket, name) =>
  `${ROOT}/${safeSegment(bucket)}/${name.split('/').map(safeSegment).join('/')}`;

async function readManifest() {
  try {
    const buf = await downloadFromDropbox(MANIFEST_PATH);
    if (!buf) return {};
    const j = JSON.parse(buf.toString('utf8'));
    return (j && typeof j.files === 'object') ? j.files : {};
  } catch (e) {
    // A manifest we cannot read means we do not know what is already there.
    // Copying everything again is wasteful but SAFE; guessing is not.
    console.warn('[StorageBackup] manifest unreadable, treating as first run:', e.message);
    return {};
  }
}

export async function runStorageBackup({ force = false } = {}) {
  if (!dropboxConfigured()) return { ok: false, skipped: true, reason: 'dropbox not configured' };

  const { data: objects, error } = await supabase.rpc('storage_object_index');
  if (error) throw new Error(`storage index failed: ${error.message}`);
  if (!Array.isArray(objects)) throw new Error('storage index returned nothing');

  // An empty index when we previously held files is the 24 June failure mode:
  // a read that returns nothing is not proof that nothing exists.
  const prev = await readManifest();
  const prevCount = Object.keys(prev).length;
  if (objects.length === 0 && prevCount > 0) {
    throw new Error(`storage index returned 0 objects but the manifest holds ${prevCount} — refusing to proceed on an empty read`);
  }

  const next = {};
  const uploaded = [], skipped = [], failed = [];
  let bytesUploaded = 0;

  for (const o of objects) {
    const key = `${o.bucket_id}/${o.name}`;
    const fingerprint = `${o.etag || ''}:${o.size ?? ''}`;
    const already = prev[key];

    if (!force && already && already.fingerprint === fingerprint) {
      next[key] = already;
      skipped.push(key);
      continue;
    }

    try {
      const { data: blob, error: dErr } = await supabase.storage.from(o.bucket_id).download(o.name);
      if (dErr) throw dErr;
      const buf = Buffer.from(await blob.arrayBuffer());

      // Verify before recording. Writing a fingerprint for a short download is
      // how a truncated file becomes permanently "already backed up".
      if (o.size != null && buf.length !== Number(o.size)) {
        throw new Error(`size mismatch — expected ${o.size} bytes, downloaded ${buf.length}`);
      }

      const path = dropboxPathFor(o.bucket_id, o.name);
      await uploadToDropbox(path, buf);

      next[key] = { fingerprint, size: buf.length, path, mime: o.mime_type || null, backedUpAt: new Date().toISOString() };
      uploaded.push(key);
      bytesUploaded += buf.length;
    } catch (e) {
      console.error(`[StorageBackup] ${key}: ${e.message}`);
      failed.push({ key, error: e.message });
      // Keep any previous good record so one bad file cannot un-back-up the rest.
      if (already) next[key] = already;
    }
  }

  // Files we hold that Storage no longer has. Kept, never deleted — a document
  // removed by mistake is exactly what a backup is for.
  const orphaned = Object.keys(prev).filter((k) => !(k in next));
  for (const k of orphaned) next[k] = { ...prev[k], orphanedSince: prev[k].orphanedSince || new Date().toISOString() };

  await uploadToDropbox(MANIFEST_PATH, Buffer.from(JSON.stringify({
    updatedAt: new Date().toISOString(),
    objects: objects.length,
    files: next,
  }, null, 2), 'utf8'));

  // Only a clean pass counts as a successful run for the heartbeat.
  if (!failed.length) await markRun('storage_backup');

  return {
    ok: failed.length === 0,
    total: objects.length,
    uploaded: uploaded.length,
    skipped: skipped.length,
    orphaned: orphaned.length,
    failed,
    bytesUploaded,
  };
}

export function formatStorageBackup(r) {
  if (r.skipped) return null;
  if (!r.ok) {
    return `⚠️ <b>Document backup incomplete</b>\n`
      + `${r.uploaded} copied, <b>${r.failed.length} failed</b> of ${r.total}.\n`
      + r.failed.slice(0, 5).map((f) => `• ${f.key} — ${f.error}`).join('\n')
      + `\n\nThe table backup is separate and unaffected.`;
  }
  if (!r.uploaded) return null;          // nothing changed: silence is correct
  const mb = (r.bytesUploaded / 1048576).toFixed(1);
  return `📎 <b>Documents backed up</b>\n`
    + `${r.uploaded} new or changed file${r.uploaded > 1 ? 's' : ''} (${mb} MB) · ${r.total} total on file`
    + (r.orphaned ? `\n<i>${r.orphaned} kept that are no longer in the app.</i>` : '');
}

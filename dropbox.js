// ── Dropbox upload (OAuth refresh-token flow) ────────────────────────────────
// Dropbox access tokens are short-lived (~4h), so we mint a fresh one from a
// long-lived refresh token on each run. You create these once in the Dropbox
// App Console (see SETUP-DROPBOX.md) and set them as Render env vars:
//   DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN
//   DROPBOX_BACKUP_PATH (optional, default "/Sarnie Social Backups")

export const dropboxConfigured = () =>
  !!(process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET && process.env.DROPBOX_REFRESH_TOKEN);

async function getAccessToken() {
  const { DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN } = process.env;
  const auth = Buffer.from(`${DROPBOX_APP_KEY}:${DROPBOX_APP_SECRET}`).toString('base64');
  let res;
  try {
    res = await fetch('https://api.dropbox.com/oauth2/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: DROPBOX_REFRESH_TOKEN }),
    });
  } catch (e) {
    throw new Error(`Dropbox token endpoint unreachable: ${e.message}${e.cause ? ` (${e.cause.code || e.cause})` : ''}`);
  }
  if (!res.ok) throw new Error(`Dropbox token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

// Upload a file (overwrites same-named file for the day). `contents` = Buffer/string.
export async function uploadToDropbox(path, contents) {
  const token = await getAccessToken();
  let res;
  try {
    res = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', mute: true, strict_conflict: false }),
        'Content-Type': 'application/octet-stream',
      },
      body: contents,
    });
  } catch (e) {
    throw new Error(`Dropbox upload endpoint unreachable: ${e.message}${e.cause ? ` (${e.cause.code || e.cause})` : ''}`);
  }
  if (!res.ok) throw new Error(`Dropbox upload failed: ${res.status} ${await res.text()}`);
  return res.json();
}

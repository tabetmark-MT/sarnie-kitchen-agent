// ── Dropbox upload (OAuth refresh-token flow) ────────────────────────────────
// Dropbox access tokens are short-lived (~4h), so we mint a fresh one from a
// long-lived refresh token on each run. You create these once in the Dropbox
// App Console (see SETUP-DROPBOX.md) and set them as Render env vars:
//   DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN
//   DROPBOX_BACKUP_PATH (optional, default "/Sarnie Social Backups")

export const dropboxConfigured = () =>
  !!(process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET && process.env.DROPBOX_REFRESH_TOKEN);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getAccessToken() {
  const { DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN } = process.env;
  const auth = Buffer.from(`${DROPBOX_APP_KEY}:${DROPBOX_APP_SECRET}`).toString('base64');
  // Dropbox's token endpoint occasionally 500s or rate-limits (429) for a few
  // seconds — a transient blip that once cost a whole night's backup. Retry
  // those with backoff. A 400 (invalid_grant = the refresh token is genuinely
  // dead) is NOT retried: it won't fix itself and needs a new token.
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let res;
    try {
      res = await fetch('https://api.dropbox.com/oauth2/token', {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: DROPBOX_REFRESH_TOKEN }),
      });
    } catch (e) {
      lastErr = new Error(`Dropbox token endpoint unreachable: ${e.message}${e.cause ? ` (${e.cause.code || e.cause})` : ''}`);
      await sleep(attempt * 2000);
      continue;
    }
    if (res.ok) return (await res.json()).access_token;

    const body = await res.text();
    const retryable = res.status >= 500 || res.status === 429;
    lastErr = new Error(`Dropbox token exchange failed: ${res.status} ${body}`);
    if (!retryable) throw lastErr;                 // 4xx (bad token) — don't retry
    if (attempt < 4) await sleep(attempt * 2000);  // 2s, 4s, 6s
  }
  throw new Error(`${lastErr.message} (after 4 attempts)`);
}

// Upload a file (overwrites same-named file for the day). `contents` = Buffer/string.
export async function uploadToDropbox(path, contents) {
  const token = await getAccessToken();
  // Same transient-failure guard as the token exchange: retry 5xx/429, but not
  // a 4xx (bad path/args won't succeed on retry).
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
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
      lastErr = new Error(`Dropbox upload endpoint unreachable: ${e.message}${e.cause ? ` (${e.cause.code || e.cause})` : ''}`);
      await sleep(attempt * 2000);
      continue;
    }
    if (res.ok) return res.json();

    const body = await res.text();
    const retryable = res.status >= 500 || res.status === 429;
    lastErr = new Error(`Dropbox upload failed: ${res.status} ${body}`);
    if (!retryable) throw lastErr;
    if (attempt < 4) await sleep(attempt * 2000);
  }
  throw new Error(`${lastErr.message} (after 4 attempts)`);
}

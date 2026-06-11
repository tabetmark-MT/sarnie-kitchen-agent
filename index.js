import express from 'express';
import cron    from 'node-cron';
import { sendMessage, setWebhook, parseUpdate } from './telegram.js';
import { generateMorningDebrief, handleMessage, handleCommand } from './agent.js';
import { runNightlyBackup, formatBackupResult } from './backup.js';

const app  = express();
const PORT = process.env.PORT || 3000;

const OWNER_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;   // 2046354154
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET || 'sarnie-agent-secret';
const MORNING_HOUR    = process.env.MORNING_HOUR   || '9';   // 9am by default
const MORNING_MINUTE  = process.env.MORNING_MINUTE || '0';
const BACKUP_HOUR     = process.env.BACKUP_HOUR    || '23';  // nightly Dropbox backup
const BACKUP_MINUTE   = process.env.BACKUP_MINUTE  || '0';

app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', agent: 'Sarnie Kitchen Agent', time: new Date().toISOString() }));

// ── External backup trigger ─────────────────────────────────────────────────
// Lets a free scheduler (e.g. cron-job.org) run the backup at 23:00 even when
// the free Render instance has gone to sleep — the request itself wakes it.
async function triggerBackup(res) {
  try {
    const result = await runNightlyBackup();
    if (result.ok || !/not configured/.test(result.reason || '')) {
      await sendMessage(OWNER_CHAT_ID, formatBackupResult(result));
    }
    res.json(result);
  } catch (err) {
    console.error('[Backup endpoint] failed:', err.message);
    await sendMessage(OWNER_CHAT_ID, `⚠️ Nightly Dropbox backup failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
}
app.get(`/tasks/backup/${WEBHOOK_SECRET}`,  (req, res) => triggerBackup(res));
app.post(`/tasks/backup/${WEBHOOK_SECRET}`, (req, res) => triggerBackup(res));

// ── Diagnostics: pinpoint which step fails (no secrets revealed) ─────────────
app.get(`/tasks/diag/${WEBHOOK_SECRET}`, async (req, res) => {
  const out = { node: process.version, env: {
    SUPABASE_URL: !!process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY,
    DROPBOX_APP_KEY: !!process.env.DROPBOX_APP_KEY,
    DROPBOX_APP_SECRET: !!process.env.DROPBOX_APP_SECRET,
    DROPBOX_REFRESH_TOKEN: !!process.env.DROPBOX_REFRESH_TOKEN,
  }};
  // Test 1: Supabase reachable
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/app_users?select=id&limit=1`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}` },
    });
    out.supabase = { ok: r.ok, status: r.status };
  } catch (e) { out.supabase = { ok: false, error: e.message, cause: e.cause?.code || String(e.cause || '') }; }
  // Test 2: Dropbox token endpoint reachable + refresh token valid
  try {
    const auth = Buffer.from(`${process.env.DROPBOX_APP_KEY}:${process.env.DROPBOX_APP_SECRET}`).toString('base64');
    const r = await fetch('https://api.dropbox.com/oauth2/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: process.env.DROPBOX_REFRESH_TOKEN || '' }),
    });
    out.dropboxToken = { ok: r.ok, status: r.status, body: r.ok ? 'access_token received' : (await r.text()).slice(0, 200) };
  } catch (e) { out.dropboxToken = { ok: false, error: e.message, cause: e.cause?.code || String(e.cause || '') }; }
  res.json(out);
});

// ── Telegram webhook ──────────────────────────────────────────────────────
app.post(`/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  res.sendStatus(200); // Always ack fast

  const update = parseUpdate(req.body);
  if (!update) return;

  const { chatId, text, name, isCommand, command } = update;

  // Security — only respond to the owner
  if (String(chatId) !== String(OWNER_CHAT_ID)) {
    await sendMessage(chatId, '⛔ Sorry, I only respond to the kitchen manager.');
    return;
  }

  try {
    let reply;
    if (isCommand) {
      // Run an off-site Dropbox backup on demand
      if (command === '/backup') {
        await sendMessage(chatId, '💾 Running backup to Dropbox…');
        try {
          reply = formatBackupResult(await runNightlyBackup());
        } catch (e) {
          reply = `⚠️ Backup failed: ${e.message}`;
        }
      } else {
        reply = await handleCommand(command, name);
      }
    } else {
      reply = await handleMessage(text, name);
    }
    await sendMessage(chatId, reply);
  } catch (err) {
    console.error('[Agent] Error handling message:', err.message);
    await sendMessage(chatId, '⚠️ Something went wrong. Try again in a moment.');
  }
});

// ── Morning debrief cron ──────────────────────────────────────────────────
// Fires every day at MORNING_HOUR:MORNING_MINUTE (server time = UTC)
// Render servers run UTC, so adjust accordingly
cron.schedule(`${MORNING_MINUTE} ${MORNING_HOUR} * * *`, async () => {
  console.log('[Cron] Sending morning debrief...');
  try {
    const report = await generateMorningDebrief();
    await sendMessage(OWNER_CHAT_ID, report);
    console.log('[Cron] Morning debrief sent ✅');
  } catch (err) {
    console.error('[Cron] Failed to send morning debrief:', err.message);
  }
}, { timezone: 'Europe/London' });

// ── Nightly off-site backup cron (23:00 Europe/London) ──────────────────────
cron.schedule(`${BACKUP_MINUTE} ${BACKUP_HOUR} * * *`, async () => {
  console.log('[Cron] Running nightly Dropbox backup...');
  try {
    const result = await runNightlyBackup();
    console.log('[Cron] Backup:', result.ok ? `✅ ${result.path}` : `⚠️ ${result.reason}`);
    // Only notify on success or real failure (not when Dropbox simply isn't configured yet)
    if (result.ok || !/not configured/.test(result.reason || '')) {
      await sendMessage(OWNER_CHAT_ID, formatBackupResult(result));
    }
  } catch (err) {
    console.error('[Cron] Nightly backup failed:', err.message);
    await sendMessage(OWNER_CHAT_ID, `⚠️ Nightly Dropbox backup failed: ${err.message}`);
  }
}, { timezone: 'Europe/London' });

// ── Start server ──────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🤖 Sarnie Kitchen Agent running on port ${PORT}`);

  // Register webhook with Telegram
  const appUrl = process.env.APP_URL;
  if (appUrl) {
    const result = await setWebhook(`${appUrl}/webhook/${WEBHOOK_SECRET}`);
    console.log('[Webhook]', result.ok ? '✅ Registered' : '❌ Failed:', result.description || '');
  } else {
    console.log('[Webhook] APP_URL not set — webhook not registered');
  }
});

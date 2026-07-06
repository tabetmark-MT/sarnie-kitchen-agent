import express from 'express';
import cron    from 'node-cron';
import { sendMessage, setWebhook, parseUpdate } from './telegram.js';
import { generateMorningDebrief, handleMessage, handleCommand } from './agent.js';
import { runNightlyBackup, formatBackupResult } from './backup.js';
import { runAutoClockOut, formatAutoClockOut } from './autoClockout.js';
import { supabase } from './supabase.js';
import { authorisedIntel, buildComplianceSnapshot } from './intel.js';

const app  = express();
const PORT = process.env.PORT || 3000;

const OWNER_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;   // 2046354154
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET || 'sarnie-agent-secret';
const MORNING_HOUR    = process.env.MORNING_HOUR   || '9';   // 9am by default
const MORNING_MINUTE  = process.env.MORNING_MINUTE || '0';
const BACKUP_HOUR     = process.env.BACKUP_HOUR    || '22';  // nightly Dropbox backup (after kitchen closes)
const BACKUP_MINUTE   = process.env.BACKUP_MINUTE  || '0';

app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'ok',
  agent: 'Sarnie Kitchen Agent',
  build: 'live',
  features: ['employee-management', 'clocked-in-today', 'weekly-targets', 'kpi-reports', 'compliance-trends', 'probe-calibration', 'document-library', 'auto-clockout'],
  time: new Date().toISOString(),
}));

// ── External backup trigger ─────────────────────────────────────────────────
// Lets a free scheduler (e.g. cron-job.org) run the backup at 23:00 even when
// the free Render instance has gone to sleep — the request itself wakes it.
// Auto clock-out anyone who forgot, then notify the manager. Safe to call
// repeatedly (idempotent). Never throws — a clock-out hiccup must not block backup.
async function runAutoClockOutAndNotify() {
  try {
    const result = await runAutoClockOut();
    const msg = formatAutoClockOut(result);
    if (msg) await sendMessage(OWNER_CHAT_ID, msg);
    if (result.closed.length) console.log(`[AutoClockOut] closed ${result.closed.length} shift(s)`);
    return result;
  } catch (err) {
    console.error('[AutoClockOut] failed:', err.message);
    return { ok: false, error: err.message, closed: [] };
  }
}

async function triggerBackup(res) {
  try {
    await runAutoClockOutAndNotify(); // forgot-to-clock-out check rides the nightly trigger
    const result = await runNightlyBackup();
    // Stay silent when another scheduler already backed up today (de-dup), and
    // when Dropbox simply isn't configured yet. Only notify on a real backup/error.
    if (!result.skipped && (result.ok || !/not configured/.test(result.reason || ''))) {
      await sendMessage(OWNER_CHAT_ID, formatBackupResult(result));
    }
    res.json(result);
  } catch (err) {
    const detail = err.cause ? ` (${err.cause.code || err.cause})` : '';
    console.error('[Backup endpoint] failed:', err.message, detail);
    await sendMessage(OWNER_CHAT_ID, `⚠️ Nightly Dropbox backup failed: ${err.message}${detail}`);
    res.status(500).json({ ok: false, error: err.message + detail });
  }
}
app.get(`/tasks/backup/${WEBHOOK_SECRET}`,  (req, res) => triggerBackup(res));
app.post(`/tasks/backup/${WEBHOOK_SECRET}`, (req, res) => triggerBackup(res));

// Standalone auto clock-out trigger (also runs as part of the nightly backup).
app.all(`/tasks/clockout/${WEBHOOK_SECRET}`, async (req, res) => {
  const result = await runAutoClockOutAndNotify();
  res.json(result);
});

// ── Compliance intelligence snapshot (read-only, for Cowork weekly report) ───
// Token-secured (INTEL_API_TOKEN) via Bearer header or ?token=. Optional
// &from=YYYY-MM-DD&to=YYYY-MM-DD (London); defaults to the last 7 days.
const intelCors = (res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
};
app.options('/api/intel/snapshot', (req, res) => { intelCors(res); res.sendStatus(204); });
app.get('/api/intel/snapshot', async (req, res) => {
  intelCors(res);
  if (!(await authorisedIntel(req))) return res.status(401).json({ error: 'Unauthorized — pass a valid token (Bearer header or ?token=)' });
  try {
    const snapshot = await buildComplianceSnapshot({ from: req.query.from, to: req.query.to });
    res.json(snapshot);
  } catch (err) {
    console.error('[Intel] snapshot error:', err.message);
    res.status(500).json({ error: 'Failed to build snapshot' });
  }
});

// ── In-app assistant (chat from the website) ────────────────────────────────
// Reuses the same Claude + live kitchen context as Telegram. Gated by the
// caller's Supabase session token (only logged-in users); the app further
// limits the UI to chef level and above.
const chatCors = (res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
};
app.options('/chat', (req, res) => { chatCors(res); res.sendStatus(204); });
app.post('/chat', async (req, res) => {
  chatCors(res);
  try {
    const { message, token, history } = req.body || {};
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'Empty message' });

    // Verify the caller has a valid Supabase session AND is an admin.
    const { data, error } = await supabase.auth.getUser(token || '');
    if (error || !data?.user) return res.status(401).json({ error: 'Please sign in again.' });
    if (data.user.user_metadata?.role !== 'admin') return res.status(403).json({ error: 'The assistant is available to admins only.' });

    const name = data.user.user_metadata?.name || 'there';
    const hist = Array.isArray(history) ? history.slice(-12) : [];
    const reply = await handleMessage(String(message).slice(0, 2000), name, hist);
    res.json({ reply });
  } catch (err) {
    console.error('[Chat] error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
});

// Short in-memory conversation memory per Telegram chat, so multi-turn flows
// (like onboarding a team member) work. Resets on restart — that's fine.
const chatHistory = new Map(); // chatId → [{ role, text }]

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
          reply = formatBackupResult(await runNightlyBackup({ force: true }));
        } catch (e) {
          reply = `⚠️ Backup failed: ${e.message}`;
        }
      } else {
        reply = await handleCommand(command, name);
      }
      chatHistory.delete(chatId); // a slash command starts a fresh thread
    } else {
      const hist = chatHistory.get(chatId) || [];
      reply = await handleMessage(text, name, hist);
      const next = [...hist, { role: 'user', text }, { role: 'assistant', text: reply }].slice(-12);
      chatHistory.set(chatId, next);
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

// ── Nightly off-site backup cron (Europe/London) ────────────────────────────
cron.schedule(`${BACKUP_MINUTE} ${BACKUP_HOUR} * * *`, async () => {
  console.log('[Cron] Running nightly auto clock-out + Dropbox backup...');
  try {
    await runAutoClockOutAndNotify(); // close anyone who forgot to clock out at 22:00
    const result = await runNightlyBackup();
    console.log('[Cron] Backup:', result.skipped ? '↩︎ already done today' : result.ok ? `✅ ${result.path}` : `⚠️ ${result.reason}`);
    // Stay silent if already done today (another scheduler) or not configured.
    if (!result.skipped && (result.ok || !/not configured/.test(result.reason || ''))) {
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

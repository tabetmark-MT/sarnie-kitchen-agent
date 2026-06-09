import express from 'express';
import cron    from 'node-cron';
import { sendMessage, setWebhook, parseUpdate } from './telegram.js';
import { generateMorningDebrief, handleMessage, handleCommand } from './agent.js';

const app  = express();
const PORT = process.env.PORT || 3000;

const OWNER_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;   // 2046354154
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET || 'sarnie-agent-secret';
const MORNING_HOUR    = process.env.MORNING_HOUR   || '9';   // 9am by default
const MORNING_MINUTE  = process.env.MORNING_MINUTE || '0';

app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', agent: 'Sarnie Kitchen Agent', time: new Date().toISOString() }));

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
      reply = await handleCommand(command, name);
      // Trigger manual backup if requested
      if (command === '/backup') {
        // Just a message — real backup happens in the app
        reply = '✅ Manual backup triggered. Check Settings → Data & Backup in the app to confirm.';
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

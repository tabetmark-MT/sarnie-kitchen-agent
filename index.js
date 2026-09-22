import express from 'express';
import cron    from 'node-cron';
import { sendMessage, sendChatAction, setWebhook, parseUpdate } from './telegram.js';
import { generateMorningDebrief, handleMessage, handleCommand } from './agent.js';
import { runNightlyBackup, formatBackupResult } from './backup.js';
import { runInAppSnapshot, formatSnapshotResult } from './snapshot.js';
import { runHeartbeat, formatHeartbeat, heartbeatAlreadySentThisWeek } from './heartbeat.js';
import { runClockoutNudge, formatClockoutNudge, autoCloseRate } from './clockoutNudge.js';
import { runComplianceWatch, formatComplianceWatch, markComplianceAlerted, complianceScorecard } from './complianceWatch.js';
import { runAutoClockOut, formatAutoClockOut } from './autoClockout.js';
import { supabase, getSetting, upsertSetting, getComplianceSnapshot, markRun } from './supabase.js';
import { authorisedIntel, buildComplianceSnapshot } from './intel.js';

const app  = express();
const PORT = process.env.PORT || 3000;

const OWNER_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;   // 2046354154
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET || 'sarnie-agent-secret';
const MORNING_HOUR    = process.env.MORNING_HOUR   || '10';  // 10am — kitchen opening, when there's something to say
const MORNING_MINUTE  = process.env.MORNING_MINUTE || '0';
const BACKUP_HOUR     = process.env.BACKUP_HOUR    || '22';  // nightly Dropbox backup (after kitchen closes)
const BACKUP_MINUTE   = process.env.BACKUP_MINUTE  || '0';

app.use(express.json());

// When this process started. Render replaces the process on every deploy, so a
// bootedAt in the future of your last deploy proves the new code is running.
const BOOTED_AT = new Date().toISOString();

// ── Health check ──────────────────────────────────────────────────────────
// `build` used to be the hardcoded string 'live', which meant this endpoint
// could not tell fresh code from stale — the exact question we needed answered
// during the 14 Aug cutover and could not. Worse, Render's auto-deploy is off
// (the service is linked by public Git URL, so push webhooks never arrive), so
// "did my change actually ship?" is a question that comes up every single time.
// On 6 Aug the deploy hook was fired before the push and Render ran week-old
// code unnoticed.
//
// RENDER_GIT_COMMIT is set by Render on every build. Comparing it to
// `git rev-parse --short HEAD` locally answers the question in one look.
app.get('/', (req, res) => res.json({
  status: 'ok',
  agent: 'Sarnie Kitchen Agent',
  build: 'live',
  commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || 'local',
  branch: process.env.RENDER_GIT_BRANCH || 'local',
  bootedAt: BOOTED_AT,
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

// The app's own restore-point history (`public.backups`). Runs here rather than
// in the browser — see snapshot.js. Never allowed to break the Dropbox backup:
// that one is the disaster-recovery copy and takes priority.
async function runSnapshotAndNotify() {
  try {
    const result = await runInAppSnapshot();
    const msg = formatSnapshotResult(result);
    if (msg) console.log('[Snapshot]', result.counts);
    if (result.ok) await markRun('snapshot');
    return result;
  } catch (err) {
    console.error('[Snapshot] failed:', err.message);
    await sendMessage(OWNER_CHAT_ID,
      `⚠️ <b>In-app restore point failed</b>\n\n${err.message}\n\n`
      + `<b>The off-site Dropbox backup is separate and unaffected.</b>`);
    return { ok: false, error: err.message };
  }
}

async function triggerBackup(res) {
  try {
    await runAutoClockOutAndNotify(); // forgot-to-clock-out check rides the nightly trigger
    await runSnapshotAndNotify();     // in-app restore point, before the off-site copy
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

// ── Proactive risk watch ─────────────────────────────────────────────────────
// Polls the live compliance feed and pings the owner the MOMENT a new flag
// appears (fridge excursion, missing/overdue log, probe gap, allergen review
// due, expiring cert) — instead of waiting for the 9am debrief or a question.
// Only NEW flags alert (de-duped against the last set); an all-clear is sent
// when the last flag resolves. Seeds silently on first run. Open hours only.
async function runRiskCheck() {
  const hourLdn = Number(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }));
  if (hourLdn < 7 || hourLdn >= 22) return { skipped: 'outside 07:00–22:00 London' };

  const snap = await getComplianceSnapshot();
  if (!snap) return { skipped: 'compliance feed unavailable' };
  const flags = Array.isArray(snap.flags) ? snap.flags : [];

  const prevRaw = await getSetting('last_risk_flags');
  if (prevRaw === undefined || prevRaw === null) { // first run — seed, don't alert
    await upsertSetting('last_risk_flags', flags);
    return { seeded: true, flags: flags.length };
  }
  const prev = Array.isArray(prevRaw) ? prevRaw : [];
  const newFlags = flags.filter(f => !prev.includes(f));
  const cleared = prev.length > 0 && flags.length === 0;

  if (newFlags.length) {
    const msg = `⚠️ <b>Heads up Mark</b> — new compliance flag${newFlags.length > 1 ? 's' : ''} just now:\n`
      + newFlags.map(f => `• ${f}`).join('\n')
      + `\n\n<b>Overall:</b> ${snap.summary}`;
    await sendMessage(OWNER_CHAT_ID, msg);
  } else if (cleared) {
    await sendMessage(OWNER_CHAT_ID, '✅ All compliance flags cleared — you\'re green again.');
  }
  await upsertSetting('last_risk_flags', flags);
  await markRun('riskcheck');
  return { ok: true, newFlags, total: flags.length };
}

app.all(`/tasks/risk-check/${WEBHOOK_SECRET}`, async (req, res) => {
  try { res.json(await runRiskCheck()); }
  catch (e) { console.error('[RiskCheck] failed:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// ── In-app backup watch ──────────────────────────────────────────────────────
// The kitchen app takes its own snapshot into the `backups` table, separately
// from the nightly Dropbox job. It runs IN THE BROWSER, so it only happens when
// someone has the app open AND signed in — and on 21 Sep 2026 the 23:00
// end-of-day snapshot fired with no session, was refused, and told nobody. The
// app now shows that failure on the device it happened on, which does not help
// if the device is a tablet in a kitchen nobody is looking at.
//
// It cannot report to us itself, either: the failure mode IS "not signed in",
// and an unauthenticated client cannot write to the database to raise a flag.
// Anything the app could tell us, it can only tell us when it is working.
//
// So this watches from the outside, with the service key, and needs nothing
// from the app at all. It notices both "no snapshot happened" and "a snapshot
// happened but is partial".
const BACKUP_STALE_HOURS = 26; // a daily job, plus room for a late night

async function runBackupWatch() {
  const { data, error } = await supabase
    .from('backups')
    .select('created_at, backup_type, record_count')
    .eq('backup_type', 'daily')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`backups read failed: ${error.message}`);

  const latest = data?.[0] || null;
  const ageH = latest ? (Date.now() - new Date(latest.created_at).getTime()) / 3600000 : Infinity;
  const partial = latest?.record_count?.auditComplete === false;
  const stale = ageH > BACKUP_STALE_HOURS;

  // One alert per condition per day — a nag every 30 minutes is a flag people
  // learn to ignore, which is how the original failure stayed invisible.
  const todayLdn = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const state = stale ? `stale:${todayLdn}` : partial ? `partial:${todayLdn}` : 'ok';
  const prev = await getSetting('last_backup_watch');

  await markRun('backup_watch');
  if (state === 'ok') {
    if (prev && prev !== 'ok') {
      await sendMessage(OWNER_CHAT_ID, '✅ In-app backup is running again — a fresh snapshot landed.');
    }
    await upsertSetting('last_backup_watch', 'ok');
    return { ok: true, ageH: Number(ageH.toFixed(1)) };
  }
  if (prev === state) return { ok: true, alreadyAlerted: state }; // said it today

  const when = latest
    ? new Date(latest.created_at).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' })
    : 'never';
  // Since 22 Sep 2026 this snapshot is written HERE, by the nightly job — not by
  // a browser. So "stale" no longer means "nobody signed in"; it means my own
  // job did not run or could not write, which is a fault on this side.
  const msg = stale
    ? `⚠️ <b>Restore point has not been saved</b>\n\nLast one: <b>${when}</b> (${Math.floor(ageH)}h ago).\n\n`
      + `This is written by me on the nightly run, so this means that job did not run or could not write — worth a look at the agent.\n\n`
      + `<b>Your off-site Dropbox backup is separate and unaffected.</b> Nothing is lost; this copy is the in-app one.`
    : `⚠️ <b>Restore point is incomplete</b>\n\nThe snapshot from ${when} saved only part of the audit log — `
      + `that means it came from a browser rather than the nightly job.\n\n<b>The off-site Dropbox backup is unaffected.</b>`;

  await sendMessage(OWNER_CHAT_ID, msg);
  await upsertSetting('last_backup_watch', state);
  return { ok: true, alerted: state, ageH: Number(ageH.toFixed(1)) };
}

app.all(`/tasks/backup-watch/${WEBHOOK_SECRET}`, async (req, res) => {
  try { res.json(await runBackupWatch()); }
  catch (e) { console.error('[BackupWatch] failed:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// ── Day watch: one dispatcher for every time-of-day check ───────────────────
// Watchers 1 and 2 could each have had their own cron, endpoint and workflow —
// the pattern the repo already uses. Three jobs would have meant nine moving
// parts, three GitHub schedules and three things for the heartbeat to track,
// for two checks that both run during the same trading day.
//
// So they share one hourly pull instead. Each check decides for itself whether
// it is in its window, so adding another is a function call rather than another
// workflow. One schedule, one heartbeat entry per check, far less to go wrong.
//
// Alerts are delivered ONE message per pull, and each check is marked as fired
// only after the send succeeds — a Telegram outage must not silently consume
// the day's only warning.
async function runDayWatch() {
  const out = { at: new Date().toISOString() };

  // Compliance — hourly 11:00–22:30
  try {
    const c = await runComplianceWatch();
    out.compliance = c.skipped ? { skipped: c.skipped } : { alerts: c.alerts.length, bridge: c.bridgeReachable };
    const msg = formatComplianceWatch(c);
    if (msg) {
      await sendMessage(OWNER_CHAT_ID, msg);
      await markComplianceAlerted(c.state, c.today, c.alerts.map(a => a.check));
    }
  } catch (e) {
    console.error('[ComplianceWatch] failed:', e.message);
    out.compliance = { error: e.message };
  }

  // Clock-out nudge — 21:40–22:00 only, gated inside
  try {
    const n = await runClockoutNudge();
    out.clockoutNudge = n.skipped ? { skipped: n.skipped } : { open: n.open ?? 0 };
    const msg = formatClockoutNudge(n);
    if (msg) await sendMessage(OWNER_CHAT_ID, msg);
  } catch (e) {
    console.error('[ClockoutNudge] failed:', e.message);
    out.clockoutNudge = { error: e.message };
  }

  return { ok: true, ...out };
}

app.all(`/tasks/day-watch/${WEBHOOK_SECRET}`, async (req, res) => {
  try { res.json(await runDayWatch()); }
  catch (e) { console.error('[DayWatch] failed:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// ── Heartbeat: proof every other job is alive ───────────────────────────────
async function runHeartbeatAndSend({ force = false } = {}) {
  if (!force && await heartbeatAlreadySentThisWeek()) {
    return { ok: true, alreadySentThisWeek: true };
  }
  const r = await runHeartbeat();
  const rate = await autoCloseRate(7).catch(() => null);
  const score = await complianceScorecard(7).catch(() => null);

  let msg = `📋 <b>Monday check — everything that should have run</b>\n\n` + formatHeartbeat(r);
  if (rate) {
    msg += `\n\n<b>Shifts closed automatically</b> — ${rate.auto} of ${rate.total} (${rate.pct}%) over ${rate.days} days`
         + `\n<i>Target is under 3%. Every one of these is a placeholder finish time.</i>`;
  }
  if (score) {
    msg += `\n\n<b>Last 7 days</b> — ${score.tradingDays} trading days`
         + `\n• Opening ${score.opening} · Closing ${score.closing}`
         + `\n• Hot-holding ${score.hotholdingPerDay}/day <i>(4 required)</i>`
         + `\n• Deep clean ${score.deepClean}`;
  }
  await sendMessage(OWNER_CHAT_ID, msg);
  return { ok: true, stale: r.stale.length, healthy: r.healthy.length };
}

app.all(`/tasks/heartbeat/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    // Monday only, from 09:00 London — unless forced by hand.
    const force = 'force' in (req.query || {});
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
    if (!force && (p.weekday !== 'Mon' || Number(p.hour) < 9)) {
      return res.json({ skipped: `not Monday 09:00+ London (${p.weekday} ${p.hour}:00)` });
    }
    res.json(await runHeartbeatAndSend({ force }));
  } catch (e) { console.error('[Heartbeat] failed:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// Backup in-process poll every 30 min (fires when awake; the GitHub Actions ping
// guarantees it runs even when the free Render instance is asleep).
cron.schedule('*/30 * * * *', () => { runRiskCheck().catch(e => console.error('[RiskCheck cron]', e.message)); }, { timezone: 'Europe/London' });

// Backup watch once a morning, not every 30 minutes: "no snapshot yesterday" is
// a daily fact, and by 09:15 the night is settled and the instance is awake
// (wake-kitchen-agent runs 05:00–22:00). The /tasks endpoint above covers the
// case where Render slept through it.
cron.schedule('15 9 * * *', () => { runBackupWatch().catch(e => console.error('[BackupWatch cron]', e.message)); }, { timezone: 'Europe/London' });

// Day watch: hourly through trading hours. Each check gates its own window.
cron.schedule('5 11-22 * * *', () => { runDayWatch().catch(e => console.error('[DayWatch cron]', e.message)); }, { timezone: 'Europe/London' });
// The clock-out nudge needs 21:45 exactly, which the hourly :05 pull misses.
cron.schedule('45 21 * * *', () => { runDayWatch().catch(e => console.error('[DayWatch 21:45]', e.message)); }, { timezone: 'Europe/London' });
// Heartbeat: Monday 09:00 London.
cron.schedule('0 9 * * 1', () => { runHeartbeatAndSend().catch(e => console.error('[Heartbeat cron]', e.message)); }, { timezone: 'Europe/London' });

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
// Threads go stale after 2h idle: a half-finished conversation from days ago
// must not bleed into a fresh one.
const HISTORY_TTL_MS = 2 * 60 * 60 * 1000;
const chatHistory = new Map(); // chatId → { at: ms, turns: [{ role, text }] }
const getHistory = (chatId) => {
  const h = chatHistory.get(chatId);
  if (!h || Date.now() - h.at > HISTORY_TTL_MS) { chatHistory.delete(chatId); return []; }
  return h.turns;
};

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

  // Keep the "typing…" indicator alive — replies can take 15–30s when the brain
  // consults the SARNIE OS costing system. Telegram's typing status lasts ~5s,
  // so refresh it every 4s until we've sent the reply.
  await sendChatAction(chatId, 'typing');
  const typing = setInterval(() => sendChatAction(chatId, 'typing'), 4000);

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
      const hist = getHistory(chatId);
      reply = await handleMessage(text, name, hist);
      const turns = [...hist, { role: 'user', text }, { role: 'assistant', text: reply }].slice(-12);
      chatHistory.set(chatId, { at: Date.now(), turns });
    }
    clearInterval(typing);
    await sendMessage(chatId, reply);
  } catch (err) {
    clearInterval(typing);
    console.error('[Agent] Error handling message:', err.message);
    await sendMessage(chatId, '⚠️ Something went wrong. Try again in a moment.');
  }
});

// ── Morning debrief ─────────────────────────────────────────────────────────
// Sent once per London day, at/after 9am. The in-process cron only fires when
// the free Render instance happens to be awake, so a GitHub Actions ping also
// hits /tasks/debrief every morning (the request itself wakes the service) —
// the once-a-day guard makes the two triggers safe together.
async function runMorningDebrief() {
  const todayLdn = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const hourLdn = Number(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }));
  if (hourLdn < Number(MORNING_HOUR)) return { skipped: true, reason: `before ${MORNING_HOUR}:00 London` };
  if ((await getSetting('last_debrief_date')) === todayLdn) return { skipped: true, reason: 'already sent today' };
  const report = await generateMorningDebrief();
  await markRun('debrief');
  await sendMessage(OWNER_CHAT_ID, report);
  await upsertSetting('last_debrief_date', todayLdn);
  console.log('[Debrief] sent ✅');
  return { ok: true };
}

app.all(`/tasks/debrief/${WEBHOOK_SECRET}`, async (req, res) => {
  try { res.json(await runMorningDebrief()); }
  catch (e) { console.error('[Debrief] failed:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

cron.schedule(`${MORNING_MINUTE} ${MORNING_HOUR} * * *`, async () => {
  try { await runMorningDebrief(); }
  catch (err) { console.error('[Cron] Morning debrief failed:', err.message); }
}, { timezone: 'Europe/London' });

// ── Nightly off-site backup cron (Europe/London) ────────────────────────────
cron.schedule(`${BACKUP_MINUTE} ${BACKUP_HOUR} * * *`, async () => {
  console.log('[Cron] Running nightly auto clock-out + Dropbox backup...');
  try {
    await runAutoClockOutAndNotify(); // close anyone who forgot to clock out at 22:00
    await runSnapshotAndNotify();     // in-app restore point, before the off-site copy
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

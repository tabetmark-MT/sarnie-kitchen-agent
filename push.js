// Web Push delivery — sends scheduled reminders to all subscribed devices,
// firing even when the app is closed (Android + iOS 16.4+ installed PWA).
import webpush from 'web-push';
import { supabase, getSettings } from './supabase.js';

const PUB     = process.env.VAPID_PUBLIC_KEY;
const PRIV    = process.env.VAPID_PRIVATE_KEY;
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:tabet.mark@gmail.com';

let configured = false;
if (PUB && PRIV) { webpush.setVapidDetails(SUBJECT, PUB, PRIV); configured = true; }
export function pushConfigured() { return configured; }

async function getSubscriptions() {
  const { data } = await supabase.from('push_subscriptions').select('*');
  return data || [];
}

// Send a {title, body, url} payload to every subscribed device. Dead
// subscriptions (404/410) are pruned automatically.
export async function sendPushToAll(payload) {
  if (!configured) return { ok: false, reason: 'VAPID not configured' };
  const subs = await getSubscriptions();
  let sent = 0, removed = 0;
  await Promise.all(subs.map(async (row) => {
    try {
      await webpush.sendNotification(row.subscription, JSON.stringify(payload));
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', row.endpoint);
        removed++;
      } else {
        console.warn('[push] send failed:', e.statusCode, e.message);
      }
    }
  }));
  return { ok: true, sent, removed, total: subs.length };
}

// Current Europe/London time as { hm:"HH:MM", wdShort:"Mon", wdLong:"monday" }
function nowLondon() {
  const d = new Date();
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const wdShort = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short' }).format(d);
  const wdLong  = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/London', weekday: 'long' }).format(d).toLowerCase();
  return { hm: hm.replace('.', ':'), wdShort, wdLong };
}

// Runs every minute — fires any reminders whose configured time matches now.
export async function runReminderCron() {
  if (!configured) return;
  let settings;
  try { settings = await getSettings(); } catch { return; }
  const r = settings.reminders_v2;
  if (!r) return;
  const schedule = settings.schedule || {};
  const { hm, wdShort, wdLong } = nowLondon();
  const openToday = schedule[wdLong]?.open !== false; // default open if unknown

  const fires = [];
  if (r.openingClean?.enabled && r.openingClean.time === hm && openToday) fires.push(['☀️ Opening clean due', 'Start the opening kitchen checklist.']);
  if (r.closingClean?.enabled && r.closingClean.time === hm && openToday) fires.push(['🌙 Closing clean due', 'Start the closing kitchen checklist.']);
  if (r.cookChill?.enabled && r.cookChill.time === hm) fires.push(['🧊 Cook-chill log reminder', 'Complete the cook-chill log if batch cooking today.']);
  if (r.hotHolding?.enabled) (r.hotHolding.times || []).forEach(t => { if (t === hm) fires.push(['🌡️ Hot holding check due', 'Record all hot holding temperatures — EHO: ≥63°C.']); });
  if (r.deliveryLog?.enabled) (r.deliveryLog.times || []).forEach(t => { if (t === hm) fires.push(['🚚 Delivery log reminder', 'Check and log any deliveries received.']); });
  if (r.weeklyClean?.enabled && r.weeklyClean.day === wdShort && r.weeklyClean.time === hm) fires.push(['🧹 Weekly deep clean due', 'Weekly kitchen deep clean is due today.']);
  (r.custom || []).forEach(c => { if (c.enabled && c.time === hm) fires.push([`🔔 ${c.label}`, 'Scheduled reminder.']); });

  for (const [title, body] of fires) {
    const res = await sendPushToAll({ title, body, url: '/' });
    console.log('[push] fired:', title, JSON.stringify(res));
  }
}

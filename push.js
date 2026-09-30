// Web Push — real notifications to the kitchen's phones and tablets, delivered
// whether the app is open, closed, or the screen is locked (30 Sep 2026).
//
// Until now every reminder was a timer running INSIDE the app, so nothing
// arrived once the app was closed — on iPhone/iPad, almost never. Devices now
// register a push subscription (public.push_subscriptions) and this process
// sends to them.
//
// KEYS. The VAPID key pair is generated HERE on first use and stored in
// app_settings: `push_vapid_public` (readable — the app needs it to subscribe)
// and `push_vapid_secret` (admin-only by is_secret_setting). The private key
// never leaves this server and never passes through a person or a chat.
//
// DEAD DEVICES. A 404/410 from the push service means the subscription is gone
// (app deleted, permission revoked): the row is deleted. Other failures are
// counted and the row is dropped after 5 in a row, so a broken device can't
// quietly swallow every reminder forever.
import webpush from 'web-push';
import { supabase, getSetting, upsertSetting } from './supabase.js';

const SUBJECT = 'mailto:tabet.mark@gmail.com';
let ready = null;

export async function ensureVapid() {
  if (ready) return ready;
  let pub = await getSetting('push_vapid_public');
  let priv = await getSetting('push_vapid_secret');
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    // Written together; if a second instance raced us, re-read and use theirs.
    await upsertSetting('push_vapid_secret', k.privateKey);
    await upsertSetting('push_vapid_public', k.publicKey);
    pub = await getSetting('push_vapid_public');
    priv = await getSetting('push_vapid_secret');
    console.log('[push] generated a new VAPID key pair');
  }
  webpush.setVapidDetails(SUBJECT, pub, priv);
  ready = { publicKey: pub };
  return ready;
}

// payload: { title, body, url, tag, requireInteraction, action }
// filter: optional { userId } to send to one person's devices only.
export async function sendPush(payload, filter = {}) {
  await ensureVapid();
  let q = supabase.from('push_subscriptions').select('id,endpoint,p256dh,auth,fail_count,device_label');
  if (filter.userId) q = q.eq('user_id', filter.userId);
  const { data: subs, error } = await q;
  if (error) throw new Error(`push_subscriptions read failed: ${error.message}`);
  const out = { sent: 0, failed: 0, removed: 0, devices: (subs || []).length, errors: [] };
  const body = JSON.stringify(payload);
  await Promise.all((subs || []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body,
        { TTL: 60 * 60, urgency: payload.urgency || 'high' });
      out.sent++;
      await supabase.from('push_subscriptions').update({ last_ok_at: new Date().toISOString(), last_error: null, fail_count: 0 }).eq('id', s.id);
    } catch (e) {
      const code = e?.statusCode;
      if (code === 404 || code === 410 || (s.fail_count || 0) >= 4) {
        await supabase.from('push_subscriptions').delete().eq('id', s.id);
        out.removed++;
      } else {
        await supabase.from('push_subscriptions').update({ last_error: `${code || ''} ${String(e?.body || e?.message || e).slice(0, 200)}`.trim(), fail_count: (s.fail_count || 0) + 1 }).eq('id', s.id);
      }
      out.failed++;
      out.errors.push(`${s.device_label || 'device'}: ${code || e?.message}`);
    }
  }));
  return out;
}

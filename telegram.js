const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE  = `https://api.telegram.org/bot${TOKEN}`;

export async function sendMessage(chatId, text, opts = {}) {
  const post = (body) => fetch(`${BASE}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...body }),
  });
  // Send as HTML (for <b> KPI formatting); if Telegram rejects the markup,
  // retry as plain text so a report is never lost to a formatting error.
  const res = await post({ parse_mode: 'HTML', ...opts });
  try {
    const data = await res.clone().json();
    if (!data.ok) await post({ ...opts });
  } catch { /* ignore */ }
}

export async function setWebhook(url) {
  const res = await fetch(`${BASE}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, allowed_updates: ['message'] }),
  });
  return res.json();
}

export async function deleteWebhook() {
  const res = await fetch(`${BASE}/deleteWebhook`, { method: 'POST' });
  return res.json();
}

export function parseUpdate(body) {
  const msg = body?.message;
  if (!msg) return null;
  return {
    chatId:   msg.chat?.id,
    userId:   msg.from?.id,
    name:     msg.from?.first_name || 'Unknown',
    text:     msg.text || '',
    isCommand: msg.text?.startsWith('/'),
    command:  msg.text?.startsWith('/') ? msg.text.split(' ')[0].toLowerCase() : null,
  };
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE  = `https://api.telegram.org/bot${TOKEN}`;

// Telegram's hard limit is 4096 chars/message. Split longer replies (e.g. a
// detailed costing answer) on line boundaries so nothing is lost.
const TG_LIMIT = 4000;
function chunk(text) {
  const s = String(text ?? '');
  if (s.length <= TG_LIMIT) return [s];
  const out = [];
  let buf = '';
  for (const line of s.split('\n')) {
    if (line.length > TG_LIMIT) {                 // a single very long line
      if (buf) { out.push(buf); buf = ''; }
      for (let i = 0; i < line.length; i += TG_LIMIT) out.push(line.slice(i, i + TG_LIMIT));
      continue;
    }
    if (buf.length + line.length + 1 > TG_LIMIT) { out.push(buf); buf = ''; }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf) out.push(buf);
  return out;
}

export async function sendMessage(chatId, text, opts = {}) {
  const post = (body) => fetch(`${BASE}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, ...body }),
  });
  // Send as HTML (for <b> KPI formatting); if Telegram rejects the markup,
  // retry as plain text so a report is never lost to a formatting error.
  for (const part of chunk(text)) {
    const res = await post({ text: part, parse_mode: 'HTML', ...opts });
    try {
      const data = await res.clone().json();
      if (!data.ok) await post({ text: part, ...opts });
    } catch { /* ignore */ }
  }
}

// Show the "typing…" indicator while a slow reply is being generated.
export async function sendChatAction(chatId, action = 'typing') {
  try {
    await fetch(`${BASE}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch { /* non-critical */ }
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

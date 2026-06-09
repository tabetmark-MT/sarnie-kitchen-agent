import Anthropic from '@anthropic-ai/sdk';
import { buildKitchenContext } from './supabase.js';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are the Sarnie Social kitchen management agent — a smart, concise assistant for Mark Tabet who runs a food business in the UK.

You have access to real-time kitchen data from Supabase including:
- Daily, weekly and monthly checklist completions
- Staff activity and logins
- Temperature logs (cook-chill, hot holding, fridge checks)
- Delivery logs
- Audit trail

Your job is to:
1. Answer questions about kitchen operations clearly and concisely
2. Flag any compliance issues (missed checklists, temperature anomalies)
3. Give daily morning briefings
4. Help Mark stay on top of EHO (Environmental Health Officer) compliance

UK food safety rules you know:
- Hot holding: ≥63°C
- Chilling: ≤8°C (ideally ≤5°C)
- Cooking: ≥75°C
- Cool down: from 60°C to 8°C within 90 mins

Tone: professional but friendly. Use emojis sparingly. Be direct and brief — Max is busy running a kitchen.
Format responses for Telegram (plain text, use line breaks, avoid markdown tables).
Always respond in English.`;

// ── Morning debrief report ─────────────────────────────────────────────────
export async function generateMorningDebrief() {
  const context = await buildKitchenContext();

  const msg = await claude.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Generate the morning kitchen debrief report for today.

Here is the current kitchen data:
${context}

Format it as:
☀️ Good morning Mark — [day & date]

📋 YESTERDAY
[what was completed or missed]

⚠️ ACTION NEEDED
[anything overdue or concerning — if nothing, say "All clear ✅"]

👥 STAFF
[who's active]

Have a great shift! 💪`,
    }],
  });

  return msg.content[0].text;
}

// ── Handle a free-text or command message ──────────────────────────────────
export async function handleMessage(userText, userName) {
  const context = await buildKitchenContext();

  const msg = await claude.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 800,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Current kitchen data:\n${context}\n\n${userName} asks: ${userText}`,
      },
    ],
  });

  return msg.content[0].text;
}

// ── Handle specific slash commands ────────────────────────────────────────
export async function handleCommand(command, userName) {
  const context = await buildKitchenContext();

  const prompts = {
    '/start':     `Introduce yourself briefly to ${userName}. Tell them what you can do (morning reports, answer questions, check compliance). Keep it under 5 lines.`,
    '/report':    `Give a quick status report for today based on this data:\n${context}`,
    '/yesterday': `Summarise what happened yesterday in the kitchen based on this data:\n${context}`,
    '/temps':     `List all temperature readings from today and yesterday. Flag any that are out of range (hot holding <63°C, fridge >8°C). Data:\n${context}`,
    '/staff':     `Who has been active in the kitchen today? What did they complete? Data:\n${context}`,
    '/overdue':   `What checklists or tasks are overdue or missed? Be specific. Data:\n${context}`,
    '/backup':    `Tell ${userName} that a manual backup has been triggered and will complete shortly.`,
    '/help':      `List all available commands with a one-line description of each. Commands: /report, /yesterday, /temps, /staff, /overdue, /backup, /help. Also mention they can ask free-form questions.`,
  };

  const prompt = prompts[command] || prompts['/report'];

  const msg = await claude.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  return msg.content[0].text;
}

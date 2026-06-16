import Anthropic from '@anthropic-ai/sdk';
import { buildKitchenContext } from './supabase.js';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are the Sarnie Social kitchen management agent — a smart, concise assistant for Mark Tabet who runs a food business in the UK.

You have access to real-time kitchen data from Supabase including:
- Daily, weekly and monthly checklist completions
- Staff activity and logins
- Temperature logs (cook-chill, hot holding, fridge checks)
- Delivery logs
- Employee Management: who is clocked in right now, and hours worked per employee (today and this week)
- Audit trail

Your job is to:
1. Answer questions about kitchen operations clearly and concisely
2. Flag any compliance issues (missed checklists, temperature anomalies)
3. Give daily morning briefings
4. Help Mark stay on top of EHO (Environmental Health Officer) compliance
5. Report on employee hours and clock in/out activity. The EMPLOYEE MANAGEMENT section gives you: who is on shift now, total hours per employee for today/this week/this month, and a recent clock in/out log. When Mark asks for an employee report "per day", "per week", or "per month", use the matching totals; for a specific day or person, derive it from the RECENT CLOCK IN/OUT LOG. Always show each person's hours and, when relevant, their clock in/out times. If a requested period is older than the recent log shows, say so.

UK food safety rules you know:
- Hot holding: ≥63°C
- Chilling: ≤8°C (ideally ≤5°C)
- Cooking: ≥75°C
- Cool down: from 60°C to 8°C within 90 mins

IMPORTANT — how fridge temperatures are recorded at Sarnie Social:
Fridge temperature checks are NOT a separate log. They are built into the DAILY CLEANING checklist:
- The Opening section logs all fridge/saladette temperatures at the start of the day.
- The Closing section logs them again at the end of the day.
So if the daily Opening and Closing checks are completed, the fridge temperatures HAVE been recorded. Never report fridge temperature checks as "missing" or "not logged" when Opening/Closing are done — that is incorrect. Cook-chill and hot-holding logs are separate and additional.

Tone: professional but friendly. Be direct — Mark is busy running a kitchen. Always respond in English.

FORMATTING — clean KPI reports (Telegram renders HTML):
- Use HTML tags ONLY: <b>…</b> for titles/labels/key numbers, <i> for hints. NEVER use markdown (*, #, -, tables) — it shows as raw characters. Never output any other HTML tag or stray < > & characters.
- Lead with the metric, then the label: "<b>100%</b> Opening" not "Opening: done".
- Use status emojis as traffic lights: ✅ done/passing · ⚠️ attention · ❌ fail/missing · 🟢🟡🔴 overall health.
- Keep it scannable: a blank line between sections, one KPI per line, short.
- End every report with a "<b>📌 Bottom line</b>" — overall 🟢/🟡/🔴 + the single most important action (or "All clear ✅").
- Use the KPI SNAPSHOT block in the data as your source of truth for numbers; never invent figures.

DAILY ALL-SECTIONS REPORT — when Mark asks for a "daily report", "full report", "report on all sections" or similar, produce this exact structure (omit a metric only if there's genuinely no data):

<b>📊 Sarnie Social — Daily Report</b>
[weekday, date]

<b>🧹 Cleaning</b>
✅/⚠️ Opening · Service · Closing — plus weekly/monthly if relevant

<b>🌡️ Food Safety</b>
Cook-chill &amp; hot-holding entries + flag any temperature failures

<b>🚚 Deliveries</b>
Count today · rejected/partial · temp failures · ⚠️ expired supplier certs

<b>🥜 Allergens</b>
Matrix items declared · review status

<b>👷 Employees</b>
On shift now · hours today · anyone over a student limit / under a contract minimum

<b>📌 Bottom line</b>
🟢/🟡/🔴 overall + top action needed`;

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
    max_tokens: 1400,
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
    '/start':     `Introduce yourself briefly to ${userName}. Tell them what you can do (daily reports, answer questions, check compliance). Keep it under 5 lines.`,
    '/daily':     `Produce the full DAILY ALL-SECTIONS REPORT (cleaning, food safety, deliveries, allergens, employees) exactly in the layout from your instructions, using the KPI SNAPSHOT and data below. Make it a clean, scannable KPI report.\n${context}`,
    '/report':    `Give a concise KPI status report for today (key metrics per section + bottom line) based on this data:\n${context}`,
    '/yesterday': `Summarise what happened yesterday in the kitchen based on this data:\n${context}`,
    '/temps':     `List all temperature readings from today and yesterday. Flag any that are out of range (hot holding <63°C, fridge >8°C). Data:\n${context}`,
    '/staff':     `Who has been active in the kitchen today? What did they complete? Data:\n${context}`,
    '/overdue':   `What checklists or tasks are overdue or missed? Be specific. Data:\n${context}`,
    '/backup':    `Tell ${userName} that a manual backup has been triggered and will complete shortly.`,
    '/help':      `List all available commands with a one-line description of each. Commands: /daily, /report, /yesterday, /temps, /staff, /overdue, /backup, /help. Also mention they can ask free-form questions (e.g. "send me a daily report on all sections").`,
  };

  const prompt = prompts[command] || prompts['/report'];

  const msg = await claude.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: command === '/daily' ? 1600 : 900,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  return msg.content[0].text;
}

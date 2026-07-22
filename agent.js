import Anthropic from '@anthropic-ai/sdk';
import { buildKitchenContext, addClockInEmployee, addAppUser, getSetting } from './supabase.js';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Shared request shape: adaptive thinking (the model reasons before answering —
// sharper multi-step advice) + the big stable system prompt cached (~90% cheaper
// and faster on every follow-up and tool hop within 5 min). max_tokens includes
// thinking, so budgets are set with headroom.
const THINKING = { type: 'adaptive' };
const SYSTEM = () => [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
const textOf = (resp) =>
  resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

// ── Write tools: onboard team members. The agent must CONFIRM the details with
// the user (in a message) before calling these; see the ONBOARDING section of
// the system prompt. Gated upstream to the owner (Telegram) / admins (in-app).
const TOOLS = [
  {
    name: 'add_clockin_employee',
    description: 'Create a CLOCK IN/OUT employee (someone who clocks shifts). Adds them to the employees list and generates a unique 4-digit clock-in PIN. Only call AFTER the user has confirmed the details.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Full name' },
        role: { type: 'string', description: 'Job title, e.g. Chef, Kitchen Porter (free text)' },
        empType: { type: 'string', enum: ['student', 'contract', 'casual'], description: 'Employment type' },
        weeklyHours: { type: 'number', description: 'For student = weekly cap (e.g. 20); for casual = weekly target' },
        weeklyMin: { type: 'number', description: 'For contract = weekly minimum hours' },
        weeklyMax: { type: 'number', description: 'For contract = weekly maximum hours' },
        startDate: { type: 'string', description: 'Start date, YYYY-MM-DD (optional)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_app_login',
    description: 'Create an APPLICATION login (someone who signs into the app) with a permission level, and generate a unique 4-digit login PIN. Admin is NOT allowed here. Only call AFTER the user has confirmed the details.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Full name' },
        role: {
          type: 'string',
          enum: ['manager', 'head_chef', 'kitchen_lead', 'supervisor', 'chef', 'kitchen_porter', 'staff'],
          description: 'Permission level (admin is not permitted via chat)',
        },
      },
      required: ['name', 'role'],
    },
  },
  {
    name: 'ask_costing_brain',
    description: "Ask SARNIE OS (the sister inventory/costing system, the source of truth for supplier prices, ingredient costs, recipe/menu costings, gross-profit %, margins and supplier spend) a costing or pricing question. Use this WHENEVER Mark asks about the COST or PRICE of an ingredient/item/dish, recipe or menu costing, GP%/margin/food-cost %, what a supplier charges, or spend/purchasing — you do NOT have live prices yourself, SARNIE OS does. Pass a clear, self-contained question (include the item/dish name and any specifics). Do NOT use it for compliance, cleaning, temperatures, staff or rota questions — answer those yourself.",
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'A clear, self-contained costing/pricing question, e.g. "What does a portion of the Braised Beef Sarnie cost to make, and what GP% at £7.50?"' },
      },
      required: ['question'],
    },
  },
];

// Ask SARNIE OS's costing brain. Config via env (AGENT_CHAT_URL + AGENT_API_TOKEN)
// with app_settings fallback (sarnie_agent_chat_url / sarnie_agent_api_token) so it
// works before the Render env is set. Replies take ~15–30s.
async function askCostingBrain(question, convo = []) {
  const url = process.env.AGENT_CHAT_URL || (await getSetting('sarnie_agent_chat_url')) || 'https://sarnie-inventory-app.vercel.app/api/agent/chat';
  const token = process.env.AGENT_API_TOKEN || (await getSetting('sarnie_agent_api_token'));
  if (!token) return { ok: false, error: 'Costing brain not configured (set AGENT_API_TOKEN).' };
  // Send the recent conversation plus the focused question, so follow-ups keep
  // their thread on the SARNIE OS side (its API accepts message history).
  const messages = [...convo, { role: 'user', content: String(question || '') }].slice(-12);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Accept: 'application/json' },
      body: JSON.stringify({ messages, site: 'SS-ISL' }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) return { ok: false, error: `Costing brain returned HTTP ${res.status}` };
    const data = await res.json();
    const reply = data?.reply || data?.message || '';
    return reply ? { ok: true, answer: reply } : { ok: false, error: 'Costing brain returned no answer.' };
  } catch (e) {
    return { ok: false, error: `Could not reach the costing brain: ${e.message}` };
  }
}

async function runTool(name, input, convo = []) {
  try {
    if (name === 'add_clockin_employee') {
      const r = await addClockInEmployee(input || {});
      return { ok: true, type: 'clock-in employee', name: r.name, role: r.role, clockInPin: r.pin };
    }
    if (name === 'add_app_login') {
      const r = await addAppUser(input || {});
      return { ok: true, type: 'application login', name: r.name, permissionLevel: r.role, loginPin: r.pin };
    }
    if (name === 'ask_costing_brain') {
      return await askCostingBrain(input?.question, convo);
    }
    return { ok: false, error: `Unknown tool ${name}` };
  } catch (e) {
    if (e.message === 'ADMIN_BLOCKED') return { ok: false, error: 'Admin logins can only be created in the app (Settings), not via chat. Offer to create them as a manager instead, or tell Mark to add the admin in the app.' };
    return { ok: false, error: e.message };
  }
}

const SYSTEM_PROMPT = `You are the Sarnie Social kitchen agent — Mark Tabet's right hand for running his UK food business. Talk to Mark like a sharp, trusted operations manager who happens to live inside his app: conversational, proactive and genuinely helpful. Answer ANY question about the business naturally — not just canned reports. If he chats, chat back; if he asks for data, give it; if he asks for advice, reason it through and recommend. You are the same kind of thinking partner he'd get from a great assistant.

THE APP YOU LIVE IN (Sarnie Social — kitchen compliance app, dark kitchen at Deliveroo Editions, Islington):
- Cleaning checklists: Daily (Opening / Service / Closing — each signed off separately), Weekly deep clean (CL-003b), Monthly audit (CL-003c). Fridge/saladette temps are logged TWICE a day — morning (Opening) and evening (Closing).
- Food Safety logs: Cook-Chill (cook ≥75°C, chill to ≤8°C within 90 min), Hot-Holding (held ≥63°C; probe + record EVERY 2 HOURS, discard after 4 hours total), and Probe Calibration (DK-016 — TWO-POINT weekly: BOTH ice water 0°C AND boiling water 100°C, ±1°C; both points required each week).
- Delivery & Receiving: delivery log (temps on receipt, accept/partial/reject) and Suppliers with certificates (expiry tracked; the dashboard flags certs expiring within 60 days, not just expired).
- Allergens: 14-allergen matrix per menu item, 4-weekly allergen review that ALSO becomes due whenever the matrix is edited since the last sign-off (change-triggered), Natasha's Law / PPDS (the kitchen is dark/delivery so PPDS may be N/A).
- HACCP document library: policies & records by category (you can see the list in DOCUMENT LIBRARY). FS-006 is the Shelf Life Chart.
- Employee Management (Today / Team / Timesheets tabs): PIN clock in/out, hours per employee, weekly targets (student weekly limit, contract min–max, casual target), profiles & certificates with expiry. AUTO CLOCK-OUT rule: if someone forgets to clock out, the system auto-closes their shift at 22:00 (London) and flags it as "forgot to clock out".
- Reports: per-section CSV + PDF, a dedicated Fridge Temperature report (morning + evening per fridge, flags fails), and a full one-click EHO Records Pack PDF (cleaning, temperature control, fridge temps, deliveries, allergen reviews, probe calibration). Everything syncs across devices via Supabase and backs up nightly to Dropbox.
- EHO READINESS: when Mark asks "are we EHO ready" (or /eho, "compliance status", "how are we looking for the EHO"), answer from the EHO READINESS block in the data — it's the LIVE compliance feed (the exact same green/amber/red the app and the sister COO co-pilot see). Mirror its overall line, per-area colours and flags verbatim in your voice; never recompute or invent a different status. Lead with the overall RAG, walk each area (🟢/🟡/🔴), then the flags to fix now. The dashboard's week KPIs compare WEEK-TO-DATE vs the same point last week (honest deltas), count only OPEN days (Sunday closed is excluded), and "Notes & corrective actions" is a neutral count, not bad news.
- Cook-Chill page has a "Label helper": pick a product and it computes the use-by/discard date from the FS-006 shelf-life schedule (production day = Day 1). If Mark or staff ask "what use-by do I write on X", point them there (or answer from FS-006 yourself: e.g. Mayo Habanero RC-26 = 3 days, Habanero Molasses RC-08 = 5 days, Cookie Dough RC-10 = 24 hrs).
- The fridges are numbered: #1 Single Door Upright, #2 Three Door Counter, #3 Three Door Salad, #4 Under Counter — use these names, they match the checklists, reports and your fridge analytics.
- SUPPLIERS & ITEMS COME LIVE FROM SARNIE OS: the delivery-logging screen's supplier and item pickers read the sister inventory system's live feed (SARNIE OS is the single source of truth for supplier/item master data; changes there appear in the kitchen app within ~10 minutes). So if Mark asks how to add or rename a supplier or item, the answer is: do it in SARNIE OS, it flows through automatically. The kitchen app's own Suppliers page remains the home of the EHO side — supplier CERTIFICATES (expiry-tracked), approval numbers and delivery-check history stay there.

RECENT FEATURES YOU KNOW INSIDE OUT (answer how-to and status questions on all of these confidently):
- EMPLOYEE MANAGEMENT (reworked): the sidebar has two entries — "Clock In / Out" (staff clock in/out) and "Employee Profile" (management only). Inside, in-page tabs are Overview · Clock In/Out · Employee Profiles · Timesheets. OVERVIEW is a labour-cost KPI board (management only): labour cost this week vs same point last week, hours vs target, on shift now, avg cost/shift, a daily-cost chart, projected-month run-rate, and a cost leaderboard. Each employee has a £/hr PAY RATE (set on their profile) so every shift is costed from the real clock in/out. EMPLOYEE PROFILE is a full page (Details · Certificates · Hours & Pay) with photo, contact + emergency contact, certificates with expiry, a 6-week hours chart, recent costed shifts. Pay/cost and profiles are visible to ADMIN + MANAGER only. You can answer labour-cost questions from the EMPLOYEE LABOUR COST block in the data (this is the same rate×hours the app shows). If rates aren't set, tell Mark to add £/hr on each Employee Profile.
- DASHBOARD: the home Employees card shows a live labour KPI (labour this week + projected month) for management.
- RECIPE LIBRARY (live from SARNIE OS): a staff-facing page of recipe cards (method, ingredients, allergens, shelf life, equipment) read live from SARNIE OS — the single source of truth for recipes and RC codes. Menu items + prices come from there too. If Mark asks about a recipe/method/DLC, it's in the Recipe Library (or ask the costing brain for cost).
- CANONICAL RC CODES: RC-27 = Mayo Habanero, RC-28 = Cherry Chipotle, RC-29 = Mild Peri Peri (reserved, being built in SARNIE OS). Retired, never reused: RC-11, RC-13, RC-23. Two new sauces are in the allergen matrix + FS-006 shelf-life chart (v1.8): Cherry Chipotle (RC-28) 3-day, sulphites; Mild Peri Peri (RC-29) 3-day, contains milk/soy/sulphites. The Cook-Chill LABEL HELPER now pulls shelf lives live from the recipe feed (dlcDays), so use-by labels never drift.
- HS-008 FIRE SAFETY doc is now complete (assembly point: laundry in front of the kitchen; smoking area signposted outside; extinguisher at kitchen entrance; fire blanket kitchen entrance on the left; emergency contact = fire marshal poster at the entrance).
- PROACTIVE RISK ALERTS: you (the agent) watch the compliance feed and Telegram Mark the moment a NEW flag appears (fridge excursion, overdue/missing log, probe gap, allergen-review due, expiring cert) — so he hears about issues in the moment, not just at 9am.
- SYSTEM HEALTH: admins have a System Health panel in Settings showing every bridge (recipes, suppliers, allergens, compliance, costing brain, agent) + backup/debrief status, green/amber/red.
- All dates/times across the app and your reports are Europe/London (BST/GMT aware), independent of any device's clock.

WHAT YOU CAN SEE (in the data block each message): today's & yesterday's completions, a computed KPI snapshot, rolling compliance trends (last 7/30 days), the KPI DASHBOARD (this week vs last week — compliance %, records logged, flagged items, active days, and the 14-day compliance trend average; these are the exact figures on the app's home dashboard, so answer "how are we doing vs last week" type questions straight from here), FRIDGE TEMPERATURE ANALYTICS (per appliance over 30 days — pass rate, average, latest reading, fails, and a "trending warmer" drift flag — so you CAN answer "which fridge is failing/warming most"; these come from the daily Opening & Closing checks), employee hours & targets + recent clock log, the document library, suppliers/deliveries, and the audit trail. Use these as your source of truth — never invent numbers. If something genuinely isn't in the data (e.g. a date older than the history shown, or document contents), say so plainly and point Mark to the app's Reports/EHO export.

SALES & LABOUR %: sales come from the SALES block in your kitchen data (fed live by SARNIE OS) — never from memory, never estimated from order counts, menu volumes or anything else. If that block says the feed is not connected, tell Mark plainly that sales aren't wired up yet and refuse to give a number; a wrong revenue figure makes every labour percentage wrong too. Labour % of sales = labour cost ÷ gross sales for the SAME period — never mix periods. Roughly 25–35% is healthy for a kitchen like this; flag it only when it is clearly outside that. If any staff member is on £0/hr, every labour total understates the real cost — say so whenever you quote one.

COSTING & PRICING (via SARNIE OS): you do NOT hold ingredient prices, recipe costs, GP%/margins or supplier spend — the sister inventory system SARNIE OS does. Whenever Mark asks anything about what something COSTS or is PRICED at (an ingredient, a dish, a recipe/menu costing, food-cost %, gross profit, what a supplier charges, purchasing spend), call the ask_costing_brain tool with a clear self-contained question and relay its answer in your own voice — never guess a price. Keep using your own kitchen data for compliance, cleaning, temperatures, staff and rota. If the costing brain can't be reached, say the costing system is unavailable right now rather than inventing figures.

YOU HAVE EMPLOYEE DATA — do not deny it. The data block includes CLOCKED IN TODAY, Currently on shift, Hours TODAY/THIS WEEK/THIS MONTH, WEEKLY HOURS vs TARGET, the RECENT CLOCK IN/OUT LOG, and EMPLOYEE PROFILES & CERTIFICATES. These come from the app's clock in/out system (PIN clock-ins) and the Team tab, NOT the audit trail. Never tell Mark you "don't have access to employee hours / shift / timesheet / profile data" or that you can only see logins from the audit trail — that is wrong, you have the real data. Only say data is missing if a specific section is genuinely empty.

THE EMPLOYEE TAB — you are the expert on it; answer anything Mark asks here confidently from the data:
- Employee Management has three tabs: Today (who's clocked in / on shift now), Team (profiles: role, start date, employment type, weekly target, and uploaded certificates with expiry), and Timesheets (hours per person, exportable).
- Employment types & the rules you enforce: STUDENT = a weekly HOURS CAP (default 20h — this is the UK student visa term-time limit; flag anyone over it as a visa-compliance risk). CONTRACT = a weekly min–max band (flag under-min or over-max). CASUAL = a weekly target (flag if well under). Use the WEEKLY HOURS vs TARGET lines for who's over/under.
- Certificates: read EMPLOYEE PROFILES & CERTIFICATES for right-to-work / food-hygiene / training certs and their expiry. Proactively flag any EXPIRED or expiring within 60 days (e.g. "Hamza's food hygiene cert expires in 21 days — book a renewal"). This is the same 60-day window the app dashboard uses.
- Hours: break down by any day/week/month from the Hours lines + the RECENT CLOCK IN/OUT LOG (each shift's in→out + duration). Auto clock-out: if someone forgets, the app closes their shift at 22:00 London and marks it "forgot to clock out" — call those out.
- You are read-only: you can't clock people in, edit shifts, set PINs or upload certs — tell Mark it's done in Employee Management and where, and offer to walk him through it.

ANY QUESTION ABOUT THE APP — you know this product inside out (see "THE APP YOU LIVE IN" above). Answer feature/how-to/where-is-it questions naturally ("where do I log a delivery?", "how does the allergen review work?", "what's in the EHO pack?"). If a question needs a specific record you can't see (a document's full text, a date older than the history in the data block), say so plainly and point Mark to the exact place in the app (Reports, the document library, the relevant tab).

TRADING HOURS — never nag about work that isn't due yet (this is a hard rule):
- Always read the TRADING HOURS line first. If the kitchen hasn't OPENED yet, the day has not started: the opening clean, fridge temps and today's logs are NOT missing, NOT late and NOT a red flag. Never chase them, never say "0% done" or "overall red" pre-service. Say something like "kitchen opens at 10:00 — nothing due yet" instead.
- If today is CLOSED, nothing is due at all — don't list any check as outstanding.
- The closing clean is only expected after closing time. Weekly/monthly tasks are period-based and can be mentioned any time.
- A 9am briefing on a 10am-opening day should be forward-looking ("here's what's coming up today"), never a telling-off about checks that aren't due for another hour.

ACCURACY — this is critical, never break it:
- ONLY ever name people, times and numbers that appear verbatim in the data block. NEVER invent or guess a name, a clock time, an hours figure or a shift. No illustrative or example data — only real records.
- "Who clocked in today" = read the CLOCKED IN TODAY list exactly. It is the complete list; if it shows 2 people, exactly 2 people clocked in — do not add anyone else. If it's empty, say nobody has clocked in today.
- "On shift now" = only those in the "Currently on shift" line. Someone with a clock-out time is NOT on shift.
- For weekly/monthly/per-person hours, use the matching Hours / WEEKLY HOURS vs TARGET lines. For a specific past day, use the RECENT CLOCK IN/OUT LOG; if the day isn't in that log, say you don't have it rather than estimating.
- If you're ever unsure or the data is missing, say so — never fill the gap with a plausible-sounding example.

HOW TO BE A TRUE AGENT:
- Be conversational and human. Match Mark's energy — short answer for a short question, deeper dive when he wants one. It's fine to have normal conversation.
- Be proactive: when you spot a real risk (missed closing, temp failure, expired cert, someone over a student visa limit, allergen review overdue) flag it and suggest the fix.
- Give real operational advice when asked (rotas, cost, compliance, EHO prep) — reason it out, don't just restate data.
- You are read-only for records EXCEPT one thing: you can ONBOARD TEAM MEMBERS (see the ONBOARDING section). You still can't clock people in, edit shifts, submit checklists or edit data — for those, tell Mark it's done in the app and where.
- Never claim a check is missing if the data shows it's covered (see the fridge-temp note below).

ONBOARDING TEAM MEMBERS — you can add two kinds of people, using your tools. Use <b> tags for emphasis here too (never markdown **). When Mark asks to "add a team member" (or add staff / new starter / new person), do NOT guess which kind — ask him first:
"Sure — is this a <b>clock in/out member</b> (someone who just clocks shifts) or an <b>application team member</b> (someone who logs into the app with a permission level)? And what's their name?"
- CLOCK IN/OUT member → use add_clockin_employee. Collect: name (required); optionally job title, employment type (student / contract / casual) and the weekly hours that go with it (student = weekly cap, e.g. 20h; contract = min–max; casual = target), and start date. Don't force the optional bits — name alone is enough if that's all he gives.
- APPLICATION team member → use add_app_login. Collect: name and the PERMISSION LEVEL. Offer the levels plainly: manager, head chef, kitchen lead, supervisor, chef, kitchen porter, staff. ADMIN is NOT available via chat — if he asks for admin, say admins have to be created in the app (Settings) and offer to set them up as a manager instead.
- ALWAYS confirm before creating: read the details back ("Add <b>Sarah</b> as a <b>Manager</b> application login — shall I create it?") and only call the tool after he says yes.
- You generate the PIN. After creating, tell him the person's name, their type/level, and the 4-digit PIN clearly (e.g. "Done — <b>Sarah</b> is set up as a <b>Manager</b>. Her login PIN is <b>4821</b>. She can sign in with it now.") so he can pass it on.
- If a tool returns an error (duplicate name, admin blocked, etc.), explain it plainly and suggest the fix. Never invent a PIN or claim success unless the tool returned ok:true.

Your core jobs: daily briefings & KPI reports, compliance/EHO watch, employee hours & targets, answering anything about the operation, and being a smart sounding board.

UK food safety rules you know:
- Hot holding: ≥63°C at all times; probe + record every 2 hours; discard after 4 hours total
- Chilling / fridge storage: ≤8°C (target ≤5°C; >8°C = fail)
- Cooking: ≥75°C (or 70°C for 2 min)
- Cool down: from 60°C to 8°C within 90 mins
- Probe calibration: two-point weekly — ice water 0°C AND boiling water 100°C (±1°C)

IMPORTANT — how fridge temperatures are recorded at Sarnie Social:
Fridge temperature checks are NOT a separate log. They are built into the DAILY CLEANING checklist:
- The Opening section logs all fridge/saladette temperatures at the start of the day.
- The Closing section logs them again at the end of the day.
So if the daily Opening and Closing checks are completed, the fridge temperatures HAVE been recorded. Never report fridge temperature checks as "missing" or "not logged" when Opening/Closing are done — that is incorrect. Cook-chill and hot-holding logs are separate and additional.

Tone: professional but friendly. Be direct — Mark is busy running a kitchen. Always respond in English.

FORMATTING — talk like Mark's sharp right hand, not a form:
- Write the way a trusted operator would message him: warm, direct, natural sentences. This must read like a PERSON giving him the rundown — not a rigid template of ticked rows.
- Open with a one-line human read of the day (e.g. "Evening Mark — solid day, everything's covered bar one thing to watch.").
- Group by area with a short <b>bold label</b>, then a sentence or two that weaves the numbers in — don't stack them one-metric-per-line with a tick on each. Bold ONLY the key figures/verdicts with <b>…</b>. Telegram renders HTML and the app renders it too, so <b> is safe. NEVER use markdown (*, #, -, tables) or any tag other than <b> and <i> — anything else shows as raw characters.
- Use a status emoji only where it carries a real signal (✅ all good · ⚠️ watch · ❌ problem) — not on every line.
- Keep it tight: a blank line between areas, no walls of text, and don't print zeros for areas with nothing to say — just skip them or fold them into the summary.
- Close with a natural bottom line — the single thing that matters most today, or "Nothing needs you — all clear ✅".
- Ground every number in the data block; never invent figures.

DAILY REPORT — when Mark asks for a "daily report", "full report", "report of today" or similar, give the CONVERSATIONAL version below (not a checklist dump). Lead with a greeting + one-line verdict, then a few short bold-labelled paragraphs, only for areas that actually have something worth saying:
- <b>Cleaning</b> — opening/service/closing done (name who + times if notable), fridge temps logged morning &amp; evening.
- <b>Food safety</b> — cook-chill &amp; hot-holding counts, any temperature issues, probe calibration status.
- <b>Deliveries</b> — count, any rejects/temp fails, certs expiring.
- <b>Allergens</b> — only if a review is due.
- <b>Team</b> — who's on, hours, anyone over/under target.
Then one closing line: the most important thing (or all-clear). Example opener + tone: "Evening Mark — clean day. <b>Cleaning</b> all signed off (Hamza opened 09:56, closed 20:36), fridge temps logged morning and evening. <b>Food safety</b>: <b>6</b> cook-chill and <b>2</b> hot-holding logs, probe's calibrated for the week. Nothing needs you tonight — all clear ✅."`;

// ── Morning debrief report ─────────────────────────────────────────────────
// Dated changelog of what's shipped. The morning brief calls out anything from
// the last couple of days so Mark always knows what's new in his app.
// Add a new entry (newest last) whenever a feature ships.
const SYSTEM_UPDATES = [
  { date: '2026-07-20', text: 'Employee Management rebuilt — separate <b>Clock In/Out</b> and <b>Employee Profile</b> tabs, plus a labour-cost Overview (cost per shift / week / month vs projected, live on-shift labour, cost leaderboard).' },
  { date: '2026-07-20', text: 'Full employee profiles — photo, contact + emergency contact, certificates with expiry, and a 6-week hours chart. Add a <b>£/hr pay rate</b> on each profile to switch all the cost figures on.' },
  { date: '2026-07-20', text: 'Dashboard now shows <b>labour today / this week / this month</b> with projections.' },
  { date: '2026-07-20', text: '<b>Recipe Library</b> — live recipe cards (method, ingredients, allergens, shelf life) straight from SARNIE OS, so codes and DLCs never drift.' },
  { date: '2026-07-20', text: 'Two new sauces live: <b>Cherry Chipotle (RC-28)</b> and <b>Mild Peri Peri (RC-29)</b> — allergens declared and on the FS-006 shelf-life chart.' },
  { date: '2026-07-20', text: 'Mobile polish — no more zoom-jump when typing in a form, instant taps, smoother scrolling and slide-up forms.' },
  { date: '2026-07-21', text: 'Fixed: compliance alerts no longer chase the opening clean before the kitchen has opened.' },
];

// Updates from the last `days` days (London dates), newest first.
function recentUpdates(days = 2) {
  const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const cutoff = new Date(new Date(todayKey).getTime() - days * 86400000).toISOString().slice(0, 10);
  return SYSTEM_UPDATES.filter(u => u.date >= cutoff).reverse();
}

export async function generateMorningDebrief() {
  const context = await buildKitchenContext();
  const updates = recentUpdates(2);

  const msg = await claude.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 4000,
    thinking: THINKING,
    system: SYSTEM(),
    messages: [{
      role: 'user',
      content: `It's the morning debrief — message Mark to start his day, in your usual voice: a sharp right hand giving him the rundown over a coffee. Flowing prose, NOT a form, NOT bullet points, NOT headings. <b> on key numbers only.

Write it as a few natural paragraphs, in this order:

1. Greeting + an honest read of where things stand — yesterday's context (what got done, what was quiet or closed) and anything he's already ticked off this morning. Tone like: "Morning Mark — quiet Sunday behind us (closed day, nothing expected), and you've already knocked out the allergen monthly review this morning, so that's ticked for the cycle. ✅"
2. The one thing that needs him today, if there is one — and be trading-hours honest: if the kitchen hasn't opened yet, nothing is late, so frame it as what's coming, never as a miss. Then sweep everything that's clean in one sentence (probe, supplier certs, staff certs, fridges) so he knows what he doesn't have to chase.
3. A tight KPI beat woven in: EHO status (🟢/🟡/🔴), then — only if the data is actually there — yesterday's/this week's <b>sales</b>, labour cost, and <b>labour as a % of sales</b>, e.g. "EHO 🟢, sales <b>£2,140</b> this week against <b>£298</b> labour — <b>13.9%</b>". Rules you must not break:
   - If the SALES block says the feed is not connected, say nothing about revenue at all. Do NOT guess, estimate or infer a sales figure from anything else.
   - Only compare labour and sales over the SAME period. Never put a week of wages against a day of sales.
   - If anyone is on £0/hr, the labour figure is understated — say so in passing rather than quoting it as exact.
   - Healthy labour is roughly 25–35% of sales. Call it out only if it is clearly outside that, and say plainly what it was.
4. Who's on the floor, with clock-in times.
5. 💡 <b>Worth a look:</b> exactly ONE improvement point — a concrete, specific suggestion drawn from the real data above (a fridge trending warmer, labour running over projection, a cert expiring in a few weeks, a check that's slipped two weeks running, a supplier gap). One or two sentences, actionable. If the data genuinely offers nothing, suggest one small operational tightening instead — never invent a problem.
${updates.length ? `6. 🆕 <b>New in the app:</b> then briefly tell him what's just shipped, in plain operator language (what it does for him / what he should do with it), not developer changelog-speak:\n${updates.map(u => `   - ${u.text}`).join('\n')}` : ''}
${updates.length ? '7' : '6'}. Close with "<b>Bottom line:</b>" and the single most important thing for today — or that nothing needs him and he's all square ✅.

Keep it warm, specific and honest. Never chase work that isn't due yet.

Current kitchen data:
${context}`,
    }],
  });

  return textOf(msg);
}

// ── Handle a free-text message, with conversation memory + write tools ──────
// `history` is the prior turns [{ role:'user'|'assistant', text }] so multi-turn
// flows (like onboarding a team member) work. Fresh kitchen data is injected on
// the current turn only.
export async function handleMessage(userText, userName, history = []) {
  const context = await buildKitchenContext();

  const cleanHistory = (history || [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.text)
    .slice(-12);
  const messages = cleanHistory.map(m => ({ role: m.role, content: String(m.text) }));
  while (messages.length && messages[0].role !== 'user') messages.shift(); // API requires a user turn first
  messages.push({ role: 'user', content: `Current kitchen data:\n${context}\n\n${userName} says: ${userText}` });

  // Recent plain-text turns for the costing brain, so follow-ups ("and at
  // £8.50?") reach SARNIE OS with their thread intact.
  const convo = [...cleanHistory.map(m => ({ role: m.role, content: String(m.text) })),
                 { role: 'user', content: String(userText) }].slice(-10);

  // Tool-use loop: the model may ask for details, confirm, then call a tool.
  for (let hop = 0; hop < 6; hop++) {
    const resp = await claude.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 6000,
      thinking: THINKING,
      system: SYSTEM(),
      tools: TOOLS,
      messages,
    });
    if (resp.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: resp.content });
      const results = [];
      for (const block of resp.content) {
        if (block.type === 'tool_use') {
          const out = await runTool(block.name, block.input, convo);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
        }
      }
      messages.push({ role: 'user', content: results });
      continue; // let the model narrate the result
    }
    return textOf(resp) || 'Done.';
  }
  return 'That took more steps than expected — please try again.';
}

// ── Handle specific slash commands ────────────────────────────────────────
export async function handleCommand(command, userName) {
  const context = await buildKitchenContext();

  const prompts = {
    '/start':     `Introduce yourself briefly to ${userName}. Tell them what you can do (daily reports, answer questions, check compliance). Keep it under 5 lines.`,
    '/daily':     `Give ${userName} the conversational DAILY REPORT from your instructions — cleaning, food safety, deliveries, allergens, team — as if you're his right hand giving him the rundown, not a form. Weave the numbers into natural sentences, skip empty areas, end with the one thing that matters. Use the data below.\n${context}`,
    '/report':    `Give ${userName} a quick, natural status read for today — the key numbers per area in a sentence or two each, then the one thing that matters most. Conversational, not a template. Data:\n${context}`,
    '/yesterday': `Summarise what happened yesterday in the kitchen based on this data:\n${context}`,
    '/temps':     `List all temperature readings from today and yesterday. Flag any that are out of range (hot holding <63°C, fridge >8°C). Data:\n${context}`,
    '/staff':     `Who has been active in the kitchen today? What did they complete? Data:\n${context}`,
    '/overdue':   `What checklists or tasks are overdue or missed? Be specific. Data:\n${context}`,
    '/eho':       `Give ${userName} the EHO-readiness rundown. Use the EHO READINESS block in the data VERBATIM — lead with the overall line, then each area on its own line with its colour dot (🟢 green / 🟡 amber / 🔴 red) and the one-line detail, then the flags needing attention now (or "all clear ✅"). Do NOT recompute or re-colour anything — mirror the feed exactly, just in your voice. Data:\n${context}`,
    '/help':      `List all available commands with a one-line description of each. Commands: /daily, /report, /eho, /yesterday, /temps, /staff, /overdue, /backup, /help. Also mention they can ask free-form questions (e.g. "are we EHO ready?" or "send me a daily report") and can add team members by chat ("add a team member").`,
  };

  const prompt = prompts[command] || prompts['/report'];

  const msg = await claude.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: command === '/daily' ? 5000 : 3500,
    thinking: THINKING,
    system: SYSTEM(),
    messages: [{ role: 'user', content: prompt }],
  });

  return textOf(msg);
}

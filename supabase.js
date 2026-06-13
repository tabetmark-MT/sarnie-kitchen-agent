import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ── Fetch today's completions ──────────────────────────────────────────────
export async function getTodayCompletions() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const { data } = await supabase
    .from('completions')
    .select('*')
    .gte('date', start.toISOString())
    .order('date', { ascending: false });
  return data || [];
}

// ── Fetch yesterday's completions ──────────────────────────────────────────
export async function getYesterdayCompletions() {
  const start = new Date();
  start.setDate(start.getDate() - 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  const { data } = await supabase
    .from('completions')
    .select('*')
    .gte('date', start.toISOString())
    .lte('date', end.toISOString())
    .order('date', { ascending: false });
  return data || [];
}

// ── Fetch completions for a date range ────────────────────────────────────
export async function getCompletionsRange(daysBack = 7) {
  const start = new Date();
  start.setDate(start.getDate() - daysBack);
  start.setHours(0, 0, 0, 0);
  const { data } = await supabase
    .from('completions')
    .select('*')
    .gte('date', start.toISOString())
    .order('date', { ascending: false });
  return data || [];
}

// ── Single app_settings value get/set (used for backup de-duplication) ─────
export async function getSetting(key) {
  const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
  return data?.value;
}
export async function upsertSetting(key, value) {
  await supabase.from('app_settings').upsert([{ key, value, updated_at: new Date().toISOString() }]);
}

// ── Full database snapshot (for off-site backups) ──────────────────────────
export async function getAllData() {
  const tables = ['app_users', 'app_settings', 'checklists', 'completions', 'audit_log'];
  const out = {};
  for (const t of tables) {
    const { data, error } = await supabase.from(t).select('*');
    if (error) console.warn(`[Backup] could not read ${t}:`, error.message);
    out[t] = error ? [] : (data || []);
  }
  return out;
}

// ── Fetch all users ────────────────────────────────────────────────────────
export async function getUsers() {
  const { data } = await supabase
    .from('app_users')
    .select('*')
    .eq('active', true)
    .order('name');
  return data || [];
}

// ── Fetch recent audit log ─────────────────────────────────────────────────
export async function getRecentAudit(limit = 50) {
  const { data } = await supabase
    .from('audit_log')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(limit);
  return data || [];
}

// ── Fetch settings ─────────────────────────────────────────────────────────
export async function getSettings() {
  const { data } = await supabase.from('app_settings').select('*');
  if (!data) return {};
  return Object.fromEntries(data.map(s => [s.key, s.value]));
}

// ── Build a rich context summary for Claude ───────────────────────────────
export async function buildKitchenContext() {
  const [todayC, yesterdayC, users, audit, settings] = await Promise.all([
    getTodayCompletions(),
    getYesterdayCompletions(),
    getUsers(),
    getRecentAudit(30),
    getSettings(),
  ]);

  const CHECKLIST_NAMES = {
    daily: 'Daily checks',
    weekly: 'Weekly deep clean',
    monthly: 'Monthly compliance',
    cookchill: 'Cook-chill log',
    hotholding: 'Hot holding log',
    allergen_monthly: 'Allergen monthly review',
    allergen_change: 'Allergen change record',
  };

  const fmt = (c) => {
    const id = c.checklist_id || c.checklistId;
    const sec = c.section_id || c.sectionId;
    const by = c.completed_by_name || c.completedByName || 'Unknown';
    const tasks = c.tasks || {};
    const done = Object.values(tasks).filter(Boolean).length;
    const total = Object.keys(tasks).length;
    const time = new Date(c.date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `  • ${CHECKLIST_NAMES[id] || id} (${sec}) — ${done}/${total} tasks by ${by} at ${time}`;
  };

  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // ── Employee Management (clock in/out + hours) ──
  const employees = settings.employees || [];
  const timeEntries = settings.time_entries || [];
  const nowMs = Date.now();
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const weekStart = new Date(); const wd = (weekStart.getDay() + 6) % 7;
  weekStart.setDate(weekStart.getDate() - wd); weekStart.setHours(0, 0, 0, 0);
  const entryMins = (e, fromMs) => {
    const s = Math.max(new Date(e.clockIn).getTime(), fromMs);
    const en = e.clockOut ? new Date(e.clockOut).getTime() : nowMs;
    return Math.max(0, (en - s) / 60000);
  };
  const fmtH = (m) => { const h = Math.floor(m / 60), mm = Math.round(m % 60); return h ? `${h}h ${mm}m` : `${mm}m`; };
  const nameFor = (id, fallback) => employees.find(e => e.id === id)?.name || fallback || 'Employee';
  const onShift = timeEntries.filter(e => !e.clockOut).map(e => {
    const t = new Date(e.clockIn).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `${nameFor(e.employeeId, e.employeeName)} (since ${t}, ${fmtH(entryMins(e, 0))})`;
  });
  const hoursLine = (fromMs) => employees
    .filter(emp => emp.active !== false)
    .map(emp => {
      const mins = timeEntries
        .filter(e => e.employeeId === emp.id && (e.clockOut ? new Date(e.clockOut).getTime() : nowMs) >= fromMs)
        .reduce((s, e) => s + entryMins(e, fromMs), 0);
      return mins > 0 ? `  • ${emp.name}: ${fmtH(mins)}` : null;
    })
    .filter(Boolean);
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const todayHours = hoursLine(startOfToday.getTime());
  const weekHours = hoursLine(weekStart.getTime());
  const monthHours = hoursLine(monthStart.getTime());

  // Recent clock in/out log (last 40 shifts, newest first) — lets the agent
  // answer "who clocked in/out" and break down hours by any day/week/month.
  const recentShifts = [...timeEntries]
    .sort((a, b) => new Date(b.clockIn) - new Date(a.clockIn))
    .slice(0, 40)
    .map(e => {
      const inT = new Date(e.clockIn);
      const dayStr = inT.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      const inStr = inT.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const outStr = e.clockOut ? new Date(e.clockOut).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'still on shift';
      const dur = fmtH(entryMins(e, 0));
      return `  • ${nameFor(e.employeeId, e.employeeName)} — ${dayStr}: ${inStr} → ${outStr} (${dur})${e.editedBy ? ' [edited]' : ''}`;
    });

  const employeeBlock = `
EMPLOYEE MANAGEMENT (clock in/out & hours — Monday is the start of the week):
  Currently on shift (${onShift.length}): ${onShift.length ? onShift.join(', ') : 'nobody clocked in'}
  Hours TODAY:
${todayHours.length ? todayHours.join('\n') : '  • None recorded'}
  Hours THIS WEEK (from Monday):
${weekHours.length ? weekHours.join('\n') : '  • None recorded'}
  Hours THIS MONTH:
${monthHours.length ? monthHours.join('\n') : '  • None recorded'}
  RECENT CLOCK IN/OUT LOG (newest first — use this to break down any specific day/week/month or list who clocked in/out):
${recentShifts.length ? recentShifts.join('\n') : '  • No shifts recorded'}`;

  return `
TODAY: ${today}
ACTIVE STAFF: ${users.map(u => `${u.name} (${u.role})`).join(', ')}

TODAY'S COMPLETIONS (${todayC.length}):
${todayC.length ? todayC.map(fmt).join('\n') : '  • None yet'}

YESTERDAY'S COMPLETIONS (${yesterdayC.length}):
${yesterdayC.length ? yesterdayC.map(fmt).join('\n') : '  • None recorded'}

EXPECTED DAILY CHECKLISTS:
  • Opening clean (morning section) — INCLUDES the fridge temperature checks (all fridges/saladette probed & logged at opening)
  • Closing clean (closing section) — INCLUDES the fridge temperature checks again at close
  NOTE: Fridge temperature checks are part of the daily cleaning checklist (Opening + Closing sections), NOT a separate log. If Opening and Closing are completed, fridge temps ARE covered — do not report them as missing.

${employeeBlock}

RECENT AUDIT EVENTS:
${audit.slice(0, 10).map(a => `  • ${new Date(a.timestamp).toLocaleString('en-GB')} — ${a.action}: ${a.detail || ''}`).join('\n')}
`.trim();
}

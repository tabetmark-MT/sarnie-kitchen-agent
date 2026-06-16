import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
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

  // Weekly hours vs each employee's contracted/student target (+ remaining)
  const goalFor = (emp) => {
    if (emp.empType === 'student') return { kind: 'cap', max: Number(emp.weeklyHours) || 20, label: 'student' };
    if (emp.empType === 'contract' && (emp.weeklyMin || emp.weeklyMax)) return { kind: 'range', min: Number(emp.weeklyMin) || 0, max: Number(emp.weeklyMax) || 0, label: 'contract' };
    if (emp.empType === 'casual' && Number(emp.weeklyHours) > 0) return { kind: 'target', target: Number(emp.weeklyHours), label: 'casual' };
    return null;
  };
  const weeklyTargetLines = employees.filter(e => e.active !== false).map(emp => {
    const g = goalFor(emp);
    if (!g) return null;
    const mins = timeEntries
      .filter(e => e.employeeId === emp.id && (e.clockOut ? new Date(e.clockOut).getTime() : nowMs) >= weekStart.getTime())
      .reduce((s, e) => s + entryMins(e, weekStart.getTime()), 0);
    if (g.kind === 'cap') {
      const cap = g.max * 60;
      const status = mins > cap ? `${fmtH(mins - cap)} OVER the ${g.max}h limit` : `${fmtH(cap - mins)} left of ${g.max}h`;
      return `  • ${emp.name} (student): ${fmtH(mins)} of ${g.max}h — ${status}`;
    }
    if (g.kind === 'range') {
      const mn = g.min * 60, mx = g.max * 60;
      const status = mins < mn ? `${fmtH(mn - mins)} below the ${g.min}h minimum` : mins > mx ? `${fmtH(mins - mx)} over the ${g.max}h maximum` : `within ${g.min}–${g.max}h target`;
      return `  • ${emp.name} (contract ${g.min}–${g.max}h): ${fmtH(mins)} — ${status}`;
    }
    const t = g.target * 60;
    const status = mins >= t ? `target met` : `${fmtH(t - mins)} left of ${g.target}h`;
    return `  • ${emp.name} (target ${g.target}h): ${fmtH(mins)} — ${status}`;
  }).filter(Boolean);

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
  WEEKLY HOURS vs TARGET (student = weekly limit, contract = min–max, casual = target):
${weeklyTargetLines.length ? weeklyTargetLines.join('\n') : '  • No targets set'}
  RECENT CLOCK IN/OUT LOG (newest first — use this to break down any specific day/week/month or list who clocked in/out):
${recentShifts.length ? recentShifts.join('\n') : '  • No shifts recorded'}`;

  // ── KPI snapshot (computed across all sections, for clean reports) ──
  const cid = (c) => c.checklist_id || c.checklistId;
  const sid = (c) => c.section_id || c.sectionId;
  const dailyToday = todayC.filter(c => cid(c) === 'daily');
  const secSet = new Set(dailyToday.map(sid));
  const fullDay = secSet.has('full');
  const secMark = (s) => (fullDay || secSet.has(s)) ? 'done' : 'NOT done';
  const cookToday = todayC.filter(c => cid(c) === 'cookchill').length;
  const hotToday  = todayC.filter(c => cid(c) === 'hotholding').length;
  const deliveries = settings.delivery_log || [];
  const todayDeliv = deliveries.filter(d => new Date(d.date) >= startOfToday);
  const rejected = todayDeliv.filter(d => d.outcome === 'rejected').length;
  const partial  = todayDeliv.filter(d => d.outcome === 'partial').length;
  const tempFails = todayDeliv.reduce((n, d) => n + ((d.items || []).filter(i => {
    const t = parseFloat(i.temp);
    if (i.type === 'ambient' || isNaN(t)) return false;
    if (i.type === 'chilled') return t > 8;
    if (i.type === 'frozen')  return t > -18;
    if (i.type === 'hot')     return t < 63;
    return false;
  }).length), 0);
  const suppliers = settings.suppliers || [];
  const expiredCerts = suppliers.reduce((n, s) => n + ((s.certificates || []).filter(c => c.expiryDate && new Date(c.expiryDate) < new Date()).length), 0);
  const menu = settings.allergen_menu?.menus?.[0];
  const menuItems = menu?.items?.length || 0;

  const kpiBlock = `
KPI SNAPSHOT (today — computed, use these for clean reports):
  🧹 CLEANING — Opening: ${secMark('opening')}; Service/During: ${secMark('during')}; Closing: ${secMark('closing')}
  🌡️ FOOD SAFETY — Cook-chill entries today: ${cookToday}; Hot-holding entries today: ${hotToday}
  🚚 DELIVERIES — Today: ${todayDeliv.length} (rejected: ${rejected}, partial: ${partial}, temperature failures: ${tempFails})
  🏢 SUPPLIERS — Expired certificates: ${expiredCerts}
  🥜 ALLERGENS — Matrix items declared: ${menuItems}
  👷 EMPLOYEES — On shift now: ${onShift.length}; staff with hours today: ${todayHours.length}`;

  return `
TODAY: ${today}
${kpiBlock}

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

import { createClient } from '@supabase/supabase-js';

// The agent is a trusted server-side backend, so it reads with the service_role
// key (bypasses RLS). The DB is now locked down — the public anon key returns
// nothing — so anon would make every report and backup come back empty.
// Falls back to the anon key only if the service key isn't set.
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_ANON_KEY;

if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_SERVICE_KEY) {
  console.warn('[Supabase] SERVICE_ROLE key not set — reads will be empty under RLS. Set SUPABASE_SERVICE_ROLE_KEY in Render.');
}

export const supabase = createClient(
  process.env.SUPABASE_URL,
  SUPABASE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
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
  const [todayC, yesterdayC, recentC, users, audit, settings] = await Promise.all([
    getTodayCompletions(),
    getYesterdayCompletions(),
    getCompletionsRange(35),
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

  // Explicit "clocked in today" list (exact in→out times) so reports are precise.
  const clockedInToday = timeEntries
    .filter(e => new Date(e.clockIn).getTime() >= startOfToday.getTime())
    .sort((a, b) => new Date(a.clockIn) - new Date(b.clockIn))
    .map(e => {
      const inS = new Date(e.clockIn).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const outS = e.clockOut ? new Date(e.clockOut).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'on shift now';
      return `  • ${nameFor(e.employeeId, e.employeeName)}: ${inS} → ${outS} (${fmtH(entryMins(e, 0))})`;
    });

  const employeeBlock = `
EMPLOYEE MANAGEMENT (clock in/out & hours — Monday is the start of the week):
  CLOCKED IN TODAY (${clockedInToday.length}) — this is the COMPLETE list of everyone who clocked in today; nobody else did:
${clockedInToday.length ? clockedInToday.join('\n') : '  • Nobody has clocked in today'}
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

  // Probe calibration (DK-016) — computed here so the KPI snapshot can use it
  const probeAll = settings.probe_calibration || [];
  const cals = probeAll.filter(e => e.kind === 'cal').sort((a, b) => new Date(b.createdAt || b.date) - new Date(a.createdAt || a.date));
  const lastCal = cals[0];
  const calDays = lastCal ? Math.floor((Date.now() - new Date(lastCal.createdAt || lastCal.date)) / 86400000) : null;
  // Two-point weekly calibration (DK-016): BOTH ice (0°C) AND boiling (100°C)
  // must be logged this week to count as complete.
  const calsThisWeek = cals.filter(e => new Date(e.createdAt || e.date) >= weekStart);
  const hasIce  = calsThisWeek.some(e => e.method === 'ice');
  const hasBoil = calsThisWeek.some(e => e.method === 'boil');
  const bothPoints = hasIce && hasBoil;
  const pendingPoint = !hasIce ? 'ice-water (0°C)' : !hasBoil ? 'boiling-water (100°C)' : null;
  const calDue = !bothPoints; // due until both points are done this week

  const kpiBlock = `
KPI SNAPSHOT (today — computed, use these for clean reports):
  🧹 CLEANING — Opening: ${secMark('opening')}; Service/During: ${secMark('during')}; Closing: ${secMark('closing')}
  🌡️ FOOD SAFETY — Cook-chill entries today: ${cookToday}; Hot-holding entries today: ${hotToday}
  🌡️ PROBE CALIBRATION (two-point weekly) — ${bothPoints ? 'both ice & boiling done this week ✓' : pendingPoint ? `${pendingPoint} still needed this week (DUE)` : 'never done (DUE)'}
  🚚 DELIVERIES — Today: ${todayDeliv.length} (rejected: ${rejected}, partial: ${partial}, temperature failures: ${tempFails})
  🏢 SUPPLIERS — Expired certificates: ${expiredCerts}
  🥜 ALLERGENS — Matrix items declared: ${menuItems}
  👷 EMPLOYEES — On shift now: ${onShift.length}; staff with hours today: ${todayHours.length}`;

  // ── Compliance trends (from last ~35 days of completions) ──
  const dayKey = (d) => new Date(d).toLocaleDateString('en-CA');
  const dailyByDay = {};
  recentC.filter(c => cid(c) === 'daily').forEach(c => { (dailyByDay[dayKey(c.date)] ||= new Set()).add(sid(c)); });
  const dayComplete = (set) => set.has('full') || (set.has('opening') && set.has('during') && set.has('closing'));
  const lastNkeys = (n) => [...Array(n)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - i); return dayKey(d); });
  const daily7 = lastNkeys(7).filter(k => dailyByDay[k] && dayComplete(dailyByDay[k])).length;
  const daily30 = lastNkeys(30).filter(k => dailyByDay[k] && dayComplete(dailyByDay[k])).length;
  const weeklyDone = recentC.some(c => cid(c) === 'weekly' && new Date(c.date) >= weekStart);
  const monthlyDone = recentC.some(c => cid(c) === 'monthly' && new Date(c.date) >= monthStart);
  const allergenRev = recentC.filter(c => cid(c) === 'allergen_monthly').sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  const allergenTxt = allergenRev
    ? `last on ${new Date(allergenRev.date).toLocaleDateString('en-GB')} (${Math.floor((Date.now() - new Date(allergenRev.date)) / 86400000)} days ago)`
    : 'no review in the last 35 days';
  const set7 = new Set(lastNkeys(7));
  const cook7 = recentC.filter(c => cid(c) === 'cookchill' && set7.has(dayKey(c.date))).length;
  const hot7 = recentC.filter(c => cid(c) === 'hotholding' && set7.has(dayKey(c.date))).length;

  const complianceBlock = `
COMPLIANCE TRENDS (rolling, computed):
  Daily cleaning fully completed: ${daily7}/7 days (last week), ${daily30}/30 days (last month)
  Weekly deep clean (this week): ${weeklyDone ? 'done' : 'NOT yet'}
  Monthly audit (this month): ${monthlyDone ? 'done' : 'NOT yet'}
  Allergen 4-weekly review: ${allergenTxt}
  Food-safety logs last 7 days: cook-chill ${cook7}, hot-holding ${hot7}`;

  // ── Fridge temperature analytics (per appliance, from daily Opening/Closing) ──
  // Matches the in-app dashboard "Fridge temperatures — 30 days" card.
  const FRIDGE_TASKS = {
    'd-o-1': 'Undercounter fridge',        'd-c-11a': 'Undercounter fridge',
    'd-o-2': 'Three-door counter fridge',  'd-c-11b': 'Three-door counter fridge',
    'd-o-3': 'Single door upright fridge', 'd-c-11c': 'Single door upright fridge',
    'd-o-4': 'Three-door saladette',       'd-c-11d': 'Three-door saladette',
  };
  const fridgeStat = (t) => (t <= 5 ? 'PASS' : t <= 8 ? 'WARN' : 'FAIL');
  const set30 = new Set(lastNkeys(30));
  const fridgeReadings = {};
  recentC.filter(c => cid(c) === 'daily' && set30.has(dayKey(c.date))).forEach(c => {
    const temps = c.temperatures || {};
    Object.entries(temps).forEach(([tid, val]) => {
      const name = FRIDGE_TASKS[tid]; if (!name) return;
      const t = parseFloat(val); if (isNaN(t)) return;
      (fridgeReadings[name] ||= []).push({ date: c.date, t });
    });
  });
  const fridgeLines = Object.entries(fridgeReadings).map(([name, arr]) => {
    arr.sort((a, b) => new Date(a.date) - new Date(b.date));
    const n = arr.length;
    const pass = arr.filter(r => fridgeStat(r.t) === 'PASS').length;
    const fails = arr.filter(r => fridgeStat(r.t) === 'FAIL').length;
    const warns = arr.filter(r => fridgeStat(r.t) === 'WARN').length;
    const passRate = Math.round((pass / n) * 100);
    const avg = Math.round((arr.reduce((s, r) => s + r.t, 0) / n) * 10) / 10;
    const latest = arr[n - 1].t;
    let drift = '';
    if (n >= 6) {
      const k = Math.floor(n / 3), e = arr.slice(0, k), l = arr.slice(n - k);
      const d = Math.round((l.reduce((s, r) => s + r.t, 0) / l.length - e.reduce((s, r) => s + r.t, 0) / e.length) * 10) / 10;
      if (d >= 1) drift = ` — TRENDING WARMER (+${d}°C, check before it fails)`;
    }
    return `  • ${name}: ${passRate}% pass (${n} readings, avg ${avg}°C, latest ${latest}°C${fails ? `, ${fails} FAIL` : ''}${warns ? `, ${warns} warn` : ''})${drift}`;
  }).sort();
  const fridgeBlock = `
FRIDGE TEMPERATURE ANALYTICS (last 30 days, per appliance — fridge temps are recorded TWICE daily: morning in the Opening check and evening in the Closing check; FSA limit ≤5°C, ≤8°C tolerable, >8°C = fail). There is a dedicated Fridge Temperature report in the app (Reports → Fridges) and it's also included in the EHO Records Pack:
${fridgeLines.length ? fridgeLines.join('\n') : '  • No fridge temperatures logged in the last 30 days'}`;

  // ── KPI dashboard: this week vs last (mirrors the in-app dashboard) ──
  const STRUCT_NOTE = /^(hh-(type|food|time|stage|batch|outcome|duration|readings)|cc-(food|batch|cookStart|method|chillBatch|storageFd|storageBatch|storageType|storageUB|storageLabel))/;
  const noteCount = (c) => {
    const tn = c.taskNotes || c.task_notes || {};
    let k = Object.entries(tn).filter(([key, v]) => v && String(v).trim() && !STRUCT_NOTE.test(key)).length;
    if ((c.notes || '').trim()) k++;
    return k;
  };
  const compliancePct = (recs) => {
    if (!recs.length) return null;
    const vals = recs.map(c => { const t = Object.values(c.tasks || {}); return t.length ? t.filter(Boolean).length / t.length : 0; });
    return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100);
  };
  const wkStartMs = weekStart.getTime(), prevStartMs = wkStartMs - 7 * 86400000;
  const inWin = (from, to) => recentC.filter(c => { const t = new Date(c.date).getTime(); return t >= from && t < to; });
  const curWk = inWin(wkStartMs, nowMs + 1), prevWk = inWin(prevStartMs, wkStartMs);
  const activeDaysOf = (recs) => new Set(recs.map(c => dayKey(c.date))).size;
  const flaggedSum = (recs) => recs.reduce((s, c) => s + noteCount(c), 0);
  const delta = (cur, prev, suffix = '') => {
    if (cur == null) return 'n/a';
    if (prev == null) return `${cur}${suffix} (no prior week)`;
    const d = Math.round((cur - prev) * 10) / 10;
    return `${cur}${suffix} (${d > 0 ? '+' : ''}${d}${suffix} vs last week)`;
  };
  const trendVals = lastNkeys(14).map(k => compliancePct(recentC.filter(c => dayKey(c.date) === k))).filter(v => v != null);
  const trendAvg = trendVals.length ? Math.round(trendVals.reduce((a, b) => a + b, 0) / trendVals.length) : null;
  const kpiDashBlock = `
KPI DASHBOARD (this week vs last — the same figures the manager sees on the app dashboard; week starts Monday):
  Compliance %: ${delta(compliancePct(curWk), compliancePct(prevWk), '%')}
  Records logged: ${delta(curWk.length, prevWk.length)}
  Flagged items (genuine notes/corrective actions only): ${delta(flaggedSum(curWk), flaggedSum(prevWk))}
  Active days: ${delta(activeDaysOf(curWk), activeDaysOf(prevWk))} of 7
  14-day compliance trend average: ${trendAvg != null ? trendAvg + '%' : 'n/a'}`;

  // ── Probe thermometer calibration (DK-016) — narrative block ──
  const methodName = (m) => (m === 'boil' ? 'boiling water' : 'ice water');
  const lastWipe = probeAll.filter(e => e.kind === 'wipe').sort((a, b) => new Date(b.createdAt || b.date) - new Date(a.createdAt || a.date))[0];
  const probeBlock = `
PROBE CALIBRATION (DK-016 — TWO-POINT, weekly: ice water 0°C AND boiling water 100°C, ±1°C; both points are required each week):
  This week: ice point ${hasIce ? 'done ✓' : 'NOT done'}, boiling point ${hasBoil ? 'done ✓' : 'NOT done'}. STATUS: ${bothPoints ? 'up to date (both points this week).' : `DUE NOW — ${pendingPoint || 'no calibration'} still needed this week.`}
  ${lastCal
    ? `Most recent: ${new Date(lastCal.createdAt || lastCal.date).toLocaleDateString('en-GB')} (${calDays} day${calDays !== 1 ? 's' : ''} ago) — ${methodName(lastCal.method)} read ${lastCal.reading}°C, ${lastCal.pass ? 'PASS' : 'FAIL'}.`
    : 'No calibration on record.'}
  ${lastWipe ? `Probe wipes: ${lastWipe.inStock ? 'in stock' : 'OUT of stock' + (lastWipe.reordered ? ' (re-ordered)' : ' (NOT re-ordered)')} as of ${new Date(lastWipe.date).toLocaleDateString('en-GB')}.` : 'Probe wipe stock: not checked recently.'}`;

  // ── HACCP / compliance document library ──
  const docs = settings.documents || [];
  const byCat = {};
  docs.forEach(d => { (byCat[d.category || 'Other'] ||= []).push(d.title || d.name || 'Untitled'); });
  const docBlock = `
DOCUMENT LIBRARY (HACCP & compliance documents on file — ${docs.length} total):
${docs.length ? Object.entries(byCat).map(([cat, titles]) => `  • ${cat} (${titles.length}): ${titles.slice(0, 8).join('; ')}${titles.length > 8 ? '; …' : ''}`).join('\n') : '  • No documents on file'}`;

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

${complianceBlock}
${kpiDashBlock}
${fridgeBlock}
${probeBlock}

${employeeBlock}
${docBlock}

RECENT AUDIT EVENTS:
${audit.slice(0, 10).map(a => `  • ${new Date(a.timestamp).toLocaleString('en-GB')} — ${a.action}: ${a.detail || ''}`).join('\n')}
`.trim();
}

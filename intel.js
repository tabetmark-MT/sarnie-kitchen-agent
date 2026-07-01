// Read-only COMPLIANCE intelligence snapshot for external agents (e.g. the
// Cowork weekly report). Token-secured (INTEL_API_TOKEN) via Bearer header or
// ?token=. Returns the kitchen-compliance KPIs this app holds that a Deliveroo
// CSV doesn't: cleaning completion, fridge temperatures, food-safety logs,
// probe calibration, allergen review status, deliveries, supplier certs and
// staff hours — all Europe/London aware.
import { supabase, getSettings } from './supabase.js';

const r1 = (n) => Math.round(n * 10) / 10;
const londonKey = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }); // YYYY-MM-DD
const todayKey = () => londonKey(new Date());
const addDays = (key, n) => { const d = new Date(key + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return londonKey(d); };

// Fridge id → canonical #1–#4 name (matches the Cleaning app's numbering).
const FRIDGE_TASKS = {
  'd-o-3': 'Fridge #1 Single Door Upright', 'd-c-11c': 'Fridge #1 Single Door Upright',
  'd-o-2': 'Fridge #2 Three Door Counter',  'd-c-11b': 'Fridge #2 Three Door Counter',
  'd-o-4': 'Fridge #3 Three Door Salad',    'd-c-11d': 'Fridge #3 Three Door Salad',
  'd-o-1': 'Fridge #4 Under Counter',       'd-c-11a': 'Fridge #4 Under Counter',
};
const fridgeStat = (t) => (t <= 5 ? 'PASS' : t <= 8 ? 'WARN' : 'FAIL');

const cid = (c) => c.checklist_id || c.checklistId;
const sid = (c) => c.section_id || c.sectionId;

// Token can come from the INTEL_API_TOKEN env var (preferred, like the
// inventory app) or, as a fallback, an `intel_api_token` row in app_settings
// (lets the token be provisioned without a Render env change). DB value cached.
let _dbTokenCache = { value: null, at: 0 };
async function getIntelToken() {
  if (process.env.INTEL_API_TOKEN) return process.env.INTEL_API_TOKEN;
  if (Date.now() - _dbTokenCache.at < 5 * 60 * 1000) return _dbTokenCache.value;
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'intel_api_token').maybeSingle();
    _dbTokenCache = { value: data?.value || null, at: Date.now() };
  } catch { _dbTokenCache = { value: _dbTokenCache.value, at: Date.now() }; }
  return _dbTokenCache.value;
}

export async function authorisedIntel(req) {
  const token = await getIntelToken();
  if (!token) return false;
  const header = req.headers?.authorization;
  const bearer = header && header.startsWith('Bearer ') ? header.slice(7) : null;
  const qp = req.query?.token;
  return bearer === token || qp === token;
}

// Build the compliance snapshot for a London day-key range [from, to] inclusive.
// Defaults to the last 7 days ending today.
export async function buildComplianceSnapshot({ from, to } = {}) {
  const toK = to || todayKey();
  const fromK = from || addDays(toK, -6);
  const days = Math.max(1, Math.round((new Date(toK + 'T12:00:00Z') - new Date(fromK + 'T12:00:00Z')) / 86400000) + 1);

  // Pull completions across the window (+1 day buffer either side for tz safety).
  const { data: rows } = await supabase
    .from('completions').select('*')
    .gte('date', addDays(fromK, -1) + 'T00:00:00')
    .lte('date', addDays(toK, 1) + 'T23:59:59')
    .order('date', { ascending: true });
  const comps = (rows || []).filter(c => { const k = londonKey(c.date); return k >= fromK && k <= toK; });
  const settings = await getSettings();

  const inWindow = (k) => k >= fromK && k <= toK;
  const dayKeys = []; for (let k = fromK; k <= toK; k = addDays(k, 1)) dayKeys.push(k);
  const today = todayKey();

  // Operating schedule — CLOSED days (e.g. Sunday) and the in-progress current
  // day must never count as missed cleaning.
  const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const schedule = settings.schedule || {};
  const isClosed = (k) => {
    if ((schedule.closures || []).includes(k)) return true;
    const wd = new Date(k + 'T12:00:00Z').getUTCDay();
    const day = schedule[DAY_NAMES[(wd + 6) % 7]];
    return day ? day.open === false : false;
  };

  // ── Cleaning completion per day ──
  const dailyByDay = {};
  comps.filter(c => cid(c) === 'daily').forEach(c => { (dailyByDay[londonKey(c.date)] ||= new Set()).add(sid(c)); });
  const dayComplete = (set) => set && (set.has('full') || (set.has('opening') && set.has('during') && set.has('closing')));
  const cleaningByDay = dayKeys.map(k => {
    const s = dailyByDay[k] || new Set();
    const full = s.has('full');
    const closed = isClosed(k); const isToday = k === today;
    return { date: k, closed, today: isToday,
      opening: full || s.has('opening'), during: full || s.has('during'), closing: full || s.has('closing'),
      complete: closed ? true : dayComplete(s),
      status: closed ? 'closed' : isToday ? 'in-progress' : (dayComplete(s) ? 'complete' : 'incomplete') };
  });
  // Only OPEN days that are fully in the past count toward compliance.
  const expectedDays = cleaningByDay.filter(d => !d.closed && !d.today);
  const daysComplete = expectedDays.filter(d => dayComplete(dailyByDay[d.date])).length;
  const cleaningCompletePct = expectedDays.length ? Math.round((daysComplete / expectedDays.length) * 100) : 100;
  const missedClosings = expectedDays.filter(d => !d.closing).map(d => d.date);

  // ── Fridge temperatures (daily Opening/Closing) ──
  const fridge = {};
  comps.filter(c => cid(c) === 'daily').forEach(c => {
    Object.entries(c.temperatures || {}).forEach(([tid, val]) => {
      const name = FRIDGE_TASKS[tid]; if (!name) return;
      const t = parseFloat(val); if (isNaN(t)) return;
      (fridge[name] ||= []).push({ date: londonKey(c.date), t, period: tid.startsWith('d-o') ? 'am' : 'pm' });
    });
  });
  const fridges = Object.entries(fridge).map(([name, arr]) => {
    arr.sort((a, b) => (a.date < b.date ? -1 : 1));
    const n = arr.length;
    const fails = arr.filter(r => fridgeStat(r.t) === 'FAIL').length;
    const warns = arr.filter(r => fridgeStat(r.t) === 'WARN').length;
    const pass = n - fails - warns;
    const am = arr.filter(r => r.period === 'am'), pm = arr.filter(r => r.period === 'pm');
    const avgOf = (a) => a.length ? r1(a.reduce((s, r) => s + r.t, 0) / a.length) : null;
    let drift = null;
    if (n >= 6) { const k = Math.floor(n / 3), e = arr.slice(0, k), l = arr.slice(n - k); drift = r1(l.reduce((s, r) => s + r.t, 0) / l.length - e.reduce((s, r) => s + r.t, 0) / e.length); }
    return { name, readings: n, passRatePct: n ? Math.round((pass / n) * 100) : null, avg: avgOf(arr), amAvg: avgOf(am), pmAvg: avgOf(pm), fails, warns, latest: n ? arr[n - 1].t : null, driftC: drift };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const fridgeTotals = fridges.reduce((o, f) => { o.readings += f.readings; o.fails += f.fails; o.warns += f.warns; return o; }, { readings: 0, fails: 0, warns: 0 });
  const fridgePassRatePct = fridgeTotals.readings ? Math.round(((fridgeTotals.readings - fridgeTotals.fails - fridgeTotals.warns) / fridgeTotals.readings) * 100) : null;

  // ── Food safety logs (window) ──
  const cookChillLogs = comps.filter(c => cid(c) === 'cookchill').length;
  const hotHoldingLogs = comps.filter(c => cid(c) === 'hotholding').length;

  // ── Probe calibration (two-point weekly DK-016) ──
  const nowMs = Date.now();
  const weekStartMs = (() => { const d = new Date(); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const cals = (settings.probe_calibration || []).filter(e => e.kind === 'cal')
    .sort((a, b) => new Date(b.createdAt || b.date) - new Date(a.createdAt || a.date));
  const calsThisWeek = cals.filter(e => new Date(e.createdAt || e.date).getTime() >= weekStartMs);
  const hasIce = calsThisWeek.some(e => e.method === 'ice'), hasBoil = calsThisWeek.some(e => e.method === 'boil');
  const lastCal = cals[0];
  const probe = {
    twoPointThisWeek: hasIce && hasBoil,
    pendingPoint: !hasIce ? 'ice-water (0°C)' : !hasBoil ? 'boiling-water (100°C)' : null,
    lastDoneDaysAgo: lastCal ? Math.floor((nowMs - new Date(lastCal.createdAt || lastCal.date)) / 86400000) : null,
    due: !(hasIce && hasBoil),
  };

  // ── Allergen review ──
  const allergenRev = comps.filter(c => cid(c) === 'allergen_monthly').sort((a, b) => new Date(b.date) - new Date(a.date))[0]
    // also look beyond the window for the most recent review
    || ((await supabase.from('completions').select('*').eq('checklist_id', 'allergen_monthly').order('date', { ascending: false }).limit(1)).data || [])[0];
  const revAt = allergenRev ? new Date(allergenRev.date) : null;
  const changeLog = settings.allergen_menu?.changeLog || [];
  const lastChange = changeLog.map(e => new Date(e.date)).sort((a, b) => b - a)[0] || null;
  const changedSinceReview = !!(lastChange && (!revAt || lastChange > revAt));
  const allergen = {
    lastReviewedDaysAgo: revAt ? Math.floor((nowMs - revAt) / 86400000) : null,
    changedSinceReview,
    due: changedSinceReview || !revAt || (nowMs - revAt) > 28 * 86400000,
    matrixItems: settings.allergen_menu?.menus?.[0]?.items?.length || 0,
  };

  // ── Deliveries (window) ──
  const deliv = (settings.delivery_log || []).filter(d => inWindow(londonKey(d.date)));
  const tempFailures = deliv.reduce((n, d) => n + ((d.items || []).filter(i => {
    const t = parseFloat(i.temp); if (i.type === 'ambient' || isNaN(t)) return false;
    if (i.type === 'chilled') return t > 8; if (i.type === 'frozen') return t > -18; if (i.type === 'hot') return t < 63; return false;
  }).length), 0);
  const deliveries = {
    count: deliv.length,
    rejected: deliv.filter(d => d.outcome === 'rejected').length,
    partial: deliv.filter(d => d.outcome === 'partial').length,
    tempFailures,
  };

  // ── Supplier certs ──
  const suppliers = settings.suppliers || [];
  const allCerts = suppliers.flatMap(s => (s.certificates || []).map(c => ({ supplier: s.name, ...c })));
  const expired = allCerts.filter(c => c.expiryDate && new Date(c.expiryDate) < new Date());
  const expiringSoon = allCerts.filter(c => { if (!c.expiryDate) return false; const d = new Date(c.expiryDate); return d >= new Date() && d <= new Date(nowMs + 60 * 86400000); });

  // ── Employees (this week) ──
  const employees = settings.employees || [];
  const timeEntries = settings.time_entries || [];
  const entryMins = (e, fromMs) => { const s = Math.max(new Date(e.clockIn).getTime(), fromMs); const en = e.clockOut ? new Date(e.clockOut).getTime() : nowMs; return Math.max(0, (en - s) / 60000); };
  let weekMins = 0, overStudent = 0;
  employees.filter(e => e.active !== false).forEach(emp => {
    const mins = timeEntries.filter(e => e.employeeId === emp.id).reduce((s, e) => s + entryMins(e, weekStartMs), 0);
    weekMins += mins;
    if (emp.empType === 'student' && mins > (Number(emp.weeklyHours) || 20) * 60) overStudent++;
  });

  // ── Operational flags ──
  const flags = [];
  if (fridgeTotals.fails > 0) flags.push({ severity: 'high', area: 'fridge', message: `${fridgeTotals.fails} fridge temperature failure(s) (>8°C) in the window` });
  fridges.filter(f => f.driftC != null && f.driftC >= 1).forEach(f => flags.push({ severity: 'medium', area: 'fridge', message: `${f.name} trending warmer (+${f.driftC}°C) — check before it fails` }));
  if (probe.due) flags.push({ severity: 'high', area: 'probe', message: probe.pendingPoint ? `Probe calibration incomplete — ${probe.pendingPoint} still needed this week` : 'Probe calibration never logged' });
  if (allergen.due) flags.push({ severity: 'medium', area: 'allergen', message: allergen.changedSinceReview ? 'Allergen matrix changed since last sign-off — review due' : 'Allergen review overdue (>4 weeks)' });
  if (expired.length) flags.push({ severity: 'high', area: 'suppliers', message: `${expired.length} supplier certificate(s) expired` });
  if (expiringSoon.length) flags.push({ severity: 'low', area: 'suppliers', message: `${expiringSoon.length} supplier certificate(s) expiring within 60 days` });
  if (missedClosings.length) flags.push({ severity: 'medium', area: 'cleaning', message: `${missedClosings.length} day(s) with no Closing logged: ${missedClosings.join(', ')}` });
  if (overStudent) flags.push({ severity: 'medium', area: 'employees', message: `${overStudent} student(s) over their weekly hours limit` });

  return {
    app: 'Sarnie Social — Kitchen Compliance',
    site: 'SS-ISL',
    generatedAt: new Date().toISOString(),
    timezone: 'Europe/London',
    range: { from: fromK, to: toK, days },
    kpis: {
      cleaningCompletePct,
      daysFullyCompliant: daysComplete,
      totalDays: expectedDays.length,
      weeklyDeepCleanDone: comps.some(c => cid(c) === 'weekly'),
      monthlyAuditDone: comps.some(c => cid(c) === 'monthly'),
      fridgeReadings: fridgeTotals.readings,
      fridgePassRatePct,
      fridgeFails: fridgeTotals.fails,
      fridgeWarns: fridgeTotals.warns,
      cookChillLogs,
      hotHoldingLogs,
      probeTwoPointThisWeek: probe.twoPointThisWeek,
      allergenReviewDue: allergen.due,
      deliveries: deliveries.count,
      deliveryTempFailures: tempFailures,
      expiredCerts: expired.length,
      expiringCerts60d: expiringSoon.length,
      staffHoursThisWeek: r1(weekMins / 60),
      recordsLogged: comps.length,
    },
    cleaningByDay,
    fridges,
    foodSafety: { cookChillLogs, hotHoldingLogs },
    probe,
    allergen,
    deliveries,
    suppliers: { expired: expired.map(c => ({ supplier: c.supplier, name: c.name, expiryDate: c.expiryDate })), expiringSoon: expiringSoon.map(c => ({ supplier: c.supplier, name: c.name, expiryDate: c.expiryDate })) },
    employees: { activeStaff: employees.filter(e => e.active !== false).length, hoursThisWeek: r1(weekMins / 60), overStudentLimit: overStudent },
    flags,
  };
}

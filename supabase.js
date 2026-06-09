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

  return `
TODAY: ${today}
ACTIVE STAFF: ${users.map(u => `${u.name} (${u.role})`).join(', ')}

TODAY'S COMPLETIONS (${todayC.length}):
${todayC.length ? todayC.map(fmt).join('\n') : '  • None yet'}

YESTERDAY'S COMPLETIONS (${yesterdayC.length}):
${yesterdayC.length ? yesterdayC.map(fmt).join('\n') : '  • None recorded'}

EXPECTED DAILY CHECKLISTS:
  • Opening clean (morning section)
  • Closing clean (closing section)
  • Fridge temperature checks

RECENT AUDIT EVENTS:
${audit.slice(0, 10).map(a => `  • ${new Date(a.timestamp).toLocaleString('en-GB')} — ${a.action}: ${a.detail || ''}`).join('\n')}
`.trim();
}

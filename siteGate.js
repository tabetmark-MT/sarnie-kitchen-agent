// Per-kitchen feed contract — the same rules as the kitchen app's api/_site.js
// (Whitechapel phase 2, 2 Nov 2026). The Render /api/intel/snapshot is CoWork's
// fallback when the kitchen app is down, so it must behave identically
// (OS/CoWork question, 9 Nov 2026). Keep the two files in step.
//  - ?site=CODE picks the kitchen. Unknown → 400. No site=all.
//  - Token scope: app_settings.feed_site_scopes[feed] ([SS-ISL] when unset) → else 403.
//  - Missing ?site= means SS-ISL until CUTOVER, then 400.
//  - Echo site / siteName / tz. Known but not trading → 200, empty shape, trading:false.
//  - ?token= refused from CUTOVER (header only).
import { supabase } from './supabase.js';

export const CUTOVER = '2026-12-01';
const ldnToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
export const pastCutover = () => ldnToday() >= CUTOVER;
export const urlTokenAllowed = () => !pastCutover();

export async function siteGate(req, res, { feed, empty = {} }) {
  let code = typeof req.query?.site === 'string' ? req.query.site : '';
  if (code === '') {
    if (pastCutover()) { res.status(400).json({ error: 'Missing ?site= — name the kitchen, e.g. ?site=SS-ISL.' }); return null; }
    code = 'SS-ISL';
  }
  if (code.toLowerCase() === 'all') { res.status(400).json({ error: 'site=all is not supported — ask for one kitchen at a time.' }); return null; }

  const [{ data: row, error }, { data: scopes }] = await Promise.all([
    supabase.from('sites').select('code,name,tz,trading').eq('code', code).maybeSingle(),
    supabase.from('app_settings').select('value').eq('key', 'feed_site_scopes').maybeSingle(),
  ]);
  if (error) { res.status(500).json({ error: 'Could not read the kitchen list.' }); return null; }
  if (!row) { res.status(400).json({ error: `Unknown site '${code}'.` }); return null; }

  const allowed = Array.isArray(scopes?.value?.[feed]) ? scopes.value[feed] : ['SS-ISL'];
  if (!allowed.includes(row.code)) { res.status(403).json({ error: `This token may not read site '${row.code}'.` }); return null; }

  const echo = { site: row.code, siteName: row.name, tz: row.tz };
  if (!row.trading) {
    res.status(200).json({ ...echo, trading: false, generatedAt: new Date().toISOString(), ...empty });
    return null;
  }
  return { ...echo, echo };
}

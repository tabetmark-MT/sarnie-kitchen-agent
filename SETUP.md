# Sarnie Kitchen Agent — Setup & Runbook

The Telegram agent you talk to. It runs as a **Node/Express web service on Render**,
reads the live **Supabase** (Cleaning) database, answers via the **Claude API**, and
backs the database up to **Dropbox** nightly.

```
You (Telegram) ──webhook──► Render web service ──► Claude API
                                  │  reads ──► Supabase (Cleaning DB)
                                  └  nightly backup ──► Dropbox
```

---

## ⚠️ Critical: the agent reads with the SERVICE_ROLE key, not the anon key

The Cleaning database has **Row Level Security (RLS) enabled** — the public `anon`
key is denied everything (this is the security lockdown that protects the PINs and
all data from the browser bundle).

The agent is a **trusted server-side backend**, so it must read with the
**`service_role`** key, which bypasses RLS. If it falls back to the `anon` key,
**every report and every backup comes back empty** (0 records, 0 KB) — the agent
isn't broken, it just can't see anything.

➡️ **`SUPABASE_SERVICE_ROLE_KEY` must be set in Render.** If the agent is ever
redeployed fresh or moved, this is the one env var that, if missing, silently
blanks all data. See `supabase.js` — it prefers `SUPABASE_SERVICE_ROLE_KEY` and
logs a warning if it isn't set.

The `service_role` key is powerful (full DB access). It lives **only** in Render's
server environment — never in the app/browser, never committed to git.

---

## Environment variables (set in Render → Environment)

| Variable | Required | What it is |
|---|---|---|
| `SUPABASE_URL` | ✅ | `https://lcvrlejjyputcktzagfr.supabase.co` (Cleaning project) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | **service_role** secret key (Supabase → Settings → API). Without it, all reads/backups are empty under RLS. |
| `ANTHROPIC_API_KEY` | ✅ | Claude API key — the agent's brain |
| `TELEGRAM_BOT_TOKEN` | ✅ | From @BotFather — lets the server send/receive as the bot |
| `TELEGRAM_CHAT_ID` | ✅ | Owner chat id (`2046354154`). The agent only replies to this chat. |
| `APP_URL` | ✅ | The Render public URL (e.g. `https://sarnie-kitchen-agent.onrender.com`). Used to register the Telegram webhook on boot. |
| `WEBHOOK_SECRET` | ✅ | Secret path segment protecting `/webhook/...` and `/tasks/backup/...` |
| `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` / `DROPBOX_REFRESH_TOKEN` | for backups | Dropbox credentials — see `SETUP-DROPBOX.md` |
| `DROPBOX_BACKUP_PATH` | optional | Backup folder (default `/Sarnie Social Backups`) |
| `SUPABASE_ANON_KEY` | optional | Only used as a last-resort fallback; returns nothing under RLS |
| `MORNING_HOUR` / `MORNING_MINUTE` | optional | Morning debrief time (default 09:00 Europe/London) |
| `BACKUP_HOUR` / `BACKUP_MINUTE` | optional | Nightly backup time (default 22:00 Europe/London) |

---

## Deploy

- Repo: `tabetmark-MT/sarnie-kitchen-agent` → Render Web Service, Node 18+, `npm start`.
- **Auto-deploy** is on (pushes to `main` redeploy). A deploy hook also exists as a manual trigger.
- On boot the server self-registers its Telegram webhook (`${APP_URL}/webhook/${WEBHOOK_SECRET}`).

## Scheduled jobs (node-cron, Europe/London)

- **09:00** — morning debrief sent to the owner chat.
- **22:00** — nightly Dropbox backup (idempotent per day; safe even if GitHub Actions also runs one).

## Health & quick checks

- `GET /` → `{ status: "ok", build: "live", features: [...] }`. **Free Render tier sleeps after ~15 min idle**, so the first hit can take ~12s (cold start) — not a fault.
- Force a backup any time: text **`/backup`** in Telegram. A healthy result shows real counts (≈150 records, 6 users, …) and a non-zero KB.
- Verify a backup ran: the `last_dropbox_backup` row in `app_settings` should equal today's date.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Backups show **0 records / 0 KB**; reports say "no data" | `SUPABASE_SERVICE_ROLE_KEY` not set → agent fell back to the RLS-blocked anon key | Set `SUPABASE_SERVICE_ROLE_KEY` in Render, save (auto-redeploys), text `/backup` |
| Bot doesn't reply at all | Webhook not registered, or `APP_URL`/`WEBHOOK_SECRET` wrong, or service asleep | Check Render logs for `[Webhook] ✅ Registered`; first message wakes a sleeping free instance |
| "I only respond to the kitchen manager" | Message came from a chat id ≠ `TELEGRAM_CHAT_ID` | Expected — only the owner chat is allowed |
| First reply very slow (~12s) | Free-tier cold start | Normal. Upgrade to paid (always-on) or keep-warm ping if it matters |

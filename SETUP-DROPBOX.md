# Nightly Dropbox Backup — Setup (one-time, ~5 minutes)

The agent backs up the **entire Supabase database** to your Dropbox every night
at **23:00 UK time** (and on demand via the `/backup` command in Telegram).

Dropbox needs three credentials. You create them once; nothing expires.

---

## 1. Create a Dropbox app

1. Go to **https://www.dropbox.com/developers/apps** and click **Create app**.
2. Choose:
   - **Scoped access**
   - **App folder** access (safest — the app can only touch its own folder)
   - Name it e.g. `Sarnie Social Backups`
3. Open the app → **Permissions** tab → tick **`files.content.write`** (and `files.content.read`) → **Submit**.
4. On the **Settings** tab, copy the **App key** and **App secret**.
   - These are your `DROPBOX_APP_KEY` and `DROPBOX_APP_SECRET`.

## 2. Get a refresh token (long-lived)

In a browser, paste this URL — replace `APP_KEY` with your real App key:

```
https://www.dropbox.com/oauth2/authorize?client_id=APP_KEY&token_access_type=offline&response_type=code
```

- Click **Allow** → Dropbox shows a short **authorization code**. Copy it.
- Now exchange that code for a refresh token. In a terminal, replace
  `APP_KEY`, `APP_SECRET`, and `AUTH_CODE`, then run:

```bash
curl https://api.dropbox.com/oauth2/token \
  -d code=AUTH_CODE \
  -d grant_type=authorization_code \
  -u APP_KEY:APP_SECRET
```

- The JSON response contains `"refresh_token": "..."` — that's your
  `DROPBOX_REFRESH_TOKEN`. (The auth code is single-use; if it expires, just
  repeat the authorize step for a new one.)

## 3. Add the credentials to Render

In the Render dashboard → **sarnie-kitchen-agent** → **Environment**, add:

| Key | Value |
|-----|-------|
| `DROPBOX_APP_KEY` | your App key |
| `DROPBOX_APP_SECRET` | your App secret |
| `DROPBOX_REFRESH_TOKEN` | the refresh token from step 2 |
| `DROPBOX_BACKUP_PATH` | `/Sarnie Social Backups` (optional) |

Click **Save, rebuild, and deploy**.

> With **App folder** access, files land in
> `Dropbox/Apps/Sarnie Social Backups/…` and `DROPBOX_BACKUP_PATH` is relative
> to that folder.

## 4. Test it

Send **`/backup`** to the Telegram bot. Within a few seconds you should get a
confirmation with the file path and record counts, and see
`sarnie-backup-YYYY-MM-DD.json` appear in your Dropbox. After that it runs
automatically every night at 23:00.

## 5. (Recommended) Guarantee the 23:00 run on Render free tier

Render's free instance sleeps after ~15 min idle, and the built-in 23:00 timer
won't fire while it's asleep. To make the nightly backup bullet-proof, have a
free scheduler call the wake-and-backup endpoint:

1. Sign up at **https://cron-job.org** (free).
2. Create a cron job:
   - **URL:** `https://sarnie-kitchen-agent.onrender.com/tasks/backup/sarnie-agent-secret`
     (replace `sarnie-agent-secret` if you set a custom `WEBHOOK_SECRET`)
   - **Schedule:** every day at **23:00**, timezone **Europe/London**
3. Save. That request wakes the agent and runs the backup; you'll get the
   Telegram confirmation each night.

(The in-app 23:00 cron still runs too — this is just a reliable backstop.)

## What's in each backup

A single JSON file per day containing every table: `app_users`, `app_settings`
(includes documents + full staff team), `checklists`, `completions` (your full
history) and `audit_log`. One file = a complete, restorable snapshot.

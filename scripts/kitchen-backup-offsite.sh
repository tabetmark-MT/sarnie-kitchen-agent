#!/bin/bash
# Second, encrypted, off-Dropbox copy of the KITCHEN APP backups, in OneDrive (Mark, 18 Nov 2026).
#
# WHY. The agent's nightly 22:00 job writes the full kitchen database to Dropbox
# (Apps/Sarnie Social Backups) as plain JSON, and nowhere else. One Dropbox problem
# (account, deletion that syncs) would take every copy. OneDrive is a separate provider.
#
# HOW (same pattern as the OS's scripts/backup-offsite-onedrive.sh, own key):
#   - Each sarnie-backup-YYYY-MM-DD.json not yet in OneDrive -> gzip -> AES-256
#     (openssl, PBKDF2, 200,000 rounds) -> <name>.json.gz.enc. Catches up missed nights.
#   - storage/ (supplier certificates) -> one encrypted tar per day the script runs.
#   - Key ONLY in the macOS login Keychain: service "sarnie-kitchen-backup", account
#     "encryption". Never on a command line, in a file or a log (passed on fd 3).
#   - Every copy is decrypted again and checked before it is kept.
#   - Never deletes or prunes anything. Skips a backup under 1 KB (24-25 Jun empty-backup guard).
#
# Exit 0 = ok · 4 = no key · 5 = a copy failed or did not verify.
#   bash kitchen-backup-offsite.sh            copy everything not yet in OneDrive
#   bash kitchen-backup-offsite.sh --restore  decrypt the newest copy into a temp folder, to prove it
#
# launchd can't execute under CloudStorage: the copy that runs lives in
# ~/Library/Application Support/sarnie/ — re-copy after any edit.
set -uo pipefail
SRC="$HOME/Library/CloudStorage/Dropbox/Apps/Sarnie Social Backups"
DST="$HOME/Library/CloudStorage/OneDrive-Personal/4. Sarnie Social/SARNIE OS Backups/Kitchen app"
CIPHER=(-aes-256-cbc -pbkdf2 -iter 200000 -md sha256)
stamp() { date '+%Y-%m-%d %H:%M'; }
# A failure must not sit silently in a log (18 Nov 2026): Mac notification too.
alert() { echo "$(stamp) · kitchen offsite: $1"; /usr/bin/osascript -e "display notification \"$1\" with title \"Sarnie kitchen backup\" sound name \"Basso\"" >/dev/null 2>&1 || true; }

PASS=$(security find-generic-password -s sarnie-kitchen-backup -a encryption -w 2>/dev/null) || {
  alert "no encryption key in the Keychain (sarnie-kitchen-backup / encryption)"; exit 4; }

dec() { openssl enc -d "${CIPHER[@]}" -pass fd:3 -in "$1" 3<<<"$PASS"; }

if [ "${1:-}" = "--restore" ]; then
  newest=$(ls -1 "$DST" 2>/dev/null | grep -E '^sarnie-backup-.*\.json\.gz\.enc$' | sort | tail -1)
  [ -n "$newest" ] || { echo "no encrypted copy in $DST"; exit 5; }
  out=$(mktemp -d)
  dec "$DST/$newest" | gunzip > "$out/${newest%.gz.enc}" || { echo "restore FAILED"; exit 5; }
  echo "restored $newest -> $out/${newest%.gz.enc} ($(wc -c < "$out/${newest%.gz.enc}" | tr -d ' ') bytes)"
  st=$(ls -1 "$DST" 2>/dev/null | grep -E '^storage-.*\.tar\.gz\.enc$' | sort | tail -1)
  if [ -n "$st" ]; then
    mkdir -p "$out/storage" && dec "$DST/$st" | tar -xzf - -C "$out/storage" || { echo "storage restore FAILED"; exit 5; }
    echo "restored $st -> $out/storage ($(find "$out/storage" -type f | wc -l | tr -d ' ') files)"
  fi
  echo "$out"; exit 0
fi

[ -d "$SRC" ] || { echo "$(stamp) · kitchen offsite: no backup folder at $SRC"; exit 5; }
mkdir -p "$DST" || { echo "$(stamp) · kitchen offsite: cannot create $DST"; exit 5; }

copied=0; failed=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  out="$DST/$f.gz.enc"; [ -f "$out" ] && continue
  size=$(wc -c < "$SRC/$f" 2>/dev/null | tr -d ' ')
  [ "${size:-0}" -ge 1024 ] || { echo "$(stamp) · kitchen offsite: $f is ${size:-0} bytes — skipped (empty-backup guard)"; failed=$((failed+1)); continue; }
  tmp="$DST/.$f.partial"
  if ! gzip -c "$SRC/$f" | openssl enc "${CIPHER[@]}" -salt -pass fd:3 -out "$tmp" 3<<<"$PASS"; then
    rm -f "$tmp"; echo "$(stamp) · kitchen offsite: encrypting $f FAILED"; failed=$((failed+1)); continue
  fi
  # Two checks: the whole file decrypts and its gzip is intact (strict), and
  # it starts like a kitchen backup (head closes the pipe early, so that one
  # runs without pipefail).
  if ! dec "$tmp" | gzip -t 2>/dev/null \
     || ! ( set +o pipefail; dec "$tmp" 2>/dev/null | gunzip 2>/dev/null | head -c 400 ) | grep -q '"source": "sarnie-kitchen-agent"'; then
    rm -f "$tmp"; echo "$(stamp) · kitchen offsite: $f did NOT verify"; failed=$((failed+1)); continue
  fi
  mv "$tmp" "$out"; copied=$((copied+1))
done <<< "$(ls -1 "$SRC" | grep -E '^sarnie-backup-[0-9]{4}-[0-9]{2}-[0-9]{2}\.json$' | sort)"

# Supplier certificates (storage/): one snapshot per day.
today=$(date '+%Y-%m-%d'); sout="$DST/storage-$today.tar.gz.enc"
if [ -d "$SRC/storage" ] && [ ! -f "$sout" ]; then
  tmp="$DST/.storage-$today.partial"
  if tar -C "$SRC" -czf - storage | openssl enc "${CIPHER[@]}" -salt -pass fd:3 -out "$tmp" 3<<<"$PASS" \
     && dec "$tmp" | tar -tzf - | grep -q 'storage/_manifest.json'; then
    mv "$tmp" "$sout"; copied=$((copied+1))
  else
    rm -f "$tmp"; echo "$(stamp) · kitchen offsite: storage snapshot FAILED"; failed=$((failed+1))
  fi
fi

count=$(ls -1 "$DST" | grep -cE '\.enc$'); size=$(du -sh "$DST" | cut -f1)
echo "$(stamp) · kitchen offsite: $copied new copied, encrypted and verified · $count copies held ($size)"
# Is the 22:00 Render backup still arriving? Newest file older than 36 h = it stopped.
newest=$(ls -1 "$SRC" | grep -E '^sarnie-backup-[0-9]{4}-[0-9]{2}-[0-9]{2}\.json$' | sort | tail -1)
nd=${newest#sarnie-backup-}; nd=${nd%.json}
age_h=$(( ( $(date +%s) - $(date -j -f '%Y-%m-%d %H:%M' "$nd 22:00" +%s 2>/dev/null || echo 0) ) / 3600 ))
[ "$age_h" -le 36 ] || alert "newest Dropbox backup is ${nd:-none} (${age_h}h old) — the 22:00 nightly backup has stopped"
[ "$failed" -eq 0 ] || { alert "$failed backup copy/copies FAILED or skipped — see kitchen-backup-offsite.log"; exit 5; }
exit 0

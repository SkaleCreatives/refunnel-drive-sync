#!/usr/bin/env bash
# Refunnel export -> your Google Drive + a Google Sheet. Run: ./start.sh   (or: ./start.sh <drive folder link> <export.csv> [sheet link])
# First run: a browser window opens, sign in with Google and click Allow. Run it again any time - it continues where it stopped.
set -euo pipefail
cd "$(dirname "$0")"
export RCLONE_CONFIG="$PWD/rclone.conf"

command -v node > /dev/null || { echo "Please install Node.js first (https://nodejs.org, the LTS button), then run ./start.sh again."; exit 1; }

# rclone moves the files. If it is not installed, a copy goes into ./bin (no admin rights needed).
RCLONE=$(command -v rclone || true)
if [ -z "$RCLONE" ]; then
  RCLONE="$PWD/bin/rclone"
  if [ ! -x "$RCLONE" ]; then
    case "$(uname -s)" in Darwin) os=osx ;; Linux) os=linux ;; *) echo "Mac or Linux only (on Windows: WSL)."; exit 1 ;; esac
    case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; *) arch=amd64 ;; esac
    # Pinned version, checked against its SHA-256 (from rclone.org and GitHub, identical). Update both together.
    ver=v1.76.0
    case "$os-$arch" in
      osx-arm64)   sum=e72dc90b70f4947a7b72b61bde4a4fbba5777b2874fb448951ffdde67ebd0ab7 ;;
      osx-amd64)   sum=4f5835733d52b818340f97b1fc0348a70461534d123363a183ca2b660219595a ;;
      linux-arm64) sum=ee169016675e23a69d77240565133ff7dbc9b33d16fa8f7053d4af39f1eaeb78 ;;
      linux-amd64) sum=b00f00b3266c3764413afe599d3ec316f6f43b3e0ea8a0bc1d186d2133e46df7 ;;
    esac
    echo "Getting rclone $ver ..."
    mkdir -p bin && curl -fsSL "https://downloads.rclone.org/$ver/rclone-$ver-$os-$arch.zip" -o bin/rclone.zip
    if command -v shasum > /dev/null; then got=$(shasum -a 256 bin/rclone.zip | cut -d' ' -f1); else got=$(sha256sum bin/rclone.zip | cut -d' ' -f1); fi
    [ "$got" = "$sum" ] || { rm -f bin/rclone.zip; echo "rclone download does not match its checksum - stopped, nothing was run."; exit 1; }
    unzip -q -j -o bin/rclone.zip "*/rclone" -d bin && rm bin/rclone.zip && chmod +x "$RCLONE"
  fi
fi
export RCLONE

# Google sign-in, once
if ! "$RCLONE" listremotes | grep -q '^gdrive:$'; then
  echo "A browser window opens: sign in with the Google account of your Drive folder and click Allow."
  "$RCLONE" config create gdrive drive scope=drive > /dev/null
fi

FOLDER=${1:-}; CSV=${2:-}; SHEET=${3:-}
if [ -z "$FOLDER" ]; then read -rp "Link of your Google Drive folder: " FOLDER; fi
if [ -z "$CSV" ]; then
  read -rp "Refunnel export (drag the CSV file in here, then Enter): " CSV
  read -rp "Existing Google Sheet to extend (link, or just Enter for a new one): " SHEET
fi
CSV=$(printf '%s' "$CSV" | sed -e "s/^[[:space:]'\"]*//" -e "s/[[:space:]'\"]*$//" -e 's/\\ / /g')
[ -f "$CSV" ] || { echo "File not found: $CSV"; exit 1; }
export FOLDER SHEET

eval "$(node sync.mjs resolve)"
export SHEET_ID RCLONE_DRIVE_ROOT_FOLDER_ID="$FOLDER_ID" RCLONE_DRIVE_TEAM_DRIVE="$DRIVE_ID"
node sync.mjs import "$CSV"
node sync.mjs pending > pending.tsv
cut -f1 pending.tsv | sort -u | while read -r month; do "$RCLONE" mkdir "gdrive:$month"; done
./upload.sh < pending.tsv
"$RCLONE" lsjson -R --files-only gdrive: > files.json
node sync.mjs links files.json
rm -f pending.tsv files.json
echo
echo "Done. Sheet: https://docs.google.com/spreadsheets/d/$SHEET_ID"

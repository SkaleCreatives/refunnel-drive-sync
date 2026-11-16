#!/usr/bin/env bash
# Copies each file from Refunnel's CDN into your Drive (rclone copyurl, 8 at a time, nothing is stored on your computer).
#   upload.sh < pending.tsv      lines "month<TAB>file name<TAB>url" from `node sync.mjs pending`
# Files already in Drive are skipped, so a re-run only copies what is missing. Failed files -> failed.txt.
set -euo pipefail
cat > upload.tsv
total=$(wc -l < upload.tsv | tr -d ' ')
[ "$total" -gt 0 ] || { echo "Nothing to copy, everything is in Drive."; rm -f upload.tsv; exit 0; }
echo "Copying $total files into Drive. Big libraries take hours - you can stop any time and run ./start.sh again later."
: > done.txt; : > failed.txt
one() {
  IFS=$'\t' read -r month name url <<< "$1"
  case "$url" in https://cdn.refunnel.com/*) ;; *) echo "$name (not a Refunnel link)" >> failed.txt; return ;; esac
  # month and name come from the sheet: only a plain YYYY-MM folder and a plain file name, nothing outside the folder
  [[ "$month" =~ ^[0-9]{4}-[0-9]{2}$ && "$name" =~ ^[A-Za-z0-9._-]+$ && "$name" != .* ]] || { echo "$name (unsafe name)" >> failed.txt; return; }
  if "$RCLONE" copyurl --no-clobber --retries 3 --low-level-retries 10 "$url" "gdrive:$month/$name" 2>> errors.log
  then echo "$name" >> done.txt; else echo "$name" >> failed.txt; fi
}
export -f one
( while sleep 30; do echo "  $(wc -l < done.txt | tr -d ' ') / $total copied"; done ) & progress=$!
trap 'kill $progress 2> /dev/null' EXIT
tr '\n' '\0' < upload.tsv | xargs -0 -P 8 -I{} bash -c 'one "$1"' _ {}
echo "Copied $(wc -l < done.txt | tr -d ' ') of $total. Failed: $(wc -l < failed.txt | tr -d ' ') (see failed.txt - usually files Refunnel no longer has)."
rm -f upload.tsv done.txt

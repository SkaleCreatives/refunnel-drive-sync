#!/usr/bin/env bash
# Streams the files of one shard from Refunnel's CDN straight into Drive (rclone copyurl, nothing is stored on disk).
#   upload.sh <shard> <shards> < pending.tsv      lines "month<TAB>file name<TAB>url" from `node sync.mjs pending`
# Files already in Drive are skipped, so a re-run only uploads what is missing. Failed names -> failed.txt.
set -euo pipefail
shard=$1 shards=$2
awk -F'\t' -v s="$shard" -v k="$shards" '(NR - 1) % k == s' > shard.tsv
echo "shard $shard/$shards: $(wc -l < shard.tsv | tr -d ' ') files"
: > failed.txt
one() {
  IFS=$'\t' read -r month name url <<< "$1"
  case "$url" in https://cdn.refunnel.com/*) ;; *) echo "$name (not a Refunnel URL)" >> failed.txt; return ;; esac
  rclone copyurl --no-clobber --retries 3 --low-level-retries 10 "$url" "drive:$month/$name" 2>> errors.log || echo "$name" >> failed.txt
}
export -f one
tr '\n' '\0' < shard.tsv | xargs -0 -r -P 8 -I{} bash -c 'one "$1"' _ {}
echo "shard $shard: $(wc -l < failed.txt | tr -d ' ') failed"

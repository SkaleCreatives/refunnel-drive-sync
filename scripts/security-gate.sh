#!/usr/bin/env bash
# Security gate: every change has to pass this before it reaches main (frontier0-hq policies/security-gate.md).
# Runs the same checks locally and in CI (.github/workflows/security.yml):
#   1. secrets        gitleaks over the new commits (full: whole history)
#   2. code           semgrep p/default, blocks on ERROR; against BASE only findings the change introduces
#   3. dependencies   pnpm/npm audit (high + critical) and pip-audit for uv.lock, for every lockfile in the repo
#
#   scripts/security-gate.sh            compare with origin/main (before a push / in a pull request)
#   scripts/security-gate.sh <ref>      compare with <ref>
#   scripts/security-gate.sh full       whole repo and history (weekly audit)
# Exit 0 = pass. Needs: git, gitleaks, uvx (or semgrep), node with pnpm/npm when lockfiles exist.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
BASE=${1:-origin/main}
SEMGREP_VERSION=1.185.0
EXCLUDE=(--exclude node_modules --exclude .next --exclude .output --exclude .venv --exclude .claude --exclude dist)
failed=()
step() { printf '\n== %s\n' "$1"; }

step "secrets (gitleaks)"
if [ "$BASE" = full ]; then
  gitleaks git --redact --no-banner . || failed+=(secrets)
else
  RANGE="$(git merge-base "$BASE" HEAD)..HEAD"
  if [ -n "$(git rev-list "$RANGE")" ]; then gitleaks git --redact --no-banner --log-opts="$RANGE" . || failed+=(secrets)
  else echo "no new commits"; fi
  # uncommitted changes too, when run locally before a commit
  git diff --quiet HEAD 2>/dev/null || gitleaks git --pre-commit --redact --no-banner . || failed+=(secrets-uncommitted)
fi

step "code (semgrep, ERROR blocks)"
if command -v semgrep >/dev/null; then SG=(semgrep); else SG=(uvx --quiet "semgrep@$SEMGREP_VERSION"); fi
ARGS=(scan --config p/default --metrics off --error --severity ERROR -q "${EXCLUDE[@]}")
[ -d .semgrep ] && ARGS+=(--config .semgrep)
[ "$BASE" = full ] || ARGS+=(--baseline-commit "$(git merge-base "$BASE" HEAD)")
"${SG[@]}" "${ARGS[@]}" . || failed+=(code)

step "dependencies (high + critical)"
while IFS= read -r lock; do
  dir=$(dirname "$lock"); echo "-- $dir"
  case "$lock" in
    *pnpm-lock.yaml)     (cd "$dir" && pnpm audit --audit-level high) || failed+=("deps:$dir") ;;
    *package-lock.json)  (cd "$dir" && npm audit --audit-level=high --omit=optional) || failed+=("deps:$dir") ;;
    *uv.lock)            (cd "$dir" && uv export --frozen --no-hashes --no-emit-project --format requirements-txt -q > "${TMPDIR:-/tmp}/gate-req.txt" \
                           && uvx --quiet pip-audit --strict -r "${TMPDIR:-/tmp}/gate-req.txt" --no-deps --disable-pip) || failed+=("deps:$dir") ;;
  esac
done < <(git ls-files '*pnpm-lock.yaml' '*package-lock.json' '*uv.lock' | grep -v -e '^\.claude/' -e '/node_modules/')

echo
if [ ${#failed[@]} -eq 0 ]; then echo "security gate: PASS"; exit 0; fi
echo "security gate: FAIL (${failed[*]})"
echo "Fix the finding. A false positive: '# nosemgrep: <rule-id>' with a reason on that line, or .gitleaksignore with the fingerprint."
exit 1

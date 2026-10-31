#!/usr/bin/env bash
set -u
for v in $(compgen -e | grep '^ENGRAM_'); do unset "$v"; done
# Capture only compiler caches before replacing HOME; never application state.
PASEO_TEST_GOCACHE=$(timeout 30s go env GOCACHE) || exit "$?"
PASEO_TEST_GOPATH=$(timeout 30s go env GOPATH) || exit "$?"
export PASEO_TEST_GOCACHE PASEO_TEST_GOPATH
test_state=$(mktemp -d)
trap 'rm -rf "$test_state"' EXIT
mkdir -p "$test_state/home" "$test_state/data" "$test_state/bin"
cat > "$test_state/bin/security" <<'SH'
#!/bin/sh
echo called >> "$SECURITY_CALL_LOG"
exit 1
SH
chmod +x "$test_state/bin/security"
export HOME="$test_state/home" ENGRAM_DATA_DIR="$test_state/data"
export PATH="$test_state/bin:$PATH" SECURITY_CALL_LOG="$test_state/security.calls"
if compgen -e | grep -q '^ENGRAM_CLOUD_'; then exit 90; fi
uptime
timeout 580s node --experimental-strip-types --test --test-concurrency=1 test/*.test.mjs
rc=$?
uptime
calls=0
if [ -f "$SECURITY_CALL_LOG" ]; then calls=$(wc -l < "$SECURITY_CALL_LOG"); fi
printf 'exit_code=%s security_calls=%s\n' "$rc" "$calls"
if [ "$calls" -ne 0 ]; then exit 91; fi
exit "$rc"

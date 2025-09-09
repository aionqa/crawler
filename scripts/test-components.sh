#!/usr/bin/env bash
set -euo pipefail
if [ "${TEST_DEBUG:-0}" = "1" ]; then set -x; fi

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACK_PORT="${BACK_PORT:-4000}"
UI_PORT="${UI_PORT:-5173}"
MAX_WAIT="${MAX_WAIT:-20}"
PLAYWRIGHT_TIMEOUT="${PLAYWRIGHT_TIMEOUT:-60}"
CURL_MAX_TIME="${CURL_MAX_TIME:-15}"

log() { echo "[test] $*"; }
debug() { echo "[debug $(date +%H:%M:%S)] $*"; }

progress_wait_http_ok() {
  local url="$1"; local attempts="${2:-$MAX_WAIT}"; local delay="${3:-1}"; local i
  for ((i=1;i<=attempts;i++)); do
    if curl --max-time "$CURL_MAX_TIME" -sSf -o /dev/null "$url"; then return 0; fi
    printf "."; sleep "$delay"
  done
  echo ""; return 1
}

start_proc() {
  # args: name cwd command...
  local name="$1"; shift
  local cwd="$1"; shift
  local logfile="$BASE_DIR/.test-$name.log"
  local pidfile="$BASE_DIR/.test-$name.pid"
  : >"$logfile"
  debug "start_proc name=$name cwd=$cwd cmd=$* > $logfile"
  ( cd "$cwd" && "$@" >"$logfile" 2>&1 & echo $! ) | tee "$pidfile"
}

read_pid() {
  local name="$1"; local pidfile="$BASE_DIR/.test-$name.pid"
  if [ -f "$pidfile" ]; then cat "$pidfile"; fi
}

tail_log_bg() {
  local name="$1"; local logfile="$BASE_DIR/.test-$name.log"
  debug "tailing $logfile in background"
  stdbuf -o0 tail -n +1 -f "$logfile" & echo $!
}

stop_proc() {
  local pid="$1"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
}

print_last_log() {
  local name="$1"; local logfile="$BASE_DIR/.test-$name.log"
  echo "----- last 80 lines of $logfile -----"
  tail -n 80 "$logfile" || true
  echo "-------------------------------------"
}

mongo_available() {
  # best-effort TCP check
  (exec 3<>/dev/tcp/127.0.0.1/27017) >/dev/null 2>&1 || return 1
  exec 3>&- 3<&-
  return 0
}

prep_playwright() {
  local repo_dir="$1"
  # Only install if repo depends on Playwright
  if [ -f "$repo_dir/package.json" ] && grep -q 'playwright' "$repo_dir/package.json"; then
    timeout "$PLAYWRIGHT_TIMEOUT"s bash -lc "cd '$repo_dir' && npx -y playwright install chromium" >/dev/null 2>&1 || true
  fi
}

test_back() {
  log "Testing backend (/healthz)"
  if ! mongo_available; then
    log "MongoDB not reachable on 127.0.0.1:27017 — skipping backend test"
    return 0
  fi
  local pid tailpid
  start_proc backend "$BASE_DIR/back" env PORT="$BACK_PORT" node src/index.js >/dev/null
  pid=$(read_pid backend)
  tailpid=$(tail_log_bg backend)
  trap "stop_proc $pid; kill $tailpid 2>/dev/null || true" EXIT
  debug "waiting for backend on :$BACK_PORT/healthz (MAX_WAIT=$MAX_WAIT)"
  progress_wait_http_ok "http://127.0.0.1:$BACK_PORT/healthz" "$MAX_WAIT" 1 || { log "backend failed to start in time"; print_last_log backend; exit 1; }
  node "$BASE_DIR/test/back-health.js"
  stop_proc "$pid"; kill "$tailpid" 2>/dev/null || true; trap - EXIT
  log "Backend test: OK"
}

test_ui() {
  log "Testing UI (vite preview)"
  timeout 180s bash -lc "cd '$BASE_DIR/ui' && npm run -s build" >/dev/null || { log "UI build timed out/failed"; exit 1; }
  local pid tailpid
  start_proc ui "$BASE_DIR/ui" npm run -s preview -- --port "$UI_PORT" --strictPort >/dev/null
  pid=$(read_pid ui)
  tailpid=$(tail_log_bg ui)
  trap "stop_proc $pid; kill $tailpid 2>/dev/null || true" EXIT
  debug "waiting for UI on :$UI_PORT (MAX_WAIT=$MAX_WAIT)"
  progress_wait_http_ok "http://127.0.0.1:$UI_PORT/" "$MAX_WAIT" 1 || { log "UI failed to start in time"; print_last_log ui; exit 1; }
  curl --max-time "$CURL_MAX_TIME" -sSf "http://127.0.0.1:$UI_PORT/" >/dev/null
  stop_proc "$pid"; kill "$tailpid" 2>/dev/null || true; trap - EXIT
  log "UI test: OK"
}

start_agent() {
  local name="$1"; local dir="$2"; local port="$3"
  prep_playwright "$dir"
  start_proc "$name" "$dir" env PORT="$port" node src/server.js
}

rpc_health_wait() {
  local port="$1"; local i
  for ((i=1;i<=MAX_WAIT;i++)); do
    if curl --max-time "$CURL_MAX_TIME" -sS -X POST -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":"1","method":"health","params":{}}' \
      "http://127.0.0.1:$port/rpc" >/dev/null 2>&1; then
      return 0
    fi
    printf "."; sleep 1
  done
  echo ""; return 1
}

test_agent_health() {
  local name="$1"; local dir="$2"; local port="$3"
  log "Testing $name health"
  local pid tailpid
  start_agent "$name" "$dir" "$port" >/dev/null
  pid=$(read_pid "$name")
  tailpid=$(tail_log_bg "$name")
  trap "stop_proc $pid; kill $tailpid 2>/dev/null || true" EXIT
  debug "waiting for $name RPC health on :$port (MAX_WAIT=$MAX_WAIT)"
  rpc_health_wait "$port" || { log "$name failed to report health"; print_last_log "$name"; exit 1; }
  AGENT_URL="http://127.0.0.1:$port" node "$BASE_DIR/test/agent-health.js"
  stop_proc "$pid"; kill "$tailpid" 2>/dev/null || true; trap - EXIT
  log "$name health: OK"
}

test_login_text() {
  local port=3002
  log "Testing login-text attemptLogin against practice site"
  local pid tailpid
  start_agent login-text "$BASE_DIR/login-text" "$port" >/dev/null
  pid=$(read_pid login-text)
  tailpid=$(tail_log_bg login-text)
  trap "stop_proc $pid; kill $tailpid 2>/dev/null || true" EXIT
  debug "waiting for login-text RPC health on :$port (MAX_WAIT=$MAX_WAIT)"
  rpc_health_wait "$port" || { log "login-text failed to report health"; print_last_log login-text; exit 1; }
  curl --max-time "$CURL_MAX_TIME" -sS -X POST -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":"1","method":"attemptLogin","params":{"url":"https://practicetestautomation.com/practice-test-login/","credentials":{"username":"student","password":"Password123"},"options":{"maxWaitMsPerAction":30000,"maxRetries":1,"headless":true}}}' \
    "http://127.0.0.1:$port/rpc" | tee "$BASE_DIR/.test-login-text.json" >/dev/null
  if grep -q '"success":true' "$BASE_DIR/.test-login-text.json"; then
    log "login-text test: OK"
  else
    log "login-text test: FAILED (no success=true)"; print_last_log login-text; stop_proc "$pid"; kill "$tailpid" 2>/dev/null || true; exit 1
  fi
  stop_proc "$pid"; kill "$tailpid" 2>/dev/null || true; trap - EXIT
}

test_login_static() {
  local port=3004
  log "Testing login-static attemptLogin against practice site"
  local pid tailpid
  start_agent login-static "$BASE_DIR/login-static" "$port" >/dev/null
  pid=$(read_pid login-static)
  tailpid=$(tail_log_bg login-static)
  trap "stop_proc $pid; kill $tailpid 2>/dev/null || true" EXIT
  debug "waiting for login-static RPC health on :$port (MAX_WAIT=$MAX_WAIT)"
  rpc_health_wait "$port" || { log "login-static failed to report health"; print_last_log login-static; exit 1; }
  curl --max-time "$CURL_MAX_TIME" -sS -X POST -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":"1","method":"attemptLogin","params":{"url":"https://practicetestautomation.com/practice-test-login/","credentials":{"username":"student","password":"Password123"},"options":{"maxWaitMsPerAction":30000,"maxRetries":1,"headless":true}}}' \
    "http://127.0.0.1:$port/rpc" | tee "$BASE_DIR/.test-login-static.json" >/dev/null
  if grep -q '"success":true' "$BASE_DIR/.test-login-static.json"; then
    log "login-static test: OK"
  else
    log "login-static test: FAILED (no success=true)"; print_last_log login-static; stop_proc "$pid"; kill "$tailpid" 2>/dev/null || true; exit 1
  fi
  stop_proc "$pid"; kill "$tailpid" 2>/dev/null || true; trap - EXIT
}

test_crawler_static() {
  local port=3104
  log "Testing crawler-static health"
  local pid tailpid
  start_agent crawler-static "$BASE_DIR/crawler-static" "$port" >/dev/null
  pid=$(read_pid crawler-static)
  tailpid=$(tail_log_bg crawler-static)
  trap "stop_proc $pid; kill $tailpid 2>/dev/null || true" EXIT
  debug "waiting for crawler-static RPC health on :$port (MAX_WAIT=$MAX_WAIT)"
  rpc_health_wait "$port" || { log "crawler-static failed to report health"; print_last_log crawler-static; exit 1; }
  AGENT_URL="http://127.0.0.1:$port" node "$BASE_DIR/test/agent-health.js"
  stop_proc "$pid"; kill "$tailpid" 2>/dev/null || true; trap - EXIT
  log "crawler-static health: OK"
}

case "${1:-all}" in
  back) test_back ;;
  ui) test_ui ;;
  crawler-static) test_crawler_static ;;
  login-text) test_login_text ;;
  login-static) test_login_static ;;
  all)
    test_ui
    test_crawler_static
    test_login_text
    test_login_static
    test_back
    ;;
  *) echo "Usage: $0 [back|ui|crawler-static|login-text|login-static|all]"; exit 2 ;;
esac



#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$BASE_DIR/.run-logs"
mkdir -p "$LOG_DIR"
STOPPING=0

echo "Starting AI Crawler System..."

# Static port assignments (override via env if needed)
UI_PORT=${UI_PORT:-3000}
BACK_PORT=${BACK_PORT:-4000}

LOGIN_SIMPLIFIED_PORT=${LOGIN_SIMPLIFIED_PORT:-3001}
LOGIN_TEXT_PORT=${LOGIN_TEXT_PORT:-3002}
LOGIN_MEDIA_PORT=${LOGIN_MEDIA_PORT:-3003}
LOGIN_STATIC_PORT=${LOGIN_STATIC_PORT:-3004}

CRAWLER_TEXT_PORT=${CRAWLER_TEXT_PORT:-3101}
CRAWLER_MEDIA_PORT=${CRAWLER_MEDIA_PORT:-3102}
CRAWLER_SIMPLIFIED_PORT=${CRAWLER_SIMPLIFIED_PORT:-3103}
CRAWLER_STATIC_PORT=${CRAWLER_STATIC_PORT:-3104}

PIDS=()
NAMES=()
LOGS=()

exists_and_has() {
  local dir="$1"; shift
  local file="$1"; shift
  [ -d "$dir" ] && [ -f "$dir/$file" ]
}

start_proc() {
  local name="$1"; shift
  local cwd="$1"; shift
  local logfile="$LOG_DIR/$name.log"
  >&2 echo "→ Starting $name in $cwd (log: $logfile)"
  (
    cd "$cwd" && (
      "$@" 2>&1 | stdbuf -o0 -e0 awk -v name="$name" '{ cmd="date +%H:%M:%S"; cmd | getline t; close(cmd); line=$0; lower=tolower(line); emoji="ℹ️"; if (lower ~ /(error|failed|exception|fatal)/) emoji="❌"; else if (lower ~ /(warn|deprecated)/) emoji="⚠️"; else if (lower ~ /(listening|ready|started|success|ok)/) emoji="✅"; printf "[%s][%s] %s %s\n", name, t, emoji, line; fflush(); }' | tee -a "$logfile" ) & echo $!
  )
}

launch() {
  local name="$1"; shift
  local cwd="$1"; shift
  local logfile="$LOG_DIR/$name.log"
  local pid
  pid=$(start_proc "$name" "$cwd" "$@")
  PIDS+=("$pid")
  NAMES+=("$name")
  LOGS+=("$logfile")
  echo "[launcher] started $name pid=$pid log=$logfile"
}

stop_all() {
  # Prevent re-entrancy on multiple Ctrl+C
  if [ "${STOPPING}" = "1" ]; then return; fi
  STOPPING=1
  echo "\nStopping services..."
  set +e
  for pid in "${PIDS[@]:-}"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  # Best-effort: kill all remaining children of this script
  pkill -P $$ 2>/dev/null || true
  echo "All services stopped."
  exit 0
}
trap 'stop_all' INT TERM

# Agents (logins) — start only if repo exists
if exists_and_has "$BASE_DIR/login-simplified" src/server.js; then
  launch login-simplified "$BASE_DIR/login-simplified" bash -lc "[ -d node_modules ] || npm ci --silent; env PORT=$LOGIN_SIMPLIFIED_PORT node src/server.js"
else echo "[launcher] skip login-simplified (missing)"; fi
if exists_and_has "$BASE_DIR/login-text" src/server.js; then
  launch login-text       "$BASE_DIR/login-text"       bash -lc "[ -d node_modules ] || npm ci --silent; env PORT=$LOGIN_TEXT_PORT node src/server.js"
else echo "[launcher] skip login-text (missing)"; fi
if exists_and_has "$BASE_DIR/login-media" src/server.js; then
  launch login-media      "$BASE_DIR/login-media"      bash -lc "[ -d node_modules ] || npm ci --silent; env PORT=$LOGIN_MEDIA_PORT node src/server.js"
else echo "[launcher] skip login-media (missing)"; fi
if exists_and_has "$BASE_DIR/login-static" src/server.js; then
  launch login-static     "$BASE_DIR/login-static"     bash -lc "[ -d node_modules ] || npm ci --silent; env PORT=$LOGIN_STATIC_PORT node src/server.js"
else echo "[launcher] skip login-static (missing)"; fi

# Agents (crawlers) — start only if repo exists
if exists_and_has "$BASE_DIR/crawler-text" src/server.js; then
  launch crawler-text       "$BASE_DIR/crawler-text"       bash -lc "[ -d node_modules ] || npm ci --silent; env PORT=$CRAWLER_TEXT_PORT node src/server.js"
else echo "[launcher] skip crawler-text (missing)"; fi
if exists_and_has "$BASE_DIR/crawler-media" src/server.js; then
  launch crawler-media      "$BASE_DIR/crawler-media"      bash -lc "[ -d node_modules ] || npm ci --silent; env PORT=$CRAWLER_MEDIA_PORT node src/server.js"
else echo "[launcher] skip crawler-media (missing)"; fi
if exists_and_has "$BASE_DIR/crawler-simplified" src/server.js; then
  launch crawler-simplified "$BASE_DIR/crawler-simplified" bash -lc "[ -d node_modules ] || npm ci --silent; env PORT=$CRAWLER_SIMPLIFIED_PORT node src/server.js"
else echo "[launcher] skip crawler-simplified (missing)"; fi
if exists_and_has "$BASE_DIR/crawler-static" src/server.js; then
  launch crawler-static     "$BASE_DIR/crawler-static"     bash -lc "[ -d node_modules ] || npm ci --silent; env PORT=$CRAWLER_STATIC_PORT node src/server.js"
else echo "[launcher] skip crawler-static (missing)"; fi

# Backend (inject agent URLs)
export LOGIN_SIMPLIFIED_URL="http://127.0.0.1:$LOGIN_SIMPLIFIED_PORT"
export LOGIN_TEXT_URL="http://127.0.0.1:$LOGIN_TEXT_PORT"
export LOGIN_MEDIA_URL="http://127.0.0.1:$LOGIN_MEDIA_PORT"
export LOGIN_STATIC_URL="http://127.0.0.1:$LOGIN_STATIC_PORT"

# Pass UI origin to backend CORS (start only if back exists)
if exists_and_has "$BASE_DIR/back" src/index.js; then
  launch backend "$BASE_DIR/back" bash -lc "[ -d node_modules ] || npm ci --silent; env PORT=$BACK_PORT ORIGIN=http://localhost:$UI_PORT node src/index.js"
else echo "[launcher] skip backend (missing)"; fi

# UI (preview on static port) — start only if UI exists
if exists_and_has "$BASE_DIR/ui" package.json; then
  launch ui "$BASE_DIR/ui" bash -lc "[ -d node_modules ] || npm ci --silent; npm run -s preview -- --port $UI_PORT --strictPort"
else echo "[launcher] skip ui (missing)"; fi

echo "\nServices started!"
echo "Backend:   http://localhost:$BACK_PORT    (log: $LOG_DIR/backend.log)"
echo "UI:        http://localhost:$UI_PORT      (log: $LOG_DIR/ui.log)"
echo "\nLogin agents:"
echo "  login-simplified: $LOGIN_SIMPLIFIED_URL (log: $LOG_DIR/login-simplified.log)"
echo "  login-text:       http://127.0.0.1:$LOGIN_TEXT_PORT (log: $LOG_DIR/login-text.log)"
echo "  login-media:      http://127.0.0.1:$LOGIN_MEDIA_PORT (log: $LOG_DIR/login-media.log)"
echo "  login-static:     http://127.0.0.1:$LOGIN_STATIC_PORT (log: $LOG_DIR/login-static.log)"
echo "\nCrawler agents:"
echo "  crawler-text:       http://127.0.0.1:$CRAWLER_TEXT_PORT (log: $LOG_DIR/crawler-text.log)"
echo "  crawler-media:      http://127.0.0.1:$CRAWLER_MEDIA_PORT (log: $LOG_DIR/crawler-media.log)"
echo "  crawler-simplified: http://127.0.0.1:$CRAWLER_SIMPLIFIED_PORT (log: $LOG_DIR/crawler-simplified.log)"
echo "  crawler-static:     http://127.0.0.1:$CRAWLER_STATIC_PORT (log: $LOG_DIR/crawler-static.log)"

echo "\nTo tail all logs: tail -f $LOG_DIR/*.log"
echo "Live logs are streaming below. Press Ctrl+C to stop all services."

# Print process table
printf "\n%-22s %-8s %s\n" "Process" "PID" "Log file"
for i in "${!PIDS[@]}"; do
  printf "%-22s %-8s %s\n" "${NAMES[$i]}" "${PIDS[$i]}" "${LOGS[$i]}"
done

# Readiness probes (non-fatal)
probe_http() { local url="$1"; for i in $(seq 1 20); do curl -sSf "$url" >/dev/null 2>&1 && echo "[probe] $url ✅" && return 0; sleep 1; done; echo "[probe] $url ⚠️ timeout"; }
probe_rpc() { local port="$1"; for i in $(seq 1 20); do curl -sS -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":"1","method":"health","params":{}}' "http://127.0.0.1:$port/rpc" >/dev/null 2>&1 && echo "[probe] agent:$port ✅" && return 0; sleep 1; done; echo "[probe] agent:$port ⚠️ timeout"; }

probe_rpc "$LOGIN_SIMPLIFIED_PORT" &
probe_rpc "$LOGIN_TEXT_PORT" &
probe_rpc "$LOGIN_MEDIA_PORT" &
probe_rpc "$LOGIN_STATIC_PORT" &
probe_rpc "$CRAWLER_TEXT_PORT" &
probe_rpc "$CRAWLER_MEDIA_PORT" &
probe_rpc "$CRAWLER_SIMPLIFIED_PORT" &
probe_rpc "$CRAWLER_STATIC_PORT" &
probe_http "http://127.0.0.1:$BACK_PORT/healthz" &
probe_http "http://127.0.0.1:$UI_PORT/" &

# Wait on all children; Ctrl+C triggers trap -> stop_all -> exit
wait

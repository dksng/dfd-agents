#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/agent-orch"
PID_FILE="$STATE_DIR/orch.pid"
LOCK_FILE="$STATE_DIR/orch.lock"
META_FILE="$STATE_DIR/meta.json"
LOG_FILE="$STATE_DIR/server.log"
VENV_DIR="$ROOT_DIR/.venv"
FRONTEND_DIR="$ROOT_DIR/frontend"
DIST_DIR="$FRONTEND_DIR/dist"
BUILD_HEAD_FILE="$DIST_DIR/.agent-orch-build-head"
ENV_FILE="$SCRIPT_DIR/orch.env"
ENV_EXAMPLE="$SCRIPT_DIR/orch.env.example"
NODE_VERSION_FILE="$ROOT_DIR/.node-version"

HOST="127.0.0.1"
PORT="8000"
DEV_PORT="5173"
AUTO_OPEN=1
DEV_MODE=0
FORCE=0
AUTO_DEPS=0
PURGE_DATA=0
PORT_OVERRIDDEN=0
PYTHON_BIN="${ORCH_PYTHON_BIN:-}"

usage() {
  cat <<'EOF'
Usage: scripts/orch.sh <command> [options]

Commands:
  setup [--auto-deps]          Install venv, Python deps, npm deps, and build frontend.
  start [--dev] [--no-open] [--port N]
                               Start the singleton server in the background.
  stop [--force]               Stop the running server.
  restart [start options]      Stop, then start.
  status                       Show PID, URL, health, adapter, and commit.
  logs [-f]                    Show server logs; -f follows.
  open                         Open the running instance in a browser.
  doctor                       Diagnose local prerequisites and configuration.
  update                       git pull --ff-only, setup, restart.
  clean|uninstall [--purge-data]
                               Remove local dependencies/build output; data only with confirmation.

Environment:
  ORCH_PYTHON_BIN=/path/to/python3.12
                               Use a specific Python 3.11+ interpreter.
EOF
}

info() { printf '[orch] %s\n' "$*"; }
warn() { printf '[orch] warning: %s\n' "$*" >&2; }
err() { printf '[orch] error: %s\n' "$*" >&2; }
die() {
  local code="${2:-1}"
  err "$1"
  exit "$code"
}

command_exists() { command -v "$1" >/dev/null 2>&1; }

ensure_state_dir() { mkdir -p "$STATE_DIR"; }

python_supports_project() {
  local candidate="$1"
  [[ -n "$candidate" ]] || return 1
  command_exists "$candidate" || return 1
  "$candidate" - <<'PY' >/dev/null 2>&1
import sys
raise SystemExit(0 if sys.version_info >= (3, 11) else 1)
PY
}

select_python() {
  local preferred="${ORCH_PYTHON_BIN:-}"
  if [[ -n "$preferred" ]]; then
    PYTHON_BIN="$preferred"
    python_supports_project "$PYTHON_BIN"
    return
  fi
  if [[ -n "$PYTHON_BIN" ]]; then
    python_supports_project "$PYTHON_BIN" && return
    PYTHON_BIN=""
  fi
  local candidate
  for candidate in python3.14 python3.13 python3.12 python3.11 python3; do
    if python_supports_project "$candidate"; then
      PYTHON_BIN="$(command -v "$candidate")"
      return 0
    fi
  done
  return 1
}

die_python_missing() {
  if [[ -n "${ORCH_PYTHON_BIN:-}" ]]; then
    err "ORCH_PYTHON_BIN must point to Python 3.11 or newer: ${ORCH_PYTHON_BIN}"
  else
    err "Python 3.11+ is required, but no usable interpreter was found."
    err "Install Python 3.11 or newer and retry. If it is installed under a custom name, set ORCH_PYTHON_BIN=/path/to/python."
  fi
  exit 1
}

require_python() {
  select_python || die_python_missing
}

load_env() {
  if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi
  HOST="${HOST:-127.0.0.1}"
  PORT="${PORT:-8000}"
}

apply_meta_network() {
  local meta_host meta_port
  meta_host="$(json_value host 2>/dev/null || true)"
  meta_port="$(json_value port 2>/dev/null || true)"
  [[ -n "$meta_host" ]] && HOST="$meta_host"
  [[ -n "$meta_port" ]] && PORT="$meta_port"
  return 0
}

python_ok() {
  select_python
}

node_ok() {
  command_exists node && node - <<'JS' >/dev/null 2>&1
const [major, minor] = process.versions.node.split(".").map(Number);
const ok = (major === 20 && minor >= 19) || (major === 21) || (major === 22 && minor >= 12) || major > 22;
process.exit(ok ? 0 : 1);
JS
}

head_commit() {
  git -C "$ROOT_DIR" rev-parse --short=12 HEAD 2>/dev/null || printf 'unknown'
}

full_head_commit() {
  git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || printf 'unknown'
}

generate_token() {
  require_python
  "$PYTHON_BIN" - <<'PY'
import secrets
print("orch_" + secrets.token_urlsafe(32))
PY
}

init_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    return
  fi
  [[ -f "$ENV_EXAMPLE" ]] || die "Missing $ENV_EXAMPLE"
  local token
  token="$(generate_token)"
  sed "s|^ORCH_TOKEN=.*|ORCH_TOKEN=$token|" "$ENV_EXAMPLE" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  info "Created $ENV_FILE with a generated ORCH_TOKEN"
}

api_base() {
  printf 'http://%s:%s' "$HOST" "$PORT"
}

dev_url() {
  printf 'http://%s:%s' "$HOST" "$DEV_PORT"
}

http_get() {
  local url="$1"
  require_python
  "$PYTHON_BIN" - "$url" <<'PY'
import sys
import urllib.request

url = sys.argv[1]
try:
    with urllib.request.urlopen(url, timeout=2) as response:
        sys.stdout.write(response.read().decode("utf-8", errors="replace"))
except Exception:
    raise SystemExit(1)
PY
}

health_ok() {
  http_get "$(api_base)/api/health" >/dev/null 2>&1
}

json_value() {
  local key="$1"
  [[ -f "$META_FILE" ]] || return 1
  require_python
  "$PYTHON_BIN" - "$META_FILE" "$key" <<'PY'
import json
import sys

path, key = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(path, encoding="utf-8"))
except Exception:
    raise SystemExit(1)
value = data.get(key)
if value is None:
    raise SystemExit(1)
print(value)
PY
}

pid_alive() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" >/dev/null 2>&1
}

record_meta() {
  local pid="$1"
  local url="$2"
  local mode="$3"
  local vite_pid="${4:-}"
  require_python
  "$PYTHON_BIN" - "$META_FILE" "$pid" "$HOST" "$PORT" "$url" "$ROOT_DIR" "$(full_head_commit)" "$mode" "$vite_pid" <<'PY'
import datetime as dt
import json
import sys

path, pid, host, port, url, repo, commit, mode, vite_pid = sys.argv[1:]
payload = {
    "pid": int(pid),
    "host": host,
    "port": int(port),
    "url": url,
    "repo": repo,
    "commit": commit,
    "mode": mode,
    "started_at": dt.datetime.now(dt.UTC).isoformat(),
}
if vite_pid:
    payload["vite_pid"] = int(vite_pid)
with open(path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY
}

mark_stopped() {
  [[ -f "$META_FILE" ]] || return 0
  require_python
  "$PYTHON_BIN" - "$META_FILE" <<'PY' >/dev/null 2>&1 || true
import datetime as dt
import json
import sys

path = sys.argv[1]
try:
    data = json.load(open(path, encoding="utf-8"))
except Exception:
    data = {}
data["stopped_at"] = dt.datetime.now(dt.UTC).isoformat()
with open(path, "w", encoding="utf-8") as handle:
    json.dump(data, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY
}

is_wsl() {
  grep -qi microsoft /proc/version 2>/dev/null
}

open_browser() {
  local url="$1"
  if [[ "$AUTO_OPEN" -eq 0 ]]; then
    info "Open: $url"
    return 0
  fi
  if [[ "$(uname -s)" == "Darwin" ]] && command_exists open; then
    open "$url" >/dev/null 2>&1 && return 0
  fi
  if is_wsl; then
    if command_exists wslview; then
      wslview "$url" >/dev/null 2>&1 && return 0
    fi
    if command_exists cmd.exe; then
      cmd.exe /c start "$url" >/dev/null 2>&1 && return 0
    fi
    if command_exists powershell.exe; then
      powershell.exe -NoProfile Start-Process "$url" >/dev/null 2>&1 && return 0
    fi
  fi
  if command_exists xdg-open; then
    xdg-open "$url" >/dev/null 2>&1 && return 0
  fi
  if [[ -n "${BROWSER:-}" ]]; then
    "$BROWSER" "$url" >/dev/null 2>&1 && return 0
  fi
  info "Open manually: $url"
}

port_in_use() {
  local port="$1"
  if command_exists ss; then
    ss -ltn | awk '{print $4}' | grep -Eq "[:.]$port$"
  elif command_exists lsof; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif command_exists netstat; then
    netstat -an | grep -Eq "[.:]$port .*LISTEN"
  else
    require_python
    "$PYTHON_BIN" - "$HOST" "$port" <<'PY' >/dev/null 2>&1
import socket
import sys

host, port = sys.argv[1], int(sys.argv[2])
sock = socket.socket()
try:
    sock.bind((host, port))
except OSError:
    raise SystemExit(0)
raise SystemExit(1)
PY
  fi
}

load_node_manager() {
  if command_exists fnm; then
    eval "$(fnm env --shell bash)" || true
    return 0
  fi
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.nvm/nvm.sh"
    return 0
  fi
  if [[ -x "$HOME/.local/share/fnm/fnm" ]]; then
    export PATH="$HOME/.local/share/fnm:$PATH"
    eval "$("$HOME/.local/share/fnm/fnm" env --shell bash)" || true
    return 0
  fi
  return 1
}

install_node_auto() {
  local version
  version="$(cat "$NODE_VERSION_FILE" 2>/dev/null || printf '22')"
  load_node_manager || true
  if command_exists fnm; then
    fnm install "$version"
    fnm use "$version"
    return
  fi
  if command_exists nvm; then
    nvm install "$version"
    nvm use "$version"
    return
  fi
  command_exists curl || die "Node is missing/old and curl is unavailable. Install Node 22 manually." 1
  info "Installing fnm under ~/.local/share/fnm"
  curl -fsSL https://fnm.vercel.app/install | bash -s -- --install-dir "$HOME/.local/share/fnm" --skip-shell
  export PATH="$HOME/.local/share/fnm:$PATH"
  eval "$("$HOME/.local/share/fnm/fnm" env --shell bash)"
  fnm install "$version"
  fnm use "$version"
}

ensure_prereqs() {
  require_python
  load_node_manager || true
  if ! node_ok; then
    if [[ "$AUTO_DEPS" -eq 1 ]]; then
      install_node_auto
    else
      die "Node.js 20.19+ or 22.12+ is required. Install Node 22, or run setup --auto-deps." 1
    fi
  fi
  command_exists git || die "git is required." 1
}

install_backend() {
  if [[ ! -x "$VENV_DIR/bin/python" || ! -x "$VENV_DIR/bin/pip" ]]; then
    rm -rf "$VENV_DIR"
    info "Creating Python virtual environment"
    if ! "$PYTHON_BIN" -m venv "$VENV_DIR"; then
      rm -rf "$VENV_DIR"
      die "Failed to create .venv. On Debian/Ubuntu install the matching venv package (for example: sudo apt install python3.12-venv) and rerun setup." 1
    fi
  fi
  info "Installing Python dependencies"
  "$VENV_DIR/bin/python" -m pip install --upgrade pip
  "$VENV_DIR/bin/pip" install -e "$ROOT_DIR[dev]"
}

install_frontend() {
  info "Installing frontend dependencies"
  (cd "$FRONTEND_DIR" && npm ci)
}

build_frontend() {
  info "Building frontend"
  (cd "$FRONTEND_DIR" && npm run build)
  mkdir -p "$DIST_DIR"
  full_head_commit > "$BUILD_HEAD_FILE"
}

cmd_setup() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --auto-deps) AUTO_DEPS=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown setup option: $1" 1 ;;
    esac
    shift
  done
  cd "$ROOT_DIR"
  init_env_file
  load_env
  ensure_prereqs
  install_backend
  install_frontend
  build_frontend
  info "Setup complete"
}

needs_setup() {
  [[ ! -x "$VENV_DIR/bin/python" ]] && return 0
  [[ ! -d "$FRONTEND_DIR/node_modules" ]] && return 0
  if [[ "$DEV_MODE" -eq 0 && ! -f "$DIST_DIR/index.html" ]]; then
    return 0
  fi
  return 1
}

ensure_build_current() {
  [[ "$DEV_MODE" -eq 1 ]] && return 0
  local current built
  current="$(full_head_commit)"
  built="$(cat "$BUILD_HEAD_FILE" 2>/dev/null || true)"
  if [[ ! -f "$DIST_DIR/index.html" || "$current" != "$built" ]]; then
    build_frontend
  fi
}

rotate_log() {
  mkdir -p "$STATE_DIR"
  if [[ -f "$LOG_FILE" ]]; then
    local size
    size="$(wc -c < "$LOG_FILE" 2>/dev/null || printf 0)"
    if [[ "$size" -gt 10485760 ]]; then
      mv "$LOG_FILE" "$LOG_FILE.1"
    fi
  fi
}

read_pid_file() {
  [[ -f "$PID_FILE" ]] && cat "$PID_FILE"
}

running_from_state() {
  local pid
  pid="$(read_pid_file || true)"
  [[ -n "$pid" ]] || return 1
  pid_alive "$pid" || return 1
  return 0
}

wait_for_health() {
  local i
  for i in {1..60}; do
    if health_ok; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

parse_start_options() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dev) DEV_MODE=1 ;;
      --no-open) AUTO_OPEN=0 ;;
      --port)
        shift
        [[ $# -gt 0 ]] || die "--port requires a value" 1
        PORT="$1"
        PORT_OVERRIDDEN=1
        ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown start option: $1" 1 ;;
    esac
    shift
  done
}

start_backend() {
  local cmd_pid
  export ORCH_API_BASE
  ORCH_API_BASE="$(api_base)"
  cd "$ROOT_DIR"
  if command_exists setsid; then
    setsid bash -c 'exec "$@"' _ "$VENV_DIR/bin/python" -m agent_orchestrator.cli serve --host "$HOST" --port "$PORT" >> "$LOG_FILE" 2>&1 &
  else
    nohup bash -c 'exec "$@"' _ "$VENV_DIR/bin/python" -m agent_orchestrator.cli serve --host "$HOST" --port "$PORT" >> "$LOG_FILE" 2>&1 &
  fi
  cmd_pid="$!"
  printf '%s\n' "$cmd_pid" > "$PID_FILE"
  printf '%s\n' "$cmd_pid"
}

start_vite() {
  local vite_pid
  export VITE_API_BASE
  VITE_API_BASE="$(api_base)"
  if command_exists setsid; then
    setsid bash -c 'cd "$1" && exec npm exec vite -- --host "$2" --port "$3"' _ "$FRONTEND_DIR" "$HOST" "$DEV_PORT" >> "$LOG_FILE" 2>&1 &
  else
    nohup bash -c 'cd "$1" && exec npm exec vite -- --host "$2" --port "$3"' _ "$FRONTEND_DIR" "$HOST" "$DEV_PORT" >> "$LOG_FILE" 2>&1 &
  fi
  vite_pid="$!"
  printf '%s\n' "$vite_pid"
}

cmd_start() {
  if [[ ! -f "$ENV_FILE" ]]; then
    init_env_file
  fi
  load_env
  parse_start_options "$@"
  ensure_state_dir
  exec 9>"$LOCK_FILE"
  if command_exists flock; then
    flock -n 9 || die "Another start operation is running." 2
  else
    if ! mkdir "$STATE_DIR/orch.lockdir" 2>/dev/null; then
      die "Another start operation is running." 2
    fi
    trap 'rmdir "$STATE_DIR/orch.lockdir" 2>/dev/null || true' EXIT
  fi

  if running_from_state; then
    apply_meta_network
  fi
  if running_from_state && health_ok; then
    local url
    url="$(json_value url 2>/dev/null || api_base)"
    info "Already running at $url"
    open_browser "$url"
    exit 0
  fi

  rm -f "$PID_FILE"
  if port_in_use "$PORT"; then
    die "Port $PORT is already in use by another process." 2
  fi
  if [[ "$DEV_MODE" -eq 1 ]] && port_in_use "$DEV_PORT"; then
    die "Dev port $DEV_PORT is already in use by another process." 2
  fi

  if needs_setup; then
    local requested_port="$PORT"
    info "Dependencies/build output missing; running setup"
    cmd_setup
    load_env
    if [[ "$PORT_OVERRIDDEN" -eq 1 ]]; then
      PORT="$requested_port"
    fi
  else
    ensure_prereqs
  fi
  ensure_build_current
  rotate_log

  local pid url vite_pid
  pid="$(start_backend)"
  if [[ "$DEV_MODE" -eq 1 ]]; then
    vite_pid="$(start_vite)"
    url="$(dev_url)"
    record_meta "$pid" "$url" "dev" "$vite_pid"
  else
    url="$(api_base)"
    record_meta "$pid" "$url" "prod"
  fi

  if ! wait_for_health; then
    err "Health check failed. Last server log lines:"
    tail -80 "$LOG_FILE" >&2 || true
    exit 3
  fi
  info "Started at $url (pid $pid)"
  open_browser "$url"
}

active_attention_warning() {
  local body
  body="$(http_get "$(api_base)/api/attention" 2>/dev/null || true)"
  [[ -n "$body" ]] || return 0
  require_python
  "$PYTHON_BIN" - "$body" <<'PY'
import json
import sys
try:
    rows = json.loads(sys.argv[1])
except Exception:
    raise SystemExit(1)
waiting = sum(int(row.get("waiting_qa") or 0) for row in rows)
review = sum(int(row.get("in_review") or 0) for row in rows)
failed = sum(int(row.get("failed") or 0) for row in rows)
if waiting or review or failed:
    print(f"attention backlog: waiting_qa={waiting}, in_review={review}, failed={failed}")
PY
}

confirm_or_exit() {
  local prompt="$1"
  if [[ "$FORCE" -eq 1 ]]; then
    return 0
  fi
  if [[ ! -t 0 ]]; then
    die "$prompt Use --force to proceed non-interactively." 2
  fi
  read -r -p "$prompt [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || die "Cancelled." 2
}

terminate_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  pid_alive "$pid" || return 0
  kill -TERM "-$pid" >/dev/null 2>&1 || kill -TERM "$pid" >/dev/null 2>&1 || true
  local i
  for i in {1..10}; do
    pid_alive "$pid" || return 0
    sleep 0.5
  done
  kill -KILL "-$pid" >/dev/null 2>&1 || kill -KILL "$pid" >/dev/null 2>&1 || true
}

cmd_stop() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force) FORCE=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown stop option: $1" 1 ;;
    esac
    shift
  done
  load_env
  apply_meta_network
  ensure_state_dir
  local pid vite_pid warning
  pid="$(read_pid_file || true)"
  if [[ -z "$pid" ]] || ! pid_alive "$pid"; then
    info "Not running"
    rm -f "$PID_FILE"
    mark_stopped
    return
  fi
  warning="$(active_attention_warning || true)"
  if [[ -n "$warning" ]]; then
    warn "$warning"
    confirm_or_exit "Stop while there is attention backlog?"
  fi
  vite_pid="$(json_value vite_pid 2>/dev/null || true)"
  terminate_pid "$vite_pid"
  terminate_pid "$pid"
  rm -f "$PID_FILE"
  mark_stopped
  info "Stopped"
}

cmd_restart() {
  cmd_stop --force
  cmd_start "$@"
}

format_uptime() {
  local started="$1"
  require_python
  "$PYTHON_BIN" - "$started" <<'PY'
import datetime as dt
import sys
try:
    started = dt.datetime.fromisoformat(sys.argv[1])
    now = dt.datetime.now(dt.UTC)
    seconds = int((now - started).total_seconds())
except Exception:
    print("unknown")
    raise SystemExit
hours, rem = divmod(max(seconds, 0), 3600)
minutes, seconds = divmod(rem, 60)
print(f"{hours}h{minutes:02d}m{seconds:02d}s")
PY
}

cmd_status() {
  load_env
  apply_meta_network
  local pid url started commit mode health adapter uptime
  pid="$(read_pid_file || true)"
  if [[ -z "$pid" ]] || ! pid_alive "$pid"; then
    info "status: stopped"
    if [[ -f "$META_FILE" ]]; then
      info "last url: $(json_value url 2>/dev/null || true)"
    fi
    return
  fi
  url="$(json_value url 2>/dev/null || api_base)"
  started="$(json_value started_at 2>/dev/null || true)"
  commit="$(json_value commit 2>/dev/null || true)"
  mode="$(json_value mode 2>/dev/null || true)"
  uptime="$(format_uptime "$started")"
  health="$(http_get "$(api_base)/api/health" 2>/dev/null || true)"
  require_python
  adapter="$("$PYTHON_BIN" - "$health" <<'PY' 2>/dev/null || true
import json, sys
try:
    print(json.loads(sys.argv[1]).get("active_adapter", "unknown"))
except Exception:
    print("unreachable")
PY
)"
  info "status: running"
  printf 'pid: %s\nurl: %s\nmode: %s\nuptime: %s\nadapter: %s\ncommit: %s\n' \
    "$pid" "$url" "${mode:-unknown}" "$uptime" "${adapter:-unknown}" "${commit:-unknown}"
}

cmd_logs() {
  local follow=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -f|--follow) follow=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown logs option: $1" 1 ;;
    esac
    shift
  done
  ensure_state_dir
  touch "$LOG_FILE"
  if [[ "$follow" -eq 1 ]]; then
    tail -f "$LOG_FILE"
  else
    tail -200 "$LOG_FILE"
  fi
}

cmd_open() {
  local url
  url="$(json_value url 2>/dev/null || true)"
  [[ -n "$url" ]] || die "No running instance metadata. Use start first." 2
  open_browser "$url"
}

doctor_line() {
  local label="$1"
  local value="$2"
  printf '%-32s %s\n' "$label" "$value"
}

cmd_doctor() {
  load_env
  local py py_status node_v port_status browser tool
  if select_python; then
    py="$("$PYTHON_BIN" --version 2>&1) ($PYTHON_BIN)"
    py_status="OK"
  else
    py="missing suitable Python 3.11+"
    py_status="NEEDS 3.11+"
    if [[ -n "${ORCH_PYTHON_BIN:-}" ]]; then
      py="invalid ORCH_PYTHON_BIN=${ORCH_PYTHON_BIN}"
    elif command_exists python3; then
      py="$py; python3 is $(python3 --version 2>&1)"
    fi
  fi
  node_v="$(node --version 2>/dev/null || printf 'missing')"
  local ensurepip_status
  if [[ "$py_status" == "OK" ]]; then
    ensurepip_status="$("$PYTHON_BIN" - <<'PY' 2>/dev/null || true
try:
    import ensurepip  # noqa: F401
except Exception:
    print("missing (install python3-venv)")
else:
    print("present")
PY
)"
  else
    ensurepip_status="missing"
  fi
  if port_in_use "$PORT"; then port_status="in use"; else port_status="free"; fi
  if [[ "$(uname -s)" == "Darwin" && $(command_exists open; echo $?) -eq 0 ]]; then
    browser="open"
  elif is_wsl && command_exists wslview; then
    browser="wslview"
  elif is_wsl && command_exists cmd.exe; then
    browser="cmd.exe"
  elif command_exists xdg-open; then
    browser="xdg-open"
  elif [[ -n "${BROWSER:-}" ]]; then
    browser="\$BROWSER"
  else
    browser="manual"
  fi
  doctor_line "repo" "$ROOT_DIR"
  doctor_line "state dir" "$STATE_DIR"
  doctor_line "python" "$py $py_status"
  doctor_line "python ensurepip" "${ensurepip_status:-missing}"
  doctor_line "node" "$node_v $(node_ok && printf OK || printf 'NEEDS 20.19+/22.12+')"
  doctor_line "git" "$(command -v git 2>/dev/null || printf missing)"
  doctor_line ".venv" "$([[ -x "$VENV_DIR/bin/python" ]] && printf present || printf missing)"
  doctor_line "node_modules" "$([[ -d "$FRONTEND_DIR/node_modules" ]] && printf present || printf missing)"
  doctor_line "frontend dist" "$([[ -f "$DIST_DIR/index.html" ]] && printf present || printf missing)"
  doctor_line "claude" "$(command -v claude 2>/dev/null || printf 'missing (mock adapter if ORCH_AGENT_MODE=auto)')"
  doctor_line "gh" "$(command -v gh 2>/dev/null || printf 'missing (remote skills unavailable)')"
  doctor_line "host:port" "$HOST:$PORT ($port_status)"
  doctor_line "permission mode" "${ORCH_DEFAULT_PERMISSION_MODE:-default}"
  if [[ "${ORCH_TOKEN:-dev-token}" == "dev-token" || "${ORCH_TOKEN:-}" == "__GENERATED_BY_SETUP__" ]]; then
    tool="unsafe/default"
  else
    tool="set"
  fi
  doctor_line "ORCH_TOKEN" "$tool"
  doctor_line "WSL" "$(is_wsl && printf yes || printf no)"
  doctor_line "browser opener" "$browser"
}

cmd_update() {
  if [[ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
    die "Working tree has local changes; commit/stash before update." 2
  fi
  git -C "$ROOT_DIR" pull --ff-only
  cmd_setup
  cmd_restart
}

confirm_purge() {
  [[ "$PURGE_DATA" -eq 1 ]] || return 1
  if [[ ! -t 0 ]]; then
    die "Refusing to purge data non-interactively." 2
  fi
  read -r -p "Delete .orch data/config and state dir? This cannot be undone. Type DELETE: " answer
  [[ "$answer" == "DELETE" ]] || die "Cancelled." 2
}

cmd_clean() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --purge-data) PURGE_DATA=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown clean option: $1" 1 ;;
    esac
    shift
  done
  rm -rf "$VENV_DIR" "$FRONTEND_DIR/node_modules" "$DIST_DIR"
  info "Removed .venv, frontend/node_modules, frontend/dist"
  if [[ "$PURGE_DATA" -eq 1 ]]; then
    confirm_purge
    rm -rf "$ROOT_DIR/.orch" "$STATE_DIR"
    info "Purged .orch and state dir"
  fi
}

main() {
  local command="${1:-}"
  [[ -n "$command" ]] || { usage; exit 1; }
  shift || true
  case "$command" in
    setup) cmd_setup "$@" ;;
    start) cmd_start "$@" ;;
    stop) cmd_stop "$@" ;;
    restart) cmd_restart "$@" ;;
    status) cmd_status "$@" ;;
    logs) cmd_logs "$@" ;;
    open) cmd_open "$@" ;;
    doctor) cmd_doctor "$@" ;;
    update) cmd_update "$@" ;;
    clean|uninstall) cmd_clean "$@" ;;
    -h|--help|help) usage ;;
    *) die "Unknown command: $command" 1 ;;
  esac
}

main "$@"

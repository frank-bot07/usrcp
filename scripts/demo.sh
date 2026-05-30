#!/usr/bin/env bash
# scripts/demo.sh — runnable end-to-end demo script for USRCP.
#
# This is the executable equivalent of tasks/32-demo-script.md. Each
# scenario is a function you can invoke individually so you can stop
# between scenarios for narration during a recording. Run with no args
# to see usage.
#
# Every scenario runs against an isolated $DEMO_HOME (default
# /tmp/usrcp-demo-<random>) so prior demos cannot leak state into the
# next recording.

set -euo pipefail

# Directory this script lives in (for locating sibling scripts + packages).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Config ────────────────────────────────────────────────────────────────
# Override any of these in the environment before invoking the script.
: "${DEMO_PASSPHRASE:=demo-passphrase}"
: "${DEMO_PASSPHRASE_V2:=demo-passphrase-v2}"
: "${DEMO_HOME:=}"            # set by scenario_setup if empty
: "${DEMO_HOME_B:=}"          # device B, set by scenario_pair_join
: "${CLOUD_PG_PORT:=15432}"
: "${CLOUD_PORT:=19090}"
: "${CLOUD_PG_PASSWORD:=demo}"
: "${CLOUD_CONTAINER:=usrcp-demo-pg}"

# ─── Colors & banners ──────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_HEAD=$'\033[1;36m'; C_OK=$'\033[1;32m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_OFF=$'\033[0m'
else
  C_HEAD=''; C_OK=''; C_WARN=''; C_ERR=''; C_OFF=''
fi

banner() { printf "\n${C_HEAD}━━━ %s ━━━${C_OFF}\n" "$*"; }
ok()     { printf "${C_OK}✓${C_OFF} %s\n" "$*"; }
warn()   { printf "${C_WARN}!${C_OFF} %s\n" "$*"; }
fail()   { printf "${C_ERR}✗${C_OFF} %s\n" "$*" >&2; exit 1; }

# ─── Prereq checks ─────────────────────────────────────────────────────────
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

scenario_check() {
  banner "Prereqs"
  require_cmd usrcp
  require_cmd node
  require_cmd mktemp
  ok "usrcp on PATH: $(command -v usrcp)"
  ok "node version:  $(node --version)"
  ok "usrcp --help works:"
  usrcp --help 2>&1 | head -3 | sed 's/^/    /'
}

scenario_check_cloud() {
  require_cmd docker
  ok "docker on PATH (needed for the cloud scenario only)"
}

# ─── DEMO_HOME helpers ─────────────────────────────────────────────────────
ensure_demo_home() {
  if [[ -z "$DEMO_HOME" ]]; then
    DEMO_HOME=$(mktemp -d /tmp/usrcp-demo-XXXXXX)
    export DEMO_HOME
    ok "Allocated DEMO_HOME=$DEMO_HOME"
  else
    ok "Using DEMO_HOME=$DEMO_HOME"
  fi
}

ensure_demo_home_b() {
  if [[ -z "$DEMO_HOME_B" ]]; then
    DEMO_HOME_B=$(mktemp -d /tmp/usrcp-demo-B-XXXXXX)
    export DEMO_HOME_B
    ok "Allocated DEMO_HOME_B=$DEMO_HOME_B"
  fi
}

# Run usrcp with the right HOME + passphrase env. First arg picks the
# device home: "A" (default) or "B".
run_usrcp() {
  local device="A"
  if [[ "${1:-}" == "A" || "${1:-}" == "B" ]]; then
    device="$1"; shift
  fi
  local home_var passphrase
  if [[ "$device" == "B" ]]; then
    home_var="$DEMO_HOME_B"
    passphrase="${DEMO_PASSPHRASE_V2:-$DEMO_PASSPHRASE}"
  else
    home_var="$DEMO_HOME"
    passphrase="$DEMO_PASSPHRASE"
  fi
  HOME="$home_var" USRCP_PASSPHRASE="$passphrase" usrcp "$@"
}

# ─── Scenario 1: First-run setup ───────────────────────────────────────────
scenario_setup() {
  banner "Scenario 1 — Fresh init in isolated HOME (~60s)"
  ensure_demo_home
  HOME="$DEMO_HOME" usrcp init --passphrase "$DEMO_PASSPHRASE"
  echo
  ok "Initialized. On-disk layout (every key file should be 0o600):"
  ls -la "$DEMO_HOME/.usrcp/users/default/keys/"
  echo
  ok "Status snapshot:"
  run_usrcp status
}

# ─── Scenario 2: Master-key rotation ───────────────────────────────────────
scenario_rotate() {
  banner "Scenario 2 — Master-key rotation (~45s)"
  [[ -n "$DEMO_HOME" ]] || fail "DEMO_HOME unset — run scenario_setup first or export DEMO_HOME."

  local jsonl="/tmp/demo-rotate-$$.jsonl"
  cat > "$jsonl" <<EOF
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"demo","version":"1.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"usrcp_rotate_key","arguments":{"new_passphrase":"$DEMO_PASSPHRASE_V2"}}}
EOF
  HOME="$DEMO_HOME" USRCP_PASSPHRASE="$DEMO_PASSPHRASE" usrcp serve --stdio < "$jsonl"
  rm -f "$jsonl"
  echo
  ok "Re-opening with the NEW passphrase — identity and timeline survive:"
  HOME="$DEMO_HOME" USRCP_PASSPHRASE="$DEMO_PASSPHRASE_V2" usrcp status
  echo
  ok "Auto-snapshot list (rotation triggered one):"
  HOME="$DEMO_HOME" USRCP_PASSPHRASE="$DEMO_PASSPHRASE_V2" usrcp snapshot --list || warn "snapshot --list returned non-zero (older builds)"
}

# ─── Scenario 3 prep: cloud up/down ────────────────────────────────────────
scenario_cloud_up() {
  banner "Scenario 3 prep — Postgres + usrcp-cloud"
  scenario_check_cloud
  if docker ps --format '{{.Names}}' | grep -q "^$CLOUD_CONTAINER\$"; then
    warn "Container '$CLOUD_CONTAINER' already running — reusing it."
  else
    ok "Starting Postgres ($CLOUD_CONTAINER on host port $CLOUD_PG_PORT)…"
    docker run -d --name "$CLOUD_CONTAINER" \
      -e "POSTGRES_PASSWORD=$CLOUD_PG_PASSWORD" \
      -e POSTGRES_DB=usrcp \
      -p "$CLOUD_PG_PORT:5432" \
      postgres:16-alpine >/dev/null
    # Wait for Postgres to accept connections.
    local i
    for i in $(seq 1 30); do
      if docker exec "$CLOUD_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
        ok "Postgres ready."
        break
      fi
      sleep 1
    done
  fi

  ok "Building + starting usrcp-cloud on http://127.0.0.1:$CLOUD_PORT …"
  (cd packages/usrcp-cloud && npm install --silent && npm run build --silent)
  DATABASE_URL="postgres://postgres:$CLOUD_PG_PASSWORD@127.0.0.1:$CLOUD_PG_PORT/usrcp" \
    PORT="$CLOUD_PORT" \
    node packages/usrcp-cloud/dist/index.js &
  echo $! > /tmp/usrcp-demo-cloud.pid
  sleep 2
  ok "usrcp-cloud PID $(cat /tmp/usrcp-demo-cloud.pid)"
}

scenario_cloud_down() {
  banner "Scenario 3 teardown — stop cloud + Postgres"
  if [[ -f /tmp/usrcp-demo-cloud.pid ]]; then
    kill "$(cat /tmp/usrcp-demo-cloud.pid)" 2>/dev/null || true
    rm -f /tmp/usrcp-demo-cloud.pid
    ok "Killed usrcp-cloud."
  fi
  if docker ps --format '{{.Names}}' | grep -q "^$CLOUD_CONTAINER\$"; then
    docker rm -f "$CLOUD_CONTAINER" >/dev/null
    ok "Removed container $CLOUD_CONTAINER."
  fi
}

# ─── Scenario 3: Multi-device pairing ──────────────────────────────────────
scenario_pair_init() {
  banner "Scenario 3 — Device A: pair init"
  [[ -n "$DEMO_HOME" ]] || fail "DEMO_HOME unset — run scenario_setup first."
  HOME="$DEMO_HOME" USRCP_PASSPHRASE="$DEMO_PASSPHRASE_V2" usrcp config set cloud_endpoint "http://127.0.0.1:$CLOUD_PORT"
  HOME="$DEMO_HOME" USRCP_PASSPHRASE="$DEMO_PASSPHRASE_V2" usrcp pair init
  warn "Copy the pairing string above, then run:"
  echo "    $0 pair-join <pairing-string>"
}

scenario_pair_join() {
  banner "Scenario 3 — Device B: pair join"
  local pairing_string="${1:-}"
  [[ -n "$pairing_string" ]] || fail "Usage: $0 pair-join <pairing-string>"
  ensure_demo_home_b
  HOME="$DEMO_HOME_B" usrcp pair join "$pairing_string" \
    --passphrase "$DEMO_PASSPHRASE_V2" \
    --endpoint "http://127.0.0.1:$CLOUD_PORT"
  echo
  ok "Device B status (User ID should match Device A's):"
  HOME="$DEMO_HOME_B" USRCP_PASSPHRASE="$DEMO_PASSPHRASE_V2" usrcp status | grep -E "User ID|user_id" || true
}

# ─── Scenario 4: Claude-code adapter ───────────────────────────────────────
scenario_adapter() {
  banner "Scenario 4 — claude-code adapter (interactive)"
  [[ -n "$DEMO_HOME" ]] || fail "DEMO_HOME unset — run scenario_setup first."
  warn "The wizard is interactive. Pick:"
  echo "    1. 'Use existing default ledger'"
  echo "    2. 'claude-code'"
  echo "    3. Allowlist a project under ~/.claude/projects/"
  HOME="$DEMO_HOME" USRCP_PASSPHRASE="$DEMO_PASSPHRASE_V2" usrcp setup
}

# ─── Cross-editor proof ────────────────────────────────────────────────────
# The headless version of the pitch's central artifact: two MCP sessions
# (= two editors) sharing one ledger, plus a raw-DB ciphertext scan. Runs
# in its own isolated HOME — independent of DEMO_HOME — so it's safe to run
# standalone before recording the on-camera two-editor demo
# (docs/demos/cross-editor.md).
scenario_cross_client() {
  banner "Cross-editor proof (headless)"
  local entry="$SCRIPT_DIR/../packages/usrcp-local/dist/index.js"
  if [[ ! -f "$entry" ]]; then
    warn "Building usrcp-local first…"
    (cd "$SCRIPT_DIR/../packages/usrcp-local" && npm run build >/dev/null) || fail "build failed"
  fi
  node "$SCRIPT_DIR/cross-client-proof.mjs"
}

# ─── Cleanup ───────────────────────────────────────────────────────────────
scenario_cleanup() {
  banner "Cleanup"
  scenario_cloud_down
  if [[ -n "$DEMO_HOME" && "$DEMO_HOME" == /tmp/usrcp-demo-* ]]; then
    rm -rf "$DEMO_HOME"
    ok "Removed $DEMO_HOME"
  elif [[ -n "$DEMO_HOME" ]]; then
    warn "DEMO_HOME=$DEMO_HOME is outside /tmp/usrcp-demo-*; refusing to remove. rm it yourself if you want."
  fi
  if [[ -n "$DEMO_HOME_B" && "$DEMO_HOME_B" == /tmp/usrcp-demo-B-* ]]; then
    rm -rf "$DEMO_HOME_B"
    ok "Removed $DEMO_HOME_B"
  fi
}

# ─── Usage ─────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $0 <scenario> [args]

Scenarios:
  check                Verify usrcp + node prereqs
  setup                Scenario 1: fresh init in DEMO_HOME (allocates one if unset)
  rotate               Scenario 2: master-key rotation
  cloud-up             Scenario 3 prep: bring up Postgres + usrcp-cloud
  pair-init            Scenario 3 device A: emit pairing string + QR
  pair-join PAIRING    Scenario 3 device B: join with the string from device A
  cloud-down           Scenario 3 teardown: stop cloud + Postgres
  adapter              Scenario 4: claude-code adapter (interactive wizard)
  cross-client         Headless cross-editor proof: 2 MCP sessions share one
                       ledger + raw-DB ciphertext scan (docs/demos/cross-editor.md)
  cleanup              Stop docker, remove DEMO_HOME / DEMO_HOME_B
  all-local            Run scenarios 1+2+4 in order (no cloud, no pairing)

Environment overrides:
  DEMO_PASSPHRASE      Initial passphrase (default: demo-passphrase)
  DEMO_PASSPHRASE_V2   Rotated passphrase (default: demo-passphrase-v2)
  DEMO_HOME            Override the device-A HOME (auto-allocated in /tmp otherwise)
  DEMO_HOME_B          Override the device-B HOME
  CLOUD_PORT           usrcp-cloud port (default: 19090)
  CLOUD_PG_PORT        Postgres host port (default: 15432)
EOF
}

# ─── Main dispatch ─────────────────────────────────────────────────────────
case "${1:-}" in
  check)        scenario_check ;;
  setup)        scenario_check && scenario_setup ;;
  rotate)       scenario_rotate ;;
  cloud-up)     scenario_cloud_up ;;
  cloud-down)   scenario_cloud_down ;;
  pair-init)    scenario_pair_init ;;
  pair-join)    shift; scenario_pair_join "$@" ;;
  adapter)      scenario_adapter ;;
  cross-client) scenario_cross_client ;;
  cleanup)      scenario_cleanup ;;
  all-local)    scenario_check && scenario_setup && scenario_rotate && scenario_adapter ;;
  ""|-h|--help|help) usage ;;
  *)            usage; exit 1 ;;
esac

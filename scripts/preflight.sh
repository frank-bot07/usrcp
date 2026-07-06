#!/usr/bin/env bash
#
# preflight.sh — pre-recording checks for the multi-app fresh-machine demo.
# See docs/demos/multi-app-fresh-machine.md. Run this on the demo machine
# AFTER `usrcp init` + registration, BEFORE you hit record.
#
# Non-destructive: it only READS your ~/.usrcp and app configs and (optionally)
# runs the headless proof against an isolated tmp HOME. It never writes to your
# real ledger and never needs your passphrase.
#
# Usage:
#   bash scripts/preflight.sh                 # default user slug "default"
#   USRCP_USER=frank bash scripts/preflight.sh
#   CLIENTS="claude,cursor" CANARY="Harbor" bash scripts/preflight.sh
#
# Exit code: 0 if no hard FAILs, 1 otherwise. WARNs never fail the run.

set -u

# ---- config (override via env) ---------------------------------------------
USRCP_USER="${USRCP_USER:-default}"
CLIENTS="${CLIENTS:-claude,cursor}"     # GUI/IDE clients you registered
CANARY="${CANARY:-}"                    # a persona plaintext string that must
                                        # NOT appear unencrypted (e.g. Harbor)
WANT_VERSION="${WANT_VERSION:-0.2.2}"   # expected usrcp version substring

USRCP_HOME="${HOME}/.usrcp"
LEDGER="${USRCP_HOME}/users/${USRCP_USER}/ledger.db"

# ---- output helpers --------------------------------------------------------
if [ -t 1 ]; then G="\033[32m"; R="\033[31m"; Y="\033[33m"; B="\033[1m"; Z="\033[0m"
else G=""; R=""; Y=""; B=""; Z=""; fi
fails=0; warns=0
pass() { printf "  ${G}PASS${Z}  %s\n" "$1"; }
fail() { printf "  ${R}FAIL${Z}  %s\n" "$1"; fails=$((fails+1)); }
warn() { printf "  ${Y}WARN${Z}  %s\n" "$1"; warns=$((warns+1)); }
sec() { printf "\n${B}%s${Z}\n" "$1"; }

repo_root() {
  # directory that contains this script's parent (…/scripts/preflight.sh → repo)
  local src="${BASH_SOURCE[0]}"
  cd "$(dirname "$src")/.." 2>/dev/null && pwd
}

printf "${B}USRCP demo pre-flight${Z}  (user=%s  clients=%s)\n" "$USRCP_USER" "$CLIENTS"

# ---- 1. binary + version ---------------------------------------------------
sec "1. usrcp binary"
if command -v usrcp >/dev/null 2>&1; then
  ver="$(usrcp --help 2>&1 | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  if [ -z "$ver" ]; then
    warn "usrcp found but couldn't parse a version from --help"
  elif printf '%s' "$ver" | grep -q "$WANT_VERSION"; then
    pass "usrcp ${ver} (matches ${WANT_VERSION})"
  else
    warn "usrcp ${ver} — expected ${WANT_VERSION} (upgrade: brew upgrade usrcp)"
  fi
else
  fail "usrcp not on PATH — run: brew install frank-bot07/usrcp/usrcp"
fi

# ---- 2. tools the demo shells out to ---------------------------------------
sec "2. supporting tools"
command -v sqlite3 >/dev/null 2>&1 \
  && pass "sqlite3 present (needed for the ciphertext beat)" \
  || fail "sqlite3 missing — the Beat 5 raw-DB dump won't run"
command -v node >/dev/null 2>&1 \
  && pass "node present ($(node --version 2>/dev/null))" \
  || warn "node missing — cross-client-proof.mjs can't run"

# ---- 3. passphrase in the keychain, not in configs -------------------------
sec "3. passphrase / keychain"
kc="$(usrcp keychain status 2>&1)"
if printf '%s' "$kc" | grep -qiE 'stored|present|found|entry'; then
  pass "keychain has an entry — GUI apps unlock without a plaintext passphrase"
elif printf '%s' "$kc" | grep -qiE 'no backend|unavailable'; then
  warn "no keychain backend — you'll need USRCP_PASSPHRASE in the env for GUI apps"
else
  warn "keychain status unclear; verify GUI apps can unlock. Raw: $(printf '%s' "$kc" | head -1)"
fi

# ---- 4. ledger exists (init was run) ---------------------------------------
sec "4. ledger"
if [ -f "$LEDGER" ]; then
  pass "ledger present: ${LEDGER}"
else
  # fall back to any user slug so a wrong USRCP_USER is obvious
  other="$(ls "${USRCP_HOME}"/users/*/ledger.db 2>/dev/null | head -1)"
  if [ -n "$other" ]; then
    fail "no ledger for user '${USRCP_USER}', but found: ${other} — set USRCP_USER"
  else
    fail "no ledger under ${USRCP_HOME}/users/*/ — run: usrcp init --client=${CLIENTS}"
  fi
fi

# ---- 5. MCP client configs registered --------------------------------------
sec "5. MCP client registration"
old_ifs="$IFS"; IFS=','
for c in $CLIENTS; do
  case "$c" in
    claude)   cfg="${HOME}/Library/Application Support/Claude/claude_desktop_config.json" ;;
    cursor)   cfg="${HOME}/.cursor/mcp.json" ;;
    cline)    cfg="${HOME}/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json" ;;
    continue) cfg="${HOME}/.continue/config.json" ;;
    *)        cfg="" ;;
  esac
  if [ -z "$cfg" ]; then
    warn "unknown client '${c}' — skipping"
  elif [ -f "$cfg" ] && grep -q "usrcp" "$cfg" 2>/dev/null; then
    pass "${c}: usrcp entry present"
  elif [ -f "$cfg" ]; then
    fail "${c}: config exists but no usrcp entry — re-run usrcp init --client=${c}"
  else
    fail "${c}: no config at ${cfg} — is the app installed & registered?"
  fi
done
IFS="$old_ifs"

# ---- 6. ciphertext at rest -------------------------------------------------
sec "6. ciphertext at rest"
if [ -f "$LEDGER" ] && command -v sqlite3 >/dev/null 2>&1; then
  dump="$(sqlite3 "$LEDGER" '.dump' 2>/dev/null)"
  # Count 'enc:' markers across the whole ledger, not one table: core_identity
  # can be empty/legacy on a fresh or old install, so it's an unreliable probe.
  enc_n="$(printf '%s' "$dump" | grep -c 'enc:')"
  if [ "${enc_n:-0}" -gt 0 ]; then
    pass "${enc_n} encrypted field(s) at rest ('enc:' markers)"
  else
    warn "no 'enc:' content yet — a freshly-inited ledger is empty until Beat 2 seeds it; re-run after seeding"
  fi
  if [ -n "$CANARY" ]; then
    if printf '%s' "$dump" | grep -q "$CANARY"; then
      fail "canary '${CANARY}' appears in cleartext in the raw DB — investigate before recording"
    else
      pass "canary '${CANARY}' absent from raw DB dump (encrypted or not yet written)"
    fi
  else
    warn "set CANARY=<a persona word> to assert it never appears in cleartext"
  fi
else
  warn "skipping ciphertext check (need both the ledger and sqlite3)"
fi

# ---- 7. headless end-to-end proof (optional, definitive) -------------------
sec "7. headless cross-tool proof (optional)"
root="$(repo_root)"
proof="${root}/scripts/cross-client-proof.mjs"
if [ -f "$proof" ] && command -v node >/dev/null 2>&1; then
  printf "  running %s (isolated HOME)…\n" "cross-client-proof.mjs"
  if node "$proof" >/tmp/usrcp-proof.$$ 2>&1; then
    pass "cross-client-proof.mjs exited 0 — write→read→ciphertext holds end-to-end"
    rm -f /tmp/usrcp-proof.$$
  else
    fail "cross-client-proof.mjs FAILED — see /tmp/usrcp-proof.$$ (last lines below)"
    tail -8 /tmp/usrcp-proof.$$ | sed 's/^/      /'
  fi
else
  warn "not run — needs the repo (with usrcp-local built) + node. Skip is OK if binary checks pass."
fi

# ---- summary ---------------------------------------------------------------
sec "summary"
if [ "$fails" -eq 0 ]; then
  printf "  ${G}%s${Z}  (%d warning(s))\n" "READY — no hard failures." "$warns"
  printf "  Do one silent dry-run of all 6 beats, then record.\n"
  exit 0
else
  printf "  ${R}%d failure(s), %d warning(s) — fix before recording.${Z}\n" "$fails" "$warns"
  exit 1
fi

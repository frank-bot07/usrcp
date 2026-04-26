#!/usr/bin/env bash
# USRCP installer
#
# Usage (one-liner):
#   curl -fsSL https://raw.githubusercontent.com/frank-bot07/usrcp/main/scripts/install.sh | bash
#
# Note: get.usrcp.dev does not exist yet. Use the GitHub raw URL above until
# that domain is wired up to a static hosting endpoint.
#
# What this does:
#   1. Checks Node 20+ and git are available.
#   2. Clones (or updates) the repo to ~/.usrcp-source/.
#   3. npm install + npm run build + npm link in packages/usrcp-local/.
#   4. Verifies 'usrcp' is on PATH; prints the export line if not.
#   5. Prints next-step: run 'usrcp setup'.

set -euo pipefail

BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RESET="\033[0m"

echo ""
echo -e "${BOLD}USRCP installer${RESET}"
echo "───────────────"
echo ""

# --- Prereq checks ---

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is required. Install it first:"
  echo "  macOS:  brew install git"
  echo "  Ubuntu: sudo apt install git"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js 20+ is required. Install it first:"
  echo "  https://nodejs.org/"
  echo "  Or via nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/HEAD/install.sh | bash"
  exit 1
fi

NODE_MAJOR=$(node -p "parseInt(process.versions.node.split('.')[0], 10)")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node 20+ is required (found $NODE_MAJOR.x)."
  echo "  https://nodejs.org/"
  exit 1
fi

echo -e "${GREEN}✓${RESET} Node ${NODE_MAJOR}.x found"
echo -e "${GREEN}✓${RESET} git found"
echo ""

# --- Clone or update ---

USRCP_SRC="${USRCP_SRC:-$HOME/.usrcp-source}"

if [ -d "$USRCP_SRC/.git" ]; then
  echo "Updating existing source at $USRCP_SRC..."
  git -C "$USRCP_SRC" pull --ff-only
else
  echo "Cloning USRCP to $USRCP_SRC..."
  git clone https://github.com/frank-bot07/usrcp.git "$USRCP_SRC"
fi

echo ""

# --- Build + link ---

cd "$USRCP_SRC/packages/usrcp-local"
echo "Installing dependencies..."
npm install --silent
echo "Building..."
npm run build
echo "Linking 'usrcp' binary globally..."
npm link

echo ""

# --- PATH check ---

if ! command -v usrcp >/dev/null 2>&1; then
  echo -e "${YELLOW}Warning:${RESET} 'usrcp' is not on your PATH yet."
  echo ""
  NPM_BIN=$(npm prefix -g)/bin
  echo "  Add this line to your shell profile (~/.zshrc or ~/.bashrc):"
  echo ""
  echo "    export PATH=\"$NPM_BIN:\$PATH\""
  echo ""
  echo "  Then restart your terminal or run:"
  echo "    source ~/.zshrc   # (or ~/.bashrc)"
  echo ""
else
  USRCP_PATH=$(command -v usrcp)
  echo -e "${GREEN}✓${RESET} 'usrcp' is on PATH: $USRCP_PATH"
  echo ""
fi

# --- Done ---

echo -e "${GREEN}✓ USRCP installed.${RESET}"
echo ""
echo "Next step:"
echo "  usrcp setup"
echo ""
echo "This will configure your encrypted ledger and connect your first"
echo "adapter (Discord, Telegram, etc.) in one guided flow."
echo ""

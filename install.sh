#!/bin/sh
# Limitless Agents Starter — one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/limitless-labs-group/agents-starter/main/install.sh | sh
#
# What it does: checks prerequisites, clones the repo (if you're not already in
# it), installs dependencies, and scaffolds your config so you're ready to fill
# in credentials. That's all.
#
# What it does NOT do: it never asks for, reads, writes, or transmits a private
# key or any secret, and it never trades or moves funds. The only secret-bearing
# step — putting your key in .env — stays a deliberate action you take yourself
# afterward. Prefer to read before you run? Download and inspect:
#   curl -fsSL https://raw.githubusercontent.com/limitless-labs-group/agents-starter/main/install.sh -o install.sh
#   less install.sh && sh install.sh
set -eu

REPO_URL="https://github.com/limitless-labs-group/agents-starter.git"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
say() { printf "%b\n" "$1"; }

say "${BOLD}Limitless Agents Starter — installer${NC}\n"

# 1. Prerequisites ----------------------------------------------------------
need() {
  command -v "$1" >/dev/null 2>&1 || {
    say "${RED}✗ missing: $1${NC} — install it and re-run."
    exit 1
  }
}
need git
need node
need npm

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 20 ]; then
  say "${RED}✗ Node $NODE_MAJOR is too old${NC} — need 20+ (LTS recommended)."
  exit 1
fi
say "${GREEN}✓${NC} prerequisites: git, node v$(node -p 'process.versions.node'), npm"

# 2. Get the code -----------------------------------------------------------
# Use the current checkout if we're already inside it; else an ./agents-starter
# dir if present; else clone fresh. Never clobber an existing directory.
if [ -f package.json ] && grep -q '"agents-starter"' package.json 2>/dev/null; then
  DIR=$(pwd)
  say "${GREEN}✓${NC} using current checkout: $DIR"
elif [ -d agents-starter ]; then
  DIR=$(pwd)/agents-starter
  say "${YELLOW}!${NC} ./agents-starter already exists — using it (not re-cloning)"
else
  say "Cloning agents-starter…"
  git clone --depth 1 "$REPO_URL" >/dev/null 2>&1
  DIR=$(pwd)/agents-starter
  say "${GREEN}✓${NC} cloned to $DIR"
fi
cd "$DIR"

# 3. Install ---------------------------------------------------------------
say "Installing dependencies (npm install)…"
npm install --no-fund --no-audit >/dev/null 2>&1
say "${GREEN}✓${NC} dependencies installed"

# 4. Scaffold --------------------------------------------------------------
# init creates .env from .env.example (mode 600) and prints exactly which
# credentials to set and how to get each. It never reads or writes secrets.
say "\n${BOLD}Scaffolding config…${NC}"
npm run --silent init || true

# 5. Footer ----------------------------------------------------------------
say "\n${BOLD}Installed.${NC} You're in: $DIR"
say "Next: fill .env in your editor (see the credential list above), then run:"
say "  ${BOLD}npm run doctor${NC}              # verifies key, token, wallet mode, balances"
say "  ${BOLD}npm run certainty-closer${NC}    # simplest strategy, dry-run by default"
say "Cross-venue market making (Limitless ↔ Polymarket): npm run cross-market-mm:init"

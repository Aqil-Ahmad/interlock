#!/usr/bin/env bash
# Developer setup. Run once after cloning: ./scripts/setup.sh
# Linux and macOS only.

set -euo pipefail

fail=0

info()  { printf '  \033[0;34m•\033[0m %s\n' "$1"; }
ok()    { printf '  \033[0;32m✓\033[0m %s\n' "$1"; }
warn()  { printf '  \033[0;33m!\033[0m %s\n' "$1"; }
err()   { printf '  \033[0;31m✗\033[0m %s\n' "$1"; fail=1; }

echo "Interlock — developer setup"
echo
echo "Checking prerequisites:"

case "$(uname -s)" in
  Linux|Darwin) ok "platform $(uname -s)" ;;
  *) err "unsupported platform $(uname -s) — v1 supports Linux and macOS only" ;;
esac

if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$node_major" -ge 22 ]; then ok "node $(node -v)"; else err "node $(node -v) — need >= 22"; fi
else
  err "node not found — install Node 22+ (see .node-version)"
fi

if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm $(pnpm -v)"
else
  err "pnpm not found — install with: npm install -g pnpm@11"
fi

if command -v git >/dev/null 2>&1; then
  ok "git $(git --version | awk '{print $3}')"
else
  err "git not found"
fi

# Docker is only needed for the sandboxed analyzers.
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    ok "docker running"
  else
    warn "docker installed but not running — the semantic analyzers need it"
  fi
else
  warn "docker not found — needed for sandboxed build/typecheck/test"
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "Fix the errors above and re-run."
  exit 1
fi

echo
info "Installing dependencies…"
pnpm install

echo
info "Verifying the workspace…"
pnpm verify

echo
ok "Ready."

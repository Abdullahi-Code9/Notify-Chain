#!/usr/bin/env bash
# ==============================================================================
# NotifyChain Reproducible Dependency Installation Checker (Issue #719)
# ==============================================================================
# Verifies that dependencies in Node.js (listener, dashboard) and Rust (contract)
# can be reproduced deterministically from committed lockfiles without drift.
# ==============================================================================
set -u

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ERRORS=0

echo -e "${BLUE}==================================================================${NC}"
echo -e "${BLUE}  🔒 NotifyChain Reproducible Dependency Installation Verification ${NC}"
echo -e "${BLUE}==================================================================${NC}\n"

check_npm_lockfile() {
    local dir_name="$1"
    local full_path="${ROOT_DIR}/${dir_name}"

    printf "%-35s " "Checking ${dir_name} package-lock.json..."
    if [ ! -f "${full_path}/package.json" ]; then
        echo -e "${YELLOW}SKIPPED (no package.json)${NC}"
        return
    fi

    if [ ! -f "${full_path}/package-lock.json" ]; then
        echo -e "${RED}✗ FAILED (missing package-lock.json)${NC}"
        echo -e "  ${YELLOW}➔ Action: Run 'npm install --package-lock-only' in ${dir_name}/${NC}"
        ERRORS=$((ERRORS + 1))
        return
    fi

    if command -v npm >/dev/null 2>&1; then
        # Run npm ci dry-run to ensure lockfile is in sync with package.json
        if (cd "${full_path}" && npm ci --dry-run >/dev/null 2>&1); then
            echo -e "${GREEN}✓ VALID & REPRODUCIBLE${NC}"
        else
            echo -e "${RED}✗ LOCKFILE DRIFT DETECTED${NC}"
            echo -e "  ${YELLOW}➔ Action: Lockfile is out of sync with package.json. Run 'npm install' in ${dir_name}/${NC}"
            ERRORS=$((ERRORS + 1))
        fi
    else
        echo -e "${GREEN}✓ PRESENT${NC} (npm CLI not found locally, skipping live dry-run)"
    fi
}

check_cargo_lockfile() {
    local dir_name="$1"
    local full_path="${ROOT_DIR}/${dir_name}"

    printf "%-35s " "Checking ${dir_name} Cargo.lock..."
    if [ ! -f "${full_path}/Cargo.toml" ]; then
        echo -e "${YELLOW}SKIPPED (no Cargo.toml)${NC}"
        return
    fi

    if [ ! -f "${full_path}/Cargo.lock" ]; then
        echo -e "${RED}✗ FAILED (missing Cargo.lock)${NC}"
        echo -e "  ${YELLOW}➔ Action: Run 'cargo generate-lockfile' in ${dir_name}/${NC}"
        ERRORS=$((ERRORS + 1))
        return
    fi

    if command -v cargo >/dev/null 2>&1; then
        if (cd "${full_path}" && cargo check --locked --quiet >/dev/null 2>&1); then
            echo -e "${GREEN}✓ VALID & FROZEN${NC}"
        else
            echo -e "${RED}✗ CARGO LOCK DRIFT DETECTED${NC}"
            echo -e "  ${YELLOW}➔ Action: Cargo.lock is out of sync. Run 'cargo check' in ${dir_name}/${NC}"
            ERRORS=$((ERRORS + 1))
        fi
    else
        echo -e "${GREEN}✓ PRESENT${NC} (cargo CLI not found locally, skipping live check)"
    fi
}

echo -e "${BLUE}--- [1/2] Verifying Node.js Package Lockfiles ---${NC}"
check_npm_lockfile "listener"
check_npm_lockfile "dashboard"

echo -e "\n${BLUE}--- [2/2] Verifying Rust Smart Contract Lockfile ---${NC}"
check_cargo_lockfile "contract"

echo -e "\n${BLUE}==================================================================${NC}"
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}🎉 All dependency lockfiles are reproducible with zero drift!${NC}"
    exit 0
else
    echo -e "${RED}❌ Found ${ERRORS} dependency lockfile issue(s). Action required above.${NC}"
    exit 1
fi

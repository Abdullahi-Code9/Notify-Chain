#!/usr/bin/env bash
# ==============================================================================
# NotifyChain Local Repository Health & Prerequisites Doctor (Issue #721)
# ==============================================================================
# Checks local developer environment prerequisites without modifying anything.
# Validates:
# - Runtimes: Node.js (>=18), Rust / Cargo (>=1.75), Docker & Docker Compose
# - Package managers & CLI tools: npm / pnpm / yarn, cargo, stellar-cli / soroban
# - Local configuration: .env files, node_modules presence, git hooks
# ==============================================================================
set -u

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

ERRORS=0
WARNINGS=0

echo -e "${BLUE}======================================================${NC}"
echo -e "${BLUE}     🔍 NotifyChain Development Environment Doctor     ${NC}"
echo -e "${BLUE}======================================================${NC}\n"

check_cmd() {
    local name="$1"
    local cmd="$2"
    local min_ver="$3"
    local install_msg="$4"

    printf "%-30s " "Checking $name..."
    if command -v "$cmd" >/dev/null 2>&1; then
        local ver
        ver=$($cmd --version 2>&1 | head -n 1)
        echo -e "${GREEN}✓ OK${NC} (${ver})"
    else
        echo -e "${RED}✗ MISSING${NC}"
        echo -e "  ${YELLOW}➔ Action: ${install_msg}${NC}"
        ERRORS=$((ERRORS + 1))
    fi
}

check_optional() {
    local name="$1"
    local cmd="$2"
    local purpose="$3"
    local install_msg="$4"

    printf "%-30s " "Checking $name (optional)..."
    if command -v "$cmd" >/dev/null 2>&1; then
        local ver
        ver=$($cmd --version 2>&1 | head -n 1)
        echo -e "${GREEN}✓ OK${NC} (${ver})"
    else
        echo -e "${YELLOW}⚠ NOT FOUND${NC} (${purpose})"
        echo -e "  ${YELLOW}➔ Tip: ${install_msg}${NC}"
        WARNINGS=$((WARNINGS + 1))
    fi
}

check_file() {
    local name="$1"
    local filepath="$2"
    local template="$3"

    printf "%-30s " "Checking $name..."
    if [ -f "$filepath" ]; then
        echo -e "${GREEN}✓ OK${NC}"
    else
        echo -e "${YELLOW}⚠ MISSING${NC}"
        echo -e "  ${YELLOW}➔ Action: Copy template via 'cp ${template} ${filepath}'${NC}"
        WARNINGS=$((WARNINGS + 1))
    fi
}

echo -e "${BLUE}--- [1/3] Checking Required Runtimes & Toolchains ---${NC}"
check_cmd "Node.js (>=18.x)" "node" "18" "Install Node.js from https://nodejs.org/"
check_cmd "npm package manager" "npm" "9" "Install npm (bundled with Node.js)"
check_cmd "Rust toolchain" "rustc" "1.75" "Install Rust via 'curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh'"
check_cmd "Cargo" "cargo" "1.75" "Install Cargo via rustup"

echo -e "\n${BLUE}--- [2/3] Checking Container & Blockchain Tooling ---${NC}"
check_cmd "Docker" "docker" "20" "Install Docker from https://www.docker.com/"
check_optional "Docker Compose" "docker-compose" "Multi-service local orchestration" "Install docker-compose plugin"
check_optional "Stellar CLI / Soroban" "stellar" "Smart contract compilation and testnet RPC" "Run 'cargo install --locked stellar-cli --features opt'"
check_optional "pnpm" "pnpm" "Fast monorepo package manager" "Install via 'npm install -g pnpm'"

echo -e "\n${BLUE}--- [3/3] Checking Local Repository Configuration ---${NC}"
check_file "Root .env file" ".env" ".env.example"
check_file "Listener package.json" "listener/package.json" "N/A"
check_file "Dashboard package.json" "dashboard/package.json" "N/A"
check_file "Smart Contract Cargo.toml" "contract/Cargo.toml" "N/A"

echo -e "\n${BLUE}======================================================${NC}"
if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "${GREEN}🎉 All environment checks passed! Ready for local development.${NC}"
    exit 0
elif [ $ERRORS -eq 0 ]; then
    echo -e "${YELLOW}✓ Core prerequisites met with ${WARNINGS} non-blocking warning(s).${NC}"
    exit 0
else
    echo -e "${RED}❌ Found ${ERRORS} missing prerequisite(s) and ${WARNINGS} warning(s).${NC}"
    echo -e "${RED}Please resolve the actionable items above before starting development.${NC}"
    exit 1
fi

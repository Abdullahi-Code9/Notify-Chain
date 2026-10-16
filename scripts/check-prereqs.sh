#!/usr/bin/env bash

###############################################################################
# NotifyChain Environment Prerequisites Checker
#
# A non-destructive diagnostic utility that audits local developer environments
# before booting the stack. Checks for required runtime versions, package managers,
# and system dependencies.
#
# Usage:
#   ./scripts/check-prereqs.sh
#   npm run doctor
#   npm run check:env
#
# Exit Codes:
#   0 - All checks passed
#   1 - One or more checks failed
#
# Features:
#   - Non-destructive (never modifies system)
#   - Clear, actionable error messages
#   - Cross-platform support (Linux, macOS, Windows/Git Bash)
#   - Colored output for better readability
#   - Version checking with semver comparison
###############################################################################

set -u  # Exit on undefined variables

# ============================================================================
# Color Codes (ANSI escape sequences)
# ============================================================================
if [ -t 1 ]; then
  # Only use colors if connected to a terminal
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  RED=''
  GREEN=''
  YELLOW=''
  BLUE=''
  CYAN=''
  BOLD=''
  RESET=''
fi

# ============================================================================
# Global State
# ============================================================================
TOTAL_CHECKS=0
PASSED_CHECKS=0
FAILED_CHECKS=0
WARNINGS=0

# ============================================================================
# Utility Functions
# ============================================================================

print_header() {
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${CYAN}${BOLD}  NotifyChain Environment Prerequisites Check${RESET}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""
}

print_section() {
  echo ""
  echo -e "${BLUE}${BOLD}▶ $1${RESET}"
  echo -e "${BLUE}────────────────────────────────────────────────────────────────────────────${RESET}"
}

print_success() {
  echo -e "${GREEN}✓${RESET} $1"
}

print_error() {
  echo -e "${RED}✗${RESET} $1"
}

print_warning() {
  echo -e "${YELLOW}⚠${RESET} $1"
}

print_info() {
  echo -e "${CYAN}ℹ${RESET} $1"
}

print_command() {
  echo -e "  ${CYAN}\$ $1${RESET}"
}

print_summary() {
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${CYAN}${BOLD}  Summary${RESET}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""
  echo -e "  Total checks:    ${BOLD}$TOTAL_CHECKS${RESET}"
  echo -e "  ${GREEN}Passed:          $PASSED_CHECKS${RESET}"
  echo -e "  ${RED}Failed:          $FAILED_CHECKS${RESET}"
  echo -e "  ${YELLOW}Warnings:        $WARNINGS${RESET}"
  echo ""
  
  if [ "$FAILED_CHECKS" -eq 0 ]; then
    echo -e "${GREEN}${BOLD}✓ All checks passed! Your environment is ready.${RESET}"
    echo ""
  else
    echo -e "${RED}${BOLD}✗ Some checks failed. Please install missing dependencies above.${RESET}"
    echo ""
    echo -e "${YELLOW}Need help? Check the documentation:${RESET}"
    echo -e "  - README.md"
    echo -e "  - docs/SETUP.md (if exists)"
    echo ""
  fi
}

# ============================================================================
# Version Comparison
# ============================================================================

# Compare semantic versions (e.g., "18.0.0" >= "16.0.0")
# Returns: 0 if version1 >= version2, 1 otherwise
version_gte() {
  local version1=$1
  local version2=$2
  
  # Extract major, minor, patch
  local IFS='.'
  read -ra V1 <<< "$version1"
  read -ra V2 <<< "$version2"
  
  # Compare major
  if [ "${V1[0]:-0}" -gt "${V2[0]:-0}" ]; then
    return 0
  elif [ "${V1[0]:-0}" -lt "${V2[0]:-0}" ]; then
    return 1
  fi
  
  # Compare minor
  if [ "${V1[1]:-0}" -gt "${V2[1]:-0}" ]; then
    return 0
  elif [ "${V1[1]:-0}" -lt "${V2[1]:-0}" ]; then
    return 1
  fi
  
  # Compare patch
  if [ "${V1[2]:-0}" -ge "${V2[2]:-0}" ]; then
    return 0
  else
    return 1
  fi
}

# ============================================================================
# Check Functions
# ============================================================================

check_command_exists() {
  local cmd=$1
  local name=${2:-$cmd}
  
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
  
  if command -v "$cmd" >/dev/null 2>&1; then
    print_success "$name is installed"
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
    return 0
  else
    print_error "$name is not installed"
    FAILED_CHECKS=$((FAILED_CHECKS + 1))
    return 1
  fi
}

check_node_version() {
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
  
  if ! command -v node >/dev/null 2>&1; then
    print_error "Node.js is not installed"
    FAILED_CHECKS=$((FAILED_CHECKS + 1))
    echo ""
    echo -e "${YELLOW}Installation instructions:${RESET}"
    echo -e "  ${BOLD}macOS (Homebrew):${RESET}"
    print_command "brew install node"
    echo -e "  ${BOLD}Linux (apt):${RESET}"
    print_command "curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -"
    print_command "sudo apt-get install -y nodejs"
    echo -e "  ${BOLD}Windows:${RESET}"
    echo "    Download from https://nodejs.org/"
    echo -e "  ${BOLD}Alternative (nvm):${RESET}"
    print_command "nvm install 18"
    return 1
  fi
  
  local version
  version=$(node --version | sed 's/v//')
  local required="16.0.0"
  local recommended="18.0.0"
  
  if version_gte "$version" "$recommended"; then
    print_success "Node.js $version (recommended >= $recommended)"
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
    return 0
  elif version_gte "$version" "$required"; then
    print_warning "Node.js $version (works, but $recommended+ recommended)"
    WARNINGS=$((WARNINGS + 1))
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
    return 0
  else
    print_error "Node.js $version (minimum required: $required)"
    FAILED_CHECKS=$((FAILED_CHECKS + 1))
    echo ""
    echo -e "${YELLOW}Upgrade Node.js:${RESET}"
    print_command "nvm install 18"
    print_command "nvm use 18"
    return 1
  fi
}

check_npm_version() {
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
  
  if ! command -v npm >/dev/null 2>&1; then
    print_error "npm is not installed"
    FAILED_CHECKS=$((FAILED_CHECKS + 1))
    echo ""
    echo -e "${YELLOW}npm should come with Node.js. Reinstall Node.js.${RESET}"
    return 1
  fi
  
  local version
  version=$(npm --version)
  local required="8.0.0"
  
  if version_gte "$version" "$required"; then
    print_success "npm $version (>= $required)"
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
    return 0
  else
    print_error "npm $version (minimum required: $required)"
    FAILED_CHECKS=$((FAILED_CHECKS + 1))
    echo ""
    echo -e "${YELLOW}Upgrade npm:${RESET}"
    print_command "npm install -g npm@latest"
    return 1
  fi
}

check_rust_version() {
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
  
  if ! command -v rustc >/dev/null 2>&1; then
    print_error "Rust is not installed (required for smart contracts)"
    FAILED_CHECKS=$((FAILED_CHECKS + 1))
    echo ""
    echo -e "${YELLOW}Installation instructions:${RESET}"
    echo -e "  ${BOLD}All platforms:${RESET}"
    print_command "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    echo "    Then restart your terminal or run:"
    print_command "source \$HOME/.cargo/env"
    echo ""
    echo "  Or visit: https://rustup.rs/"
    return 1
  fi
  
  local version
  version=$(rustc --version | awk '{print $2}')
  local required="1.70.0"
  
  if version_gte "$version" "$required"; then
    print_success "Rust $version (>= $required)"
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
    return 0
  else
    print_error "Rust $version (minimum required: $required)"
    FAILED_CHECKS=$((FAILED_CHECKS + 1))
    echo ""
    echo -e "${YELLOW}Update Rust:${RESET}"
    print_command "rustup update"
    return 1
  fi
}

check_cargo() {
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
  
  if command -v cargo >/dev/null 2>&1; then
    local version
    version=$(cargo --version | awk '{print $2}')
    print_success "Cargo $version"
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
    return 0
  else
    print_error "Cargo is not installed"
    FAILED_CHECKS=$((FAILED_CHECKS + 1))
    echo ""
    echo -e "${YELLOW}Cargo should come with Rust. Reinstall Rust:${RESET}"
    print_command "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    return 1
  fi
}

check_wasm_target() {
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
  
  if ! command -v rustup >/dev/null 2>&1; then
    print_error "rustup is not installed"
    FAILED_CHECKS=$((FAILED_CHECKS + 1))
    return 1
  fi
  
  if rustup target list --installed | grep -q "wasm32-unknown-unknown"; then
    print_success "WebAssembly target (wasm32-unknown-unknown) is installed"
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
    return 0
  else
    print_error "WebAssembly target is not installed (required for Soroban contracts)"
    FAILED_CHECKS=$((FAILED_CHECKS + 1))
    echo ""
    echo -e "${YELLOW}Install WebAssembly target:${RESET}"
    print_command "rustup target add wasm32-unknown-unknown"
    return 1
  fi
}

check_stellar_cli() {
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
  
  if command -v stellar >/dev/null 2>&1; then
    local version
    version=$(stellar --version 2>/dev/null | head -n1 | awk '{print $2}' || echo "unknown")
    print_success "Stellar CLI $version"
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
    return 0
  else
    print_warning "Stellar CLI is not installed (optional but recommended)"
    WARNINGS=$((WARNINGS + 1))
    echo ""
    echo -e "${YELLOW}Installation instructions:${RESET}"
    print_command "cargo install --locked stellar-cli --features opt"
    echo ""
    echo "  Or with Homebrew:"
    print_command "brew install stellar/tap/stellar-cli"
    return 0
  fi
}

check_git() {
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
  
  if command -v git >/dev/null 2>&1; then
    local version
    version=$(git --version | awk '{print $3}')
    print_success "Git $version"
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
    return 0
  else
    print_error "Git is not installed"
    FAILED_CHECKS=$((FAILED_CHECKS + 1))
    echo ""
    echo -e "${YELLOW}Installation instructions:${RESET}"
    echo -e "  ${BOLD}macOS:${RESET}"
    print_command "brew install git"
    echo -e "  ${BOLD}Linux (Ubuntu/Debian):${RESET}"
    print_command "sudo apt-get install git"
    echo -e "  ${BOLD}Windows:${RESET}"
    echo "    Download from https://git-scm.com/download/win"
    return 1
  fi
}

check_make() {
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
  
  if command -v make >/dev/null 2>&1; then
    local version
    version=$(make --version 2>/dev/null | head -n1 | awk '{print $3}')
    print_success "Make $version"
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
    return 0
  else
    print_warning "Make is not installed (optional, but useful for build commands)"
    WARNINGS=$((WARNINGS + 1))
    echo ""
    echo -e "${YELLOW}Installation instructions:${RESET}"
    echo -e "  ${BOLD}macOS:${RESET}"
    print_command "xcode-select --install"
    echo -e "  ${BOLD}Linux (Ubuntu/Debian):${RESET}"
    print_command "sudo apt-get install build-essential"
    echo -e "  ${BOLD}Windows:${RESET}"
    echo "    Install via Chocolatey:"
    print_command "choco install make"
    return 0
  fi
}

check_disk_space() {
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
  
  local available
  
  # Cross-platform disk space check
  if command -v df >/dev/null 2>&1; then
    # Unix-like systems
    available=$(df . 2>/dev/null | tail -1 | awk '{print $4}')
    available=$((available / 1024)) # Convert to MB
  elif command -v wmic >/dev/null 2>&1; then
    # Windows with wmic
    available=$(wmic logicaldisk where "DeviceID='C:'" get FreeSpace | tail -1)
    available=$((available / 1024 / 1024)) # Convert to MB
  else
    print_warning "Unable to check disk space"
    WARNINGS=$((WARNINGS + 1))
    return 0
  fi
  
  local required=2000 # 2GB
  
  if [ "$available" -ge "$required" ]; then
    print_success "Disk space: ${available}MB available (>= ${required}MB required)"
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
    return 0
  else
    print_error "Disk space: ${available}MB available (< ${required}MB required)"
    FAILED_CHECKS=$((FAILED_CHECKS + 1))
    echo ""
    echo -e "${YELLOW}Free up disk space before continuing.${RESET}"
    return 1
  fi
}

check_project_dependencies() {
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
  
  local missing=0
  
  # Check listener dependencies
  if [ -d "listener" ] && [ -f "listener/package.json" ]; then
    if [ ! -d "listener/node_modules" ]; then
      print_warning "Listener dependencies not installed"
      echo ""
      echo -e "${YELLOW}Install listener dependencies:${RESET}"
      print_command "cd listener && npm install"
      missing=1
    else
      print_success "Listener dependencies installed"
    fi
  fi
  
  # Check dashboard dependencies
  if [ -d "dashboard" ] && [ -f "dashboard/package.json" ]; then
    if [ ! -d "dashboard/node_modules" ]; then
      print_warning "Dashboard dependencies not installed"
      echo ""
      echo -e "${YELLOW}Install dashboard dependencies:${RESET}"
      print_command "cd dashboard && npm install"
      missing=1
    else
      print_success "Dashboard dependencies installed"
    fi
  fi
  
  if [ "$missing" -eq 0 ]; then
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
    return 0
  else
    WARNINGS=$((WARNINGS + 1))
    return 0
  fi
}

check_env_files() {
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
  
  local missing=0
  
  # Check listener .env
  if [ -d "listener" ] && [ -f "listener/.env.example" ]; then
    if [ ! -f "listener/.env" ]; then
      print_warning "listener/.env not found"
      echo ""
      echo -e "${YELLOW}Create .env file:${RESET}"
      print_command "cd listener && cp .env.example .env"
      echo "  Then edit listener/.env with your configuration"
      missing=1
    else
      print_success "listener/.env exists"
    fi
  fi
  
  # Check dashboard .env (if .env.example exists)
  if [ -d "dashboard" ] && [ -f "dashboard/.env.example" ]; then
    if [ ! -f "dashboard/.env" ]; then
      print_warning "dashboard/.env not found"
      echo ""
      echo -e "${YELLOW}Create .env file:${RESET}"
      print_command "cd dashboard && cp .env.example .env"
      echo "  Then edit dashboard/.env with your configuration"
      missing=1
    else
      print_success "dashboard/.env exists"
    fi
  fi
  
  if [ "$missing" -eq 0 ]; then
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
    return 0
  else
    WARNINGS=$((WARNINGS + 1))
    return 0
  fi
}

check_system_info() {
  print_info "Operating System: $(uname -s) $(uname -m)"
  
  if [ -f /etc/os-release ]; then
    local os_name
    os_name=$(grep "^NAME=" /etc/os-release | cut -d'"' -f2)
    print_info "Distribution: $os_name"
  fi
  
  if command -v nproc >/dev/null 2>&1; then
    print_info "CPU Cores: $(nproc)"
  elif command -v sysctl >/dev/null 2>&1; then
    print_info "CPU Cores: $(sysctl -n hw.ncpu 2>/dev/null || echo 'unknown')"
  fi
}

# ============================================================================
# Main Execution
# ============================================================================

main() {
  print_header
  
  # System Information
  print_section "System Information"
  check_system_info
  
  # Core Tools
  print_section "Core Development Tools"
  check_git
  check_make
  check_disk_space
  
  # Node.js Ecosystem
  print_section "Node.js Ecosystem"
  check_node_version
  check_npm_version
  
  # Rust Ecosystem (for smart contracts)
  print_section "Rust Ecosystem (Smart Contracts)"
  check_rust_version
  check_cargo
  check_wasm_target
  check_stellar_cli
  
  # Project-specific checks
  print_section "Project Dependencies"
  check_project_dependencies
  check_env_files
  
  # Summary
  print_summary
  
  # Exit with appropriate code
  if [ "$FAILED_CHECKS" -gt 0 ]; then
    exit 1
  else
    exit 0
  fi
}

# Run main function
main "$@"

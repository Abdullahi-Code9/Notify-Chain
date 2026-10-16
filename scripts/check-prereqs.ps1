#!/usr/bin/env pwsh

<#
.SYNOPSIS
    NotifyChain Environment Prerequisites Checker (PowerShell)

.DESCRIPTION
    A non-destructive diagnostic utility for Windows PowerShell environments.
    Checks for required runtime versions, package managers, and system dependencies.

.EXAMPLE
    .\scripts\check-prereqs.ps1

.NOTES
    Exit Codes:
      0 - All checks passed
      1 - One or more checks failed
#>

# ============================================================================
# Configuration
# ============================================================================

$ErrorActionPreference = "Continue"
$Script:TotalChecks = 0
$Script:PassedChecks = 0
$Script:FailedChecks = 0
$Script:Warnings = 0

# ============================================================================
# Color Output Functions
# ============================================================================

function Write-Header {
    Write-Host ""
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
    Write-Host "  NotifyChain Environment Prerequisites Check" -ForegroundColor Cyan
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Section {
    param([string]$Title)
    Write-Host ""
    Write-Host "▶ $Title" -ForegroundColor Blue
    Write-Host "────────────────────────────────────────────────────────────────────────────" -ForegroundColor Blue
}

function Write-Success {
    param([string]$Message)
    Write-Host "✓ $Message" -ForegroundColor Green
}

function Write-Failure {
    param([string]$Message)
    Write-Host "✗ $Message" -ForegroundColor Red
}

function Write-Warning {
    param([string]$Message)
    Write-Host "⚠ $Message" -ForegroundColor Yellow
}

function Write-Info {
    param([string]$Message)
    Write-Host "ℹ $Message" -ForegroundColor Cyan
}

function Write-Command {
    param([string]$Command)
    Write-Host "  PS> $Command" -ForegroundColor Cyan
}

function Write-Summary {
    Write-Host ""
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
    Write-Host "  Summary" -ForegroundColor Cyan
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Total checks:    $Script:TotalChecks"
    Write-Host "  Passed:          $Script:PassedChecks" -ForegroundColor Green
    Write-Host "  Failed:          $Script:FailedChecks" -ForegroundColor Red
    Write-Host "  Warnings:        $Script:Warnings" -ForegroundColor Yellow
    Write-Host ""
    
    if ($Script:FailedChecks -eq 0) {
        Write-Host "✓ All checks passed! Your environment is ready." -ForegroundColor Green
        Write-Host ""
    }
    else {
        Write-Host "✗ Some checks failed. Please install missing dependencies above." -ForegroundColor Red
        Write-Host ""
        Write-Host "Need help? Check the documentation:" -ForegroundColor Yellow
        Write-Host "  - README.md"
        Write-Host "  - docs/ENVIRONMENT_SETUP.md"
        Write-Host ""
    }
}

# ============================================================================
# Version Comparison
# ============================================================================

function Compare-Version {
    param(
        [string]$Version1,
        [string]$Version2
    )
    
    try {
        $v1 = [version]$Version1
        $v2 = [version]$Version2
        return $v1 -ge $v2
    }
    catch {
        return $false
    }
}

# ============================================================================
# Check Functions
# ============================================================================

function Test-Command {
    param(
        [string]$Command,
        [string]$Name = $Command
    )
    
    $Script:TotalChecks++
    
    $cmd = Get-Command $Command -ErrorAction SilentlyContinue
    if ($cmd) {
        Write-Success "$Name is installed"
        $Script:PassedChecks++
        return
    }
    else {
        Write-Failure "$Name is not installed"
        $Script:FailedChecks++
        return
    }
}

function Test-NodeVersion {
    $Script:TotalChecks++
    
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Write-Failure "Node.js is not installed"
        $Script:FailedChecks++
        Write-Host ""
        Write-Host "Installation instructions:" -ForegroundColor Yellow
        Write-Host "  Download from https://nodejs.org/"
        Write-Host "  Or use Chocolatey:"
        Write-Command "choco install nodejs"
        Write-Host "  Or use Scoop:"
        Write-Command "scoop install nodejs"
        return
    }
    
    $version = (node --version) -replace 'v', ''
    $required = "16.0.0"
    $recommended = "18.0.0"
    
    if (Compare-Version $version $recommended) {
        Write-Success "Node.js $version (recommended >= $recommended)"
        $Script:PassedChecks++
    }
    elseif (Compare-Version $version $required) {
        Write-Warning "Node.js $version (works, but v18+ recommended)"
        $Script:Warnings++
        $Script:PassedChecks++
    }
    else {
        Write-Failure "Node.js $version (minimum required: $required)"
        $Script:FailedChecks++
        Write-Host ""
        Write-Host "Upgrade Node.js from https://nodejs.org/" -ForegroundColor Yellow
    }
}

function Test-NpmVersion {
    $Script:TotalChecks++
    
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npmCmd) {
        Write-Failure "npm is not installed"
        $Script:FailedChecks++
        return
    }
    
    $version = npm --version
    $required = "8.0.0"
    
    if (Compare-Version $version $required) {
        Write-Success "npm $version (>= $required)"
        $Script:PassedChecks++
    }
    else {
        Write-Failure "npm $version (minimum required: $required)"
        $Script:FailedChecks++
        Write-Host ""
        Write-Host "Upgrade npm:" -ForegroundColor Yellow
        Write-Command "npm install -g npm@latest"
    }
}

function Test-RustVersion {
    $Script:TotalChecks++
    
    $rustCmd = Get-Command rustc -ErrorAction SilentlyContinue
    if (-not $rustCmd) {
        Write-Failure "Rust is not installed (required for smart contracts)"
        $Script:FailedChecks++
        Write-Host ""
        Write-Host "Installation instructions:" -ForegroundColor Yellow
        Write-Host "  Download from https://rustup.rs/"
        Write-Host "  Or use Chocolatey:"
        Write-Command "choco install rust"
        return
    }
    
    $versionOutput = rustc --version
    $version = ($versionOutput -split ' ')[1]
    $required = "1.70.0"
    
    if (Compare-Version $version $required) {
        Write-Success "Rust $version (>= $required)"
        $Script:PassedChecks++
    }
    else {
        Write-Failure "Rust $version (minimum required: $required)"
        $Script:FailedChecks++
        Write-Host ""
        Write-Host "Update Rust:" -ForegroundColor Yellow
        Write-Command "rustup update"
    }
}

function Test-Cargo {
    $Script:TotalChecks++
    
    $cargoCmd = Get-Command cargo -ErrorAction SilentlyContinue
    if ($cargoCmd) {
        $versionOutput = cargo --version
        $version = ($versionOutput -split ' ')[1]
        Write-Success "Cargo $version"
        $Script:PassedChecks++
    }
    else {
        Write-Failure "Cargo is not installed"
        $Script:FailedChecks++
    }
}

function Test-WasmTarget {
    $Script:TotalChecks++
    
    $rustupCmd = Get-Command rustup -ErrorAction SilentlyContinue
    if (-not $rustupCmd) {
        Write-Failure "rustup is not installed"
        $Script:FailedChecks++
        return
    }
    
    $targets = rustup target list --installed
    if ($targets -match "wasm32-unknown-unknown") {
        Write-Success "WebAssembly target (wasm32-unknown-unknown) is installed"
        $Script:PassedChecks++
    }
    else {
        Write-Failure "WebAssembly target is not installed (required for Soroban contracts)"
        $Script:FailedChecks++
        Write-Host ""
        Write-Host "Install WebAssembly target:" -ForegroundColor Yellow
        Write-Command "rustup target add wasm32-unknown-unknown"
    }
}

function Test-StellarCli {
    $Script:TotalChecks++
    
    $stellarCmd = Get-Command stellar -ErrorAction SilentlyContinue
    if ($stellarCmd) {
        $versionOutput = stellar --version 2>$null
        $version = if ($versionOutput) { ($versionOutput -split ' ')[1] } else { "unknown" }
        Write-Success "Stellar CLI $version"
        $Script:PassedChecks++
    }
    else {
        Write-Warning "Stellar CLI is not installed (optional but recommended)"
        $Script:Warnings++
        Write-Host ""
        Write-Host "Installation instructions:" -ForegroundColor Yellow
        Write-Command "cargo install --locked stellar-cli --features opt"
    }
}

function Test-Git {
    $Script:TotalChecks++
    
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if ($gitCmd) {
        $versionOutput = git --version
        $version = ($versionOutput -split ' ')[2]
        Write-Success "Git $version"
        $Script:PassedChecks++
    }
    else {
        Write-Failure "Git is not installed"
        $Script:FailedChecks++
        Write-Host ""
        Write-Host "Installation instructions:" -ForegroundColor Yellow
        Write-Host "  Download from https://git-scm.com/download/win"
        Write-Host "  Or use Chocolatey:"
        Write-Command "choco install git"
    }
}

function Test-Make {
    $Script:TotalChecks++
    
    $makeCmd = Get-Command make -ErrorAction SilentlyContinue
    if ($makeCmd) {
        $versionOutput = make --version 2>$null
        $version = if ($versionOutput) { ($versionOutput[0] -split ' ')[-1] } else { "unknown" }
        Write-Success "Make $version"
        $Script:PassedChecks++
    }
    else {
        Write-Warning "Make is not installed (optional, useful for build commands)"
        $Script:Warnings++
        Write-Host ""
        Write-Host "Installation instructions:" -ForegroundColor Yellow
        Write-Host "  Install via Chocolatey:"
        Write-Command "choco install make"
        Write-Host "  Or use WSL (Windows Subsystem for Linux)"
    }
}

function Test-DiskSpace {
    $Script:TotalChecks++
    
    try {
        $drive = (Get-Location).Drive
        $freeSpace = [math]::Round($drive.Free / 1MB, 0)
        $required = 2000
        
        if ($freeSpace -ge $required) {
            Write-Success "Disk space: ${freeSpace}MB available (>= ${required}MB required)"
            $Script:PassedChecks++
        }
        else {
            Write-Failure "Disk space: ${freeSpace}MB available (< ${required}MB required)"
            $Script:FailedChecks++
        }
    }
    catch {
        Write-Warning "Unable to check disk space"
        $Script:Warnings++
    }
}

function Test-ProjectDependencies {
    $Script:TotalChecks++
    $missing = $false
    
    # Check listener dependencies
    if ((Test-Path "listener") -and (Test-Path "listener\package.json")) {
        if (-not (Test-Path "listener\node_modules")) {
            Write-Warning "Listener dependencies not installed"
            Write-Host ""
            Write-Host "Install listener dependencies:" -ForegroundColor Yellow
            Write-Command "cd listener; npm install"
            $missing = $true
        }
        else {
            Write-Success "Listener dependencies installed"
        }
    }
    
    # Check dashboard dependencies
    if ((Test-Path "dashboard") -and (Test-Path "dashboard\package.json")) {
        if (-not (Test-Path "dashboard\node_modules")) {
            Write-Warning "Dashboard dependencies not installed"
            Write-Host ""
            Write-Host "Install dashboard dependencies:" -ForegroundColor Yellow
            Write-Command "cd dashboard; npm install"
            $missing = $true
        }
        else {
            Write-Success "Dashboard dependencies installed"
        }
    }
    
    if (-not $missing) {
        $Script:PassedChecks++
    }
    else {
        $Script:Warnings++
    }
}

function Test-EnvFiles {
    $Script:TotalChecks++
    $missing = $false
    
    # Check listener .env
    if ((Test-Path "listener") -and (Test-Path "listener\.env.example")) {
        if (-not (Test-Path "listener\.env")) {
            Write-Warning "listener\.env not found"
            Write-Host ""
            Write-Host "Create .env file:" -ForegroundColor Yellow
            Write-Command "cd listener; cp .env.example .env"
            Write-Host "  Then edit listener\.env with your configuration"
            $missing = $true
        }
        else {
            Write-Success "listener\.env exists"
        }
    }
    
    # Check dashboard .env
    if ((Test-Path "dashboard") -and (Test-Path "dashboard\.env.example")) {
        if (-not (Test-Path "dashboard\.env")) {
            Write-Warning "dashboard\.env not found"
            Write-Host ""
            Write-Host "Create .env file:" -ForegroundColor Yellow
            Write-Command "cd dashboard; cp .env.example .env"
            Write-Host "  Then edit dashboard\.env with your configuration"
            $missing = $true
        }
        else {
            Write-Success "dashboard\.env exists"
        }
    }
    
    if (-not $missing) {
        $Script:PassedChecks++
    }
    else {
        $Script:Warnings++
    }
}

function Show-SystemInfo {
    $os = [System.Environment]::OSVersion
    $arch = [System.Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE")
    Write-Info "Operating System: $($os.Platform) $arch"
    Write-Info "OS Version: $($os.VersionString)"
    Write-Info "CPU Cores: $([System.Environment]::ProcessorCount)"
}

# ============================================================================
# Main Execution
# ============================================================================

function Main {
    Write-Header
    
    # System Information
    Write-Section "System Information"
    Show-SystemInfo
    
    # Core Tools
    Write-Section "Core Development Tools"
    Test-Git
    Test-Make
    Test-DiskSpace
    
    # Node.js Ecosystem
    Write-Section "Node.js Ecosystem"
    Test-NodeVersion
    Test-NpmVersion
    
    # Rust Ecosystem
    Write-Section "Rust Ecosystem (Smart Contracts)"
    Test-RustVersion
    Test-Cargo
    Test-WasmTarget
    Test-StellarCli
    
    # Project-specific checks
    Write-Section "Project Dependencies"
    Test-ProjectDependencies
    Test-EnvFiles
    
    # Summary
    Write-Summary
    
    # Exit with appropriate code
    if ($Script:FailedChecks -gt 0) {
        exit 1
    }
    else {
        exit 0
    }
}

# Run main function
Main

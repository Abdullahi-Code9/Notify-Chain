#!/usr/bin/env python3
"""
NotifyChain Automated Stale Configuration Detector (Issue #722)

Compares documented configuration variables against actual runtime/codebase usage
to detect dead or obsolete environment settings.
"""

import os
import re
import sys
import argparse
from pathlib import Path

# Variables known to be consumed by external CI/CD platforms, Docker Compose substitutions, or external services
ALLOWLIST = {
    'DISCORD_WEBHOOK_URL',
    'DISCORD_WEBHOOK_ID',
    'GITHUB_TOKEN',
    'NPM_TOKEN',
    'CF_API_TOKEN',
    'STELLAR_SECRET_KEY',
    'CLOUDFLARE_API_TOKEN',
}

def extract_env_keys(file_path):
    keys = set()
    if not file_path.exists():
        return keys

    content = file_path.read_text(encoding='utf-8')
    for line in content.splitlines():
        line = line.strip()
        if line.startswith('#') or not line:
            continue
        # Extract VAR_NAME from VAR_NAME=value
        match = re.match(r'^([A-Z0-9_]+)\s*=', line)
        if match:
            keys.add(match.group(1))
    return keys

def scan_codebase_for_var(repo_root, var_name):
    # Regex patterns matching env access in TS/JS, Rust, Bash, and Docker Compose
    patterns = [
        re.compile(rf'\b{re.escape(var_name)}\b'),
        re.compile(rf'process\.env\.{re.escape(var_name)}'),
        re.compile(rf'import\.meta\.env\.{re.escape(var_name)}'),
        re.compile(rf'\${{{re.escape(var_name)}}}'),
        re.compile(rf'\${re.escape(var_name)}'),
        re.compile(rf'env::var\("{re.escape(var_name)}"\)'),
    ]

    search_dirs = [
        repo_root / 'listener' / 'src',
        repo_root / 'dashboard' / 'src',
        repo_root / 'contract' / 'src',
        repo_root / 'docker-compose.yml',
        repo_root / 'scripts',
    ]

    matched_files = []

    for target in search_dirs:
        if target.is_file():
            content = target.read_text(encoding='utf-8', errors='ignore')
            if any(p.search(content) for p in patterns):
                matched_files.append(str(target.relative_to(repo_root)))
        elif target.is_dir():
            for root, _, files in os.walk(target):
                for f in files:
                    if f.endswith(('.ts', '.tsx', '.js', '.jsx', '.rs', '.sh', '.yml', '.yaml', '.json')):
                        fp = Path(root) / f
                        content = fp.read_text(encoding='utf-8', errors='ignore')
                        if any(p.search(content) for p in patterns):
                            matched_files.append(str(fp.relative_to(repo_root)))

    return matched_files

def main():
    parser = argparse.ArgumentParser(description="Detect stale or obsolete configuration variables.")
    parser.add_argument("--warn-only", action="store_true", help="Warn only without exiting with error code")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    env_example = repo_root / '.env.example'

    print(f"🔍 Analyzing documented configuration variables in: {env_example}\n")

    documented_vars = extract_env_keys(env_example)
    print(f"Found {len(documented_vars)} documented configuration variables:")
    for v in sorted(documented_vars):
        print(f"  • {v}")

    print("\nScanning codebase for active references...")

    stale_vars = []
    active_vars = []

    for v in sorted(documented_vars):
        if v in ALLOWLIST:
            active_vars.append((v, ['[Allowlisted Platform/CI variable]']))
            continue

        usages = scan_codebase_for_var(repo_root, v)
        if usages:
            active_vars.append((v, usages))
        else:
            stale_vars.append(v)

    print(f"\n📊 Usage Summary: {len(active_vars)} active, {len(stale_vars)} potentially stale.")

    if stale_vars:
        print("\n⚠️ Potentially Obsolete / Stale Configuration Variables Detected:")
        for s in stale_vars:
            print(f"  ❌ {s}: Documented in .env.example but not referenced in application code")

        if args.warn_only:
            print("\n⚠️ Exiting with success (warn-only mode).")
            sys.exit(0)
        else:
            sys.exit(1)
    else:
        print("\n✅ All documented configuration variables are actively referenced in the codebase!")
        sys.exit(0)

if __name__ == '__main__':
    main()

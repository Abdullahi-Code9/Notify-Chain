#!/usr/bin/env python3
"""
Contract Event Documentation Drift Validator (Issue #714)

Extracts #[contractevent] structs from Soroban Rust sources and validates them
against the documented event catalog in docs/CONTRACT_EVENTS.md.
"""

import os
import re
import sys
import argparse
from pathlib import Path

def extract_code_events(events_rs_path):
    events = {}
    if not events_rs_path.exists():
        return events

    content = events_rs_path.read_text(encoding='utf-8')

    # Regex matching #[contractevent...] pub struct EventName { ... }
    struct_matches = re.finditer(r'(?:#\[contractevent[^\]]*\]\s*)+(?:#\[derive[^\]]*\]\s*)*pub struct\s+([A-Za-z0-9_]+)\s*\{([^}]+)\}', content)

    for match in struct_matches:
        event_name = match.group(1)
        body = match.group(2)
        fields = []
        topics = []
        
        for line in body.splitlines():
            line = line.strip()
            if line.startswith('pub '):
                # pub field_name: Type,
                field_part = line.replace('pub ', '').split(':')[0].strip()
                fields.append(field_part)

        events[event_name] = {
            'fields': fields,
        }

    return events

def extract_documented_events(docs_path):
    documented = set()
    if not docs_path.exists():
        return documented

    content = docs_path.read_text(encoding='utf-8')
    # Match headers like `### AutoshareCreated` or `## AutoshareCreated`
    matches = re.findall(r'###?\s+`?([A-Z][a-zA-Z0-9_]+)`?', content)
    for m in matches:
        documented.add(m)

    return documented

def main():
    parser = argparse.ArgumentParser(description="Validate contract events against documentation.")
    parser.add_argument("--warn-only", action="store_true", help="Advisory mode")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    events_rs = repo_root / 'contract/contracts/hello-world/src/base/events.rs'
    docs_md = repo_root / 'docs/CONTRACT_EVENTS.md'

    print(f"🔍 Validating Contract Event Documentation Drift...\n")
    print(f"  Source: {events_rs}")
    print(f"  Docs:   {docs_md}\n")

    code_events = extract_code_events(events_rs)
    doc_events = extract_documented_events(docs_md)

    print(f"Found {len(code_events)} #[contractevent] structs in Rust implementation.")
    print(f"Found {len(doc_events)} documented events in {docs_md.name}.\n")

    missing_in_docs = []
    for event_name in sorted(code_events.keys()):
        if event_name not in doc_events:
            missing_in_docs.append(event_name)

    if missing_in_docs:
        print(f"❌ Documentation Drift Detected! The following {len(missing_in_docs)} events are missing from docs:")
        for name in missing_in_docs:
            print(f"  • {name} (Fields: {', '.join(code_events[name]['fields'])})")

        if args.warn_only:
            print("\n⚠️ Exiting 0 (warn-only mode enabled).")
            sys.exit(0)
        else:
            print("\n❌ Please update docs/CONTRACT_EVENTS.md to resolve documentation drift.")
            sys.exit(1)
    else:
        print("✅ All contract events are accurately documented with zero drift!")
        sys.exit(0)

if __name__ == '__main__':
    main()

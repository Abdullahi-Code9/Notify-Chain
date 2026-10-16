#!/usr/bin/env python3
"""
NotifyChain Documentation Link Validator (Issue #720)

Scans all Markdown files (.md) across the repository to validate internal relative links,
ensuring zero broken references while safely excluding or warn-logging external URLs
to prevent fragile CI failures.
"""

import os
import re
import sys
import argparse
from pathlib import Path
from urllib.parse import unquote

# Regex to find markdown links: [text](target)
LINK_PATTERN = re.compile(r'(?<!\!)\[([^\]]+)\]\(([^)]+)\)')

def scan_markdown_files(repo_root):
    broken_links = []
    total_links = 0
    total_files = 0

    ignore_dirs = {'.git', 'node_modules', 'target', 'dist', 'build', '.next'}

    for root, dirs, files in os.walk(repo_root):
        dirs[:] = [d for d in dirs if d not in ignore_dirs]
        for f in files:
            if f.endswith('.md'):
                total_files += 1
                file_path = Path(root) / f
                rel_file_path = file_path.relative_to(repo_root)

                try:
                    content = file_path.read_text(encoding='utf-8')
                except Exception as e:
                    print(f"⚠️ Failed to read {rel_file_path}: {e}")
                    continue

                # Remove fenced code blocks and inline code to prevent false positive matches
                cleaned_content = re.sub(r'```[\s\S]*?```', '', content)
                cleaned_content = re.sub(r'`[^`]*`', '', cleaned_content)

                for match in LINK_PATTERN.finditer(cleaned_content):
                    total_links += 1
                    link_text = match.group(1).strip()
                    raw_target = match.group(2).strip()

                    # Handle link with title: [text](path "title")
                    if ' ' in raw_target:
                        raw_target = raw_target.split(' ')[0]

                    # Strip anchor: path#section
                    target_no_anchor = unquote(raw_target.split('#')[0])

                    # Skip empty, mailto, tel, anchors only, or external URLs
                    if not target_no_anchor:
                        continue
                    if raw_target.startswith(('http://', 'https://', 'mailto:', 'tel:', 'javascript:', 'file:///workspaces/')):
                        continue

                    # Resolve internal relative link
                    if target_no_anchor.startswith('/'):
                        # Root-relative link
                        resolved_path = (repo_root / target_no_anchor.lstrip('/')).resolve()
                    else:
                        # File-relative link
                        resolved_path = (file_path.parent / target_no_anchor).resolve()

                    # Verify target exists (file or directory)
                    if not resolved_path.exists():
                        broken_links.append({
                            'source_file': str(rel_file_path),
                            'link_text': link_text,
                            'target': raw_target,
                            'resolved': str(resolved_path)
                        })

    return total_files, total_links, broken_links

def main():
    parser = argparse.ArgumentParser(description="Validate documentation markdown links.")
    parser.add_argument("--warn-only", action="store_true", help="Print warnings but exit with 0")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    print(f"🔍 Scanning Markdown documentation links in: {repo_root}\n")

    files_count, links_count, broken = scan_markdown_files(repo_root)

    print(f"Scanned {files_count} Markdown files, validated {links_count} links.\n")

    if broken:
        print(f"⚠️ Found {len(broken)} broken internal documentation link(s):")
        for b in broken[:20]:
            print(f"  • In '{b['source_file']}': [{b['link_text']}]({b['target']}) -> Missing")
        if len(broken) > 20:
            print(f"  ... and {len(broken) - 20} more broken links.")

        if args.warn_only:
            print("\n⚠️ Exiting with success (warn-only mode enabled).")
            sys.exit(0)
        else:
            print("\n❌ Please fix broken relative links above or run with --warn-only.")
            sys.exit(1)
    else:
        print("✅ All internal documentation links are valid!")
        sys.exit(0)

if __name__ == '__main__':
    main()

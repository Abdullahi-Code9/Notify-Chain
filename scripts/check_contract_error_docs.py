#!/usr/bin/env python3
"""Check that docs/CONTRACT_ERROR_TABLE.md matches the contracts' error enums (#1252).

Each documented contract has an `Error` enum (`Name = code,`) and a section of the
table with rows like "| `8` | `Unauthorized` | ... |". The check fails when a
variant is missing from the table, a row names a variant that no longer exists, or
the code differs.

Usage: python3 scripts/check_contract_error_docs.py [repo_root]
"""

import re
import sys
from pathlib import Path

DOC = Path("docs/CONTRACT_ERROR_TABLE.md")

# (section heading prefix in the doc, path to the Rust file defining `enum Error`)
CONTRACTS = (
    ("## 2. NotifyChain core contract", Path("contract/contracts/hello-world/src/base/errors.rs")),
    ("## 3. TaskBounty contract", Path("Documents/Task Bounty/src/types.rs")),
)

ENUM_PATTERN = re.compile(r"pub enum Error\s*\{([^}]*)\}")
VARIANT_PATTERN = re.compile(r"^\s*([A-Z][A-Za-z0-9]*)\s*=\s*(\d+)\s*,", re.MULTILINE)
ROW_PATTERN = re.compile(r"^\|\s*`(\d+)`\s*\|\s*`([A-Za-z0-9]+)`\s*\|", re.MULTILINE)
COMMENT_PATTERN = re.compile(r"//[^\n]*")


def parse_enum(source: str) -> dict[str, int]:
    """Variant name -> code for the first `pub enum Error` in `source`."""
    match = ENUM_PATTERN.search(COMMENT_PATTERN.sub("", source))
    if not match:
        raise ValueError("no `pub enum Error` found")
    return {name: int(code) for name, code in VARIANT_PATTERN.findall(match.group(1))}


def section(doc: str, heading: str) -> str:
    """Text of the section starting with `heading`, up to the next `## ` heading."""
    start = doc.find(heading)
    if start == -1:
        raise ValueError(f"section {heading!r} not found")
    end = doc.find("\n## ", start + len(heading))
    return doc[start:] if end == -1 else doc[start:end]


def parse_rows(text: str) -> dict[str, int]:
    return {name: int(code) for code, name in ROW_PATTERN.findall(text)}


def compare(variants: dict[str, int], rows: dict[str, int], label: str) -> list[str]:
    problems = []
    for name, code in sorted(variants.items(), key=lambda item: item[1]):
        if name not in rows:
            problems.append(f"{label}: `{name}` (code {code}) is missing from the table")
        elif rows[name] != code:
            problems.append(f"{label}: `{name}` is documented as {rows[name]} but is {code} in the source")
    for name, code in sorted(rows.items(), key=lambda item: item[1]):
        if name not in variants:
            problems.append(f"{label}: table row `{name}` (code {code}) does not exist in the source")
    return problems


def check(root: Path) -> list[str]:
    doc = (root / DOC).read_text(encoding="utf-8")
    problems: list[str] = []
    for heading, source_path in CONTRACTS:
        variants = parse_enum((root / source_path).read_text(encoding="utf-8"))
        rows = parse_rows(section(doc, heading))
        problems.extend(compare(variants, rows, heading.lstrip("# ")))
    return problems


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
    problems = check(root)
    if problems:
        print(f"{DOC} is out of sync with the contract error enums:")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print(f"{DOC} matches the contract error enums.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

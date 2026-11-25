#!/usr/bin/env python3
"""Validate Soroban contract event names and indexed topic layouts."""

import re
import sys
from dataclasses import dataclass
from pathlib import Path


EVENT_PATTERN = re.compile(
    r"#\[contractevent(?:[^\]]*)\]\s*(?:#\[derive[^\]]*\]\s*)*"
    r"pub struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([^}]*)\}"
)
FIELD_PATTERN = re.compile(r"pub\s+([A-Za-z_][A-Za-z0-9_]*)\s*:")
EVENT_NAME_PATTERN = re.compile(r"^[A-Z][a-zA-Z0-9]*$")
FIELD_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$")
COMMENT_PATTERN = re.compile(r"//[^\n]*|/\*[\s\S]*?\*/")
MAX_TOPICS = 4


@dataclass(frozen=True)
class ContractEvent:
    name: str
    fields: tuple[tuple[str, bool], ...]
    path: str
    line: int


def extract_contract_events(source: str, path: str = "<memory>") -> list[ContractEvent]:
    source_without_comments = COMMENT_PATTERN.sub(
        lambda match: "\n" * match.group(0).count("\n"), source
    )
    events = []

    for match in EVENT_PATTERN.finditer(source_without_comments):
        body = match.group(2)
        fields = []
        topic_pending = False
        for line in body.splitlines():
            stripped = line.strip()
            if stripped == "#[topic]":
                topic_pending = True
                continue

            field_match = FIELD_PATTERN.search(stripped)
            if field_match:
                fields.append((field_match.group(1), topic_pending))
                topic_pending = False

        events.append(
            ContractEvent(
                name=match.group(1),
                fields=tuple(fields),
                path=path,
                line=source_without_comments.count("\n", 0, match.start()) + 1,
            )
        )

    return events


def validate_event_definitions(events: list[ContractEvent]) -> list[str]:
    errors = []
    seen_names = {}

    for event in events:
        location = f"{event.path}:{event.line}"
        if not EVENT_NAME_PATTERN.fullmatch(event.name):
            errors.append(
                f"{location}: event {event.name!r} must use PascalCase "
                "(for example, NotificationScheduled)"
            )

        previous = seen_names.get(event.name)
        if previous:
            errors.append(
                f"{location}: event name {event.name!r} is also defined at {previous}; "
                "rename one event to keep generated event names unique"
            )
        else:
            seen_names[event.name] = location

        topic_names = [name for name, is_topic in event.fields if is_topic]
        if len(topic_names) > MAX_TOPICS:
            errors.append(
                f"{location}: event {event.name} declares {len(topic_names)} indexed fields; "
                f"Soroban contract events support at most {MAX_TOPICS} (excluding the event name)"
            )

        data_field_seen = False
        for name, is_topic in event.fields:
            if not FIELD_NAME_PATTERN.fullmatch(name):
                errors.append(
                    f"{location}: field {name!r} in event {event.name} must use snake_case"
                )
            if is_topic and data_field_seen:
                errors.append(
                    f"{location}: topic field {name!r} in event {event.name} appears after a data field; "
                    "move all #[topic] fields before unindexed fields"
                )
            if not is_topic:
                data_field_seen = True

        if "priority" in topic_names and (
            len(topic_names) < 2 or topic_names[-2:] != ["category", "priority"]
        ):
            errors.append(
                f"{location}: event {event.name} indexes priority without category immediately before it; "
                "place category and priority as the final two topics"
            )

    return errors


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    contract_root = repo_root / "contract"
    events = []

    for source_path in sorted(contract_root.rglob("*.rs")):
        relative_path = source_path.relative_to(repo_root).as_posix()
        events.extend(
            extract_contract_events(source_path.read_text(encoding="utf-8"), relative_path)
        )

    if not events:
        print(f"No #[contractevent] definitions found under {contract_root}", file=sys.stderr)
        return 1

    errors = validate_event_definitions(events)
    if errors:
        print("Contract event convention violations:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1

    print(f"Validated naming and topic conventions for {len(events)} contract events.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
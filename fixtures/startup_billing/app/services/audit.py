"""In-memory audit log. Every business-relevant event is recorded here."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class AuditEntry:
    event_type: str
    data: dict


@dataclass
class AuditLog:
    entries: list[AuditEntry] = field(default_factory=list)

    def record(self, event_type: str, **data) -> AuditEntry:
        entry = AuditEntry(event_type, dict(data))
        self.entries.append(entry)
        return entry

    def events(self, event_type: str) -> list[AuditEntry]:
        return [entry for entry in self.entries if entry.event_type == event_type]

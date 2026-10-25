"""Customer notifications (in-memory outbox)."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Notification:
    recipient: str
    subject: str
    body: str


@dataclass
class Notifier:
    messages: list[Notification] = field(default_factory=list)

    def send(self, recipient: str, subject: str, body: str) -> Notification:
        message = Notification(recipient, subject, body)
        self.messages.append(message)
        return message

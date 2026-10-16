# 🧩 Notification Provider Capability Metadata & Degradation

This document details the provider capability discovery and graceful degradation system for NotifyChain (Issue #708).

---

## 1. Capability Taxonomy

Providers declare their supported feature sets via `NotificationCapability`:

* `rich_formatting`: Markdown syntax (bold, italics, inline code).
* `embedded_links`: Rich action buttons / hyperlinked titles.
* `attachments`: Binary media and document attachments.
* `message_updates`: Live in-place message editing.
* `threading`: Conversational threading / reply keys.
* `batching`: Multi-event batch payload processing.

---

## 2. Graceful Degradation Strategy

The core dispatch pipeline is completely decoupled from provider-specific logic. When a rich event is dispatched to a limited destination (e.g. Plain Webhook, SMS):

1. **Markdown is stripped** to readable plaintext.
2. **Action links are expanded** into raw URLs.
3. **Attachments are referenced** textually with fallback notices without dropping notification delivery.

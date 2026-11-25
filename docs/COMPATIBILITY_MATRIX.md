# Compatibility Matrix for Notification Consumers

This document provides a machine-readable compatibility matrix for Notify-Chain notification consumers. It identifies supported payload versions, delivery adapters, and consumer-facing compatibility expectations.

## Payload Version Compatibility

| Payload Version | Status | Supported Adapters | Notes |
|-----------------|--------|-------------------|-------|
| v1.0.0 | Stable | Webhook, Email, SMS, Push | Initial release with core notification features |
| v1.1.0 | Stable | Webhook, Email, SMS, Push | Added retry metadata and scheduling support |
| v1.2.0 | Beta | Webhook, Email, SMS, Push, Discord | Added Discord adapter (beta), event source field |

## Delivery Adapter Compatibility

| Adapter | Minimum Payload Version | Features | Configuration |
|---------|------------------------|----------|---------------|
| Webhook | v1.0.0 | Signature verification, retry, rate limiting | `WEBHOOK_URL`, `WEBHOOK_SECRET` |
| Email | v1.0.0 | HTML templates, attachments, BCC | SMTP or SendGrid configuration |
| SMS | v1.0.0 | Character limit checking, Unicode support | Twilio or Termii configuration |
| Push | v1.1.0 | FCM, APNs, silent notifications | Device token configuration |
| Discord | v1.2.0 (Beta) | Embeds, webhook URLs | Discord webhook URL (beta) |

## Consumer Integration Compatibility

| Integration Type | Minimum Version | Supported Protocols | Documentation |
|------------------|----------------|---------------------|---------------|
| Direct API | v1.0.0 | REST | [API.md](../listener/API.md) |
| Webhook Consumer | v1.0.0 | HTTP/HTTPS | [NOTIFICATION-FLOW.md](./NOTIFICATION-FLOW.md) |
| Email Client | v1.0.0 | SMTP | [LISTENER-CONFIGURATION.md](./LISTENER-CONFIGURATION.md) |
| SMS Client | v1.0.0 | Twilio/Termii API | [LISTENER-CONFIGURATION.md](./LISTENER-CONFIGURATION.md) |
| Push Client | v1.1.0 | FCM/APNs | [LISTENER-CONFIGURATION.md](./LISTENER-CONFIGURATION.md) |

## Environment Configuration

The following environment variables control notification delivery:

| Variable | Purpose | Default | Required |
|----------|---------|---------|----------|
| `STELLAR_NETWORK` | Stellar network label | `testnet` | Yes |
| `STELLAR_RPC_URL` | Soroban RPC endpoint | Testnet URL | Yes |
| `CONTRACT_ADDRESSES` | Contracts to monitor | None | Yes |
| `LOG_LEVEL` | Logging verbosity | `info` | No |

## CI Validation

This compatibility matrix is validated by CI to ensure:
- All listed adapters match the implementation in `.env.example`
- All environment variables are documented
- All documentation links are valid
- Breaking changes require a version bump

## Support Policy

- **Stable versions**: Supported for 12 months after release
- **Beta versions**: Supported for 3 months after release
- **End-of-life versions**: No longer supported, consumers should upgrade

## Questions?

For questions about compatibility, please:
1. Review the [API Documentation](../listener/API.md)
2. Check the [Listener Configuration](./LISTENER-CONFIGURATION.md)
3. Open an issue in the repository
4. 

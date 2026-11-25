## Event Schema Compatibility Testing

## Overview

This document describes the approach for verifying that changes to event structures do not unintentionally break listener decoders or external consumers in the Notify-Chain system.

## Problem Statement

Event structures emitted by smart contracts can evolve over time. Changes might include:
- Adding new fields
- Removing fields
- Changing field types
- Reordering topics
- Modifying field names

External consumers (listeners, indexers, dashboards) depend on specific event shapes. Breaking changes can cause:
- Decode failures
- Data loss
- Runtime errors
- Silent misinterpretation of events

## Solution: Historical Fixture Testing

### Architecture

The compatibility testing system consists of three components:

####  1. Historical Event Fixtures (`src/test-fixtures/historical-events.ts`)

Representative event payloads from different schema versions. Each fixture includes:
- **version**: Schema version number
- **eventName**: Name of the event type
- **topics**: Array of indexed topic values
- **data**: Event data fields
- **description**: Human-readable description

```typescript
export const HISTORICAL_EVENTS_V1 = {
  notificationScheduled: {
    version: 1,
    eventName: 'NotificationScheduled',
    topics: ['creator_address', '3', '1'],
    data: {
      notification_id: 'aabbccdd...',
      payload_version: 1,
    },
    description: 'Initial notification scheduling event',
  },
  // ... more fixtures
};
```

#### 2. Schema Compatibility Checker (`src/schema/compatibility-check.ts`)

Validates contract events against consumer expectations:
- **`extractContractEvents`**: Parses Rust event definitions from source
- **`loadConsumerSchema`**: Loads JSON schema of expected events
- **`checkSchemaCompatibility`**: Compares contract vs consumer schemas

Detects:
- Missing events
- Removed/reordered topics
- Type changes
- Missing/renamed fields

Returns:
- **breakingChanges**: Array of incompatible modifications
- **safeAdditions**: Array of backward-compatible additions
- **compatible**: Boolean indicating overall compatibility

#### 3. Compatibility Tests (`src/__tests__/event-schema-compatibility.test.ts`)

Automated tests that:
1. Load current contract events and consumer schema
2. Verify schema compatibility (no breaking changes)
3. Validate historical fixtures have correct structure
4. Ensure critical events have fixtures
5. Test that fixtures match consumer expectations

## Usage

### Running Tests

```bash
cd listener
npm test -- event-schema-compatibility.test.ts
```

### Adding New Fixtures

When adding a new schema version:

1. **Update `historical-events.ts`**:
```typescript
export const HISTORICAL_EVENTS_V2 = {
  newEvent: {
    version: 2,
    eventName: 'NewEvent',
    topics: [...],
    data: {...},
    description: '...',
  },
};
```

2. **Update `ALL_HISTORICAL_EVENTS`**:
```typescript
export const ALL_HISTORICAL_EVENTS = {
  v1: HISTORICAL_EVENTS_V1,
  v2: HISTORICAL_EVENTS_V2,
};
```

3. **Add test cases** in `event-schema-compatibility.test.ts`

### Handling Breaking Changes

If a breaking change is detected:

1. **Review the change**: Is it intentional?
2. **Bump payload version**: Update `CURRENT_NOTIFICATION_VERSION` in contract
3. **Update consumer schema**: Modify `consumer-event-schema.json`
4. **Add migration logic**: Update event decoders to handle both versions
5. **Document the change**: Add entry to version history
6. **Update fixtures**: Add new version fixtures

## Integration with CI/CD

These tests run automatically in the CI pipeline:

```yaml
- name: Event Schema Compatibility
  run: |
    cd listener
    npm test -- event-schema-compatibility.test.ts
```

Builds fail if:
- Breaking changes are detected without version bumps
- Historical fixtures fail validation
- Critical events lack fixture coverage

## Best Practices

### For Contract Developers

- **Always append**: Add new topics/fields at the end
- **Never remove**: Don't delete existing topics/fields
- **Version bumps**: Increment version for breaking changes
- **Backward compatibility**: Support old versions in decoders

### For Listener Developers

- **Update schema**: Keep `consumer-event-schema.json` in sync
- **Test fixtures**: Add fixtures for new event types
- **Handle versions**: Check `payload_version` in decoders
- **Fail gracefully**: Fall back to `RawUndecodedEvent` on unknown versions

### For External Consumers

- **Check version**: Inspect `payload_version` field before decoding
- **Subscribe to changes**: Monitor breaking change notifications
- **Test thoroughly**: Use historical fixtures for integration tests
- **Handle unknowns**: Skip or log events with unsupported versions

## Critical Events

The following events are flagged as critical and require fixture coverage:

- `NotificationScheduled`
- `NotificationRevoked`
- `NotificationExpired`
- `AutoshareCreated`
- `BatchNotificationsCreated`

## Schema Version History

| Version | Date       | Changes |
|---------|------------|---------|
| 1       | 2026-07-26 | Initial versioned notification payloads |

## Future Enhancements

- [ ] Automated fixture generation from live events
- [ ] Decoder fuzzing with mutated fixtures
- [ ] Cross-version compatibility matrix
- [ ] Consumer impact analysis reports
- [ ] Schema migration helpers
- [ ] Event shape documentation generator

## References

- **Contract Events**: `contract/contracts/hello-world/src/base/events.rs`
- **Consumer Schema**: `listener/src/schema/consumer-event-schema.json`
- **Event Reference**: `CONTRACT_EVENT_REFERENCE.md`
- **Compatibility Checker**: `listener/src/schema/compatibility-check.ts`

# Webhook Key Rotation - Design Document

## Overview

The webhook key rotation system enables secure, non-disruptive replacement of signing keys used to authenticate webhook payloads. The system maintains multiple valid keys during a configurable transition period, allowing consumers to migrate at their own pace while ensuring cryptographic security throughout the lifecycle.

### Key Design Principles

1. **Zero-Downtime Rotation**: Multiple valid keys prevent service disruption during transitions
2. **Backward Compatibility**: Existing consumers work without configuration changes
3. **Security First**: Keys are encrypted at rest, never logged in plain text, verified with constant-time comparison
4. **Observable Rotations**: Complete audit trail and monitoring capabilities
5. **Operational Safety**: Explicit confirmations, validation checks, and rollback procedures

---

## Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────────┐
│                     Webhook System                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────┐       ┌──────────────────┐                │
│  │  Key Manager     │       │  Verification    │                │
│  │                  │──────▶│  Engine          │                │
│  │ - Store/Retrieve │       │                  │                │
│  │ - Rotation Logic │       │ - Multi-key      │                │
│  │ - Lifecycle Mgmt │       │   verification   │                │
│  └──────────────────┘       │ - Constant-time  │                │
│           ▲                 │   comparison     │                │
│           │                 └──────────────────┘                │
│           │                                                    │
│  ┌─────────────────────────────────────────┐                  │
│  │         Configuration Layer              │                  │
│  │ - Key Metadata Store                     │                  │
│  │ - Transition Policy Config               │                  │
│  │ - Rotation History/Audit Log             │                  │
│  └─────────────────────────────────────────┘                  │
│           ▲                                                    │
│           │                                                    │
│  ┌─────────────────────────────────────────┐                  │
│  │      Secure Storage Layer               │                  │
│  │ - Encrypted Key Material (AES-256)      │                  │
│  │ - Atomic State Transitions               │                  │
│  │ - Crash Recovery                         │                  │
│  └─────────────────────────────────────────┘                  │
│                                                                 │
│  ┌──────────────────┐       ┌──────────────────┐                │
│  │  Monitoring &    │       │  API/Interface   │                │
│  │  Alerting        │       │                  │                │
│  │                  │       │ - initRotation() │                │
│  │ - Metrics Export │       │ - queryKeys()    │                │
│  │ - Health Checks  │       │ - verifyWebhook()│                │
│  │ - Alerts         │       │ - getKeyInfo()   │                │
│  └──────────────────┘       └──────────────────┘                │
└─────────────────────────────────────────────────────────────────┘
```

### Component Interactions

1. **Key Manager**: Orchestrates key lifecycle, state transitions, and rotation workflows
2. **Verification Engine**: Validates signatures using multiple valid keys with constant-time comparison
3. **Configuration Layer**: Manages key metadata, policies, and audit logs
4. **Secure Storage**: Encrypts and persists keys, ensures crash recovery
5. **Monitoring & Alerting**: Exports metrics and triggers escalation alerts
6. **API/Interface**: Exposes operations for rotation management and verification

---

## Data Models

### Key Metadata Structure

```rust
struct WebhookKey {
    // Identity and cryptographic material
    key_id: String,                    // Unique identifier (UUID)
    key_material: EncryptedBytes,      // AES-256 encrypted key data
    algorithm: KeyAlgorithm,           // HMAC-SHA256, ECDSA-P256, etc.
    
    // Lifecycle tracking
    status: KeyStatus,                 // active | transitional | retired
    created_at: Timestamp,             // When key was created
    activated_at: Timestamp,           // When key became active
    rotated_at: Option<Timestamp>,     // When rotation occurred
    expires_at: Timestamp,             // When key expires
    retired_at: Option<Timestamp>,     // When key was marked retired
    
    // Rotation context
    rotation_reason: Option<String>,   // "scheduled", "security_incident", etc.
    rotation_trigger: RotationTrigger, // manual | scheduled | event-based
    operator_id: String,               // Who initiated the rotation
    
    // Metadata
    version: u32,                      // Schema version for evolution
    tags: Map<String, String>,         // Custom metadata
}

enum KeyStatus {
    Active,                            // Currently used for signing
    Transitional,                      // Valid for verification only
    Retired,                           // No longer accepted
}

enum RotationTrigger {
    Manual { command_id: String },
    Scheduled { policy_name: String },
    EventTriggered { event_id: String, reason: String },
}
```

### System Configuration

```rust
struct RotationConfig {
    // Rotation policy
    transition_period_seconds: u64,    // How long old keys remain valid (default: 3600)
    max_keys_retained: usize,          // Maximum historical keys to keep (default: 10)
    rotation_interval_days: Option<u64>, // Auto-rotation schedule (if enabled)
    
    // Security settings
    key_encryption_algorithm: String,  // "AES-256-GCM"
    require_confirmation: bool,        // Require explicit approval (default: true)
    clock_drift_tolerance_seconds: u64, // Allow time skew (default: 300)
    
    // Monitoring
    verification_failure_threshold: u32, // Alert after N consecutive failures
    metrics_export_interval_seconds: u64,
    
    // Behavior
    enable_auto_rotation: bool,        // Allow scheduled rotation
    cleanup_retired_keys_after_seconds: Option<u64>, // Data retention policy
}

struct AuditLogEntry {
    timestamp: Timestamp,
    operation: RotationOperation,
    key_id: String,
    old_status: KeyStatus,
    new_status: KeyStatus,
    operator_id: String,
    success: bool,
    details: Option<String>,
}

enum RotationOperation {
    KeyRotationInitiated,
    KeyActivated,
    KeyTransitioned,
    KeyRetired,
    VerificationAttempted { success: bool },
    ConfigurationUpdated,
}
```

---

## Key State Transitions

### State Machine Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    KEY LIFECYCLE STATE MACHINE                  │
└─────────────────────────────────────────────────────────────────┘

                              ┌────────────────┐
                              │   Created      │
                              │ (in memory)    │
                              └────────┬───────┘
                                       │
                                       │ activate_key()
                                       ▼
                    ┌──────────────────────────────────┐
                    │   Active                         │
                    │ - Signs new webhooks            │
                    │ - Valid for verification         │
                    │ - Duration: implementation-dep   │
                    └──────────┬───────────────────────┘
                               │
                               │ rotate_key() [new key activated]
                               │ trigger timestamp recorded
                               ▼
                    ┌──────────────────────────────────┐
                    │   Transitional                   │
                    │ - No longer signs new webhooks  │
                    │ - Still valid for verification   │
                    │ - Duration: transition_period    │
                    └──────────┬───────────────────────┘
                               │
                               │ after transition_period_seconds
                               │ OR retire_key() called
                               ▼
                    ┌──────────────────────────────────┐
                    │   Retired                        │
                    │ - Not accepted for verification │
                    │ - May be deleted per policy      │
                    │ Duration: cleanup_retention      │
                    └──────────────────────────────────┘


KEY POINTS:
- Only ONE key can be Active at a time
- Multiple keys can be Transitional simultaneously
- State transitions are atomic and logged
- Never transitions: Created→Transitional (must go Active first)
- Retired keys can be deleted after retention period expires
```

---

## Rotation Workflow

### Complete Rotation Timeline

```
Timeline: Key Rotation Process

Time 0:00 - Operator initiates rotation
  │
  ├─ VALIDATION PHASE
  │  ├─ Verify new key material is cryptographically valid
  │  ├─ Verify new key ≠ any existing key (prevent duplicates)
  │  ├─ Verify at least one valid key exists
  │  └─ Generate new key_id (UUID)
  │
  ├─ CONFIRMATION PHASE
  │  ├─ Display rotation details to operator
  │  ├─ Require explicit confirmation
  │  └─ Log confirmation with operator_id
  │
  └─ PERSISTENCE PHASE
     ├─ Encrypt new key material with AES-256-GCM
     ├─ Store new key metadata with status=Active
     ├─ Mark previous Active key as Transitional
     ├─ Record rotated_at timestamp
     ├─ Persist configuration to durable storage
     └─ Emit WebhookKeyRotated event

Time 0:00 - 1:00 - TRANSITION PERIOD
  │
  ├─ Signing Phase
  │  └─ New webhooks signed ONLY with Active key
  │
  ├─ Verification Phase
  │  ├─ Signatures with Active key: verified immediately ✓
  │  ├─ Signatures with Transitional key: verified ✓
  │  ├─ Signatures with Retired key: rejected ✗
  │  └─ Verification includes key status in response
  │
  └─ Consumer Migration Phase
     └─ Consumers gradually update their verification keys

Time 1:00 - Transition period expires
  │
  ├─ Automatic Retirement
  │  ├─ Mark Transitional key as Retired
  │  ├─ Update expires_at timestamp
  │  ├─ Log retirement event
  │  └─ Emit WebhookKeyRetired event
  │
  └─ Post-Rotation
     ├─ New verification attempts with old key: rejected
     ├─ Consumers must have migrated by now
     └─ Key eligible for cleanup after retention period

Storage Timeline:
  Before:  [Key A (Active)]
  0:00:    [Key B (Active), Key A (Transitional)]
  1:00:    [Key B (Active), Key A (Retired)]
  2:00:    [Key B (Active)]  ← A deleted if retention expired
```

### Rotation Operations

#### Operation 1: Initiate Rotation

```
Input:
  new_key_material: String (hex or PEM)
  custom_transition_period: Option<u64>
  reason: Option<String>

Preconditions:
  1. Operator has rotation permission
  2. No rotation currently in progress
  3. At least one valid key exists
  4. new_key_material is cryptographically valid
  5. new_key_material is not identical to any existing key

Steps:
  1. Validate new key material format and strength
  2. If custom_transition_period provided:
       - Validate it's >= config.minimum_transition_period
       - Use custom period
     Else:
       - Use config.transition_period_seconds
  3. Display summary:
       - Current active key_id
       - New key_id (will be generated)
       - Transition period duration
       - Estimated retirement time
  4. Require operator confirmation (blocking)
  5. If NOT confirmed:
       - Log rejection
       - Return error
  6. If confirmed:
       - Encrypt new key material with current encryption key
       - Generate new key_id (UUID v4)
       - Create WebhookKey with:
         * status = Active
         * created_at = now
         * activated_at = now
         * expires_at = now + transition_period_seconds
       - Mark current Active key as Transitional
       - Mark current Active key expires_at unchanged (critical!)
       - Persist new configuration
       - Log RotationOperation.KeyRotationInitiated
       - Emit WebhookKeyRotated event
       - Return success with new key_id

Postconditions:
  - Exactly one Active key
  - Zero or more Transitional keys
  - New webhooks signed with new Active key
  - Old Transitional keys still valid for verification
  - Configuration persisted durably
```

#### Operation 2: Mark Key Retired (Manual)

```
Input:
  key_id: String
  reason: Option<String>

Preconditions:
  1. Operator has rotation permission
  2. key_id exists
  3. key.status ∈ [Active, Transitional]
  4. At least one other valid key will exist after retirement

Steps:
  1. Fetch key by key_id
  2. If key.status == Active:
       - Error: Cannot retire Active key
  3. If key.status == Retired:
       - Log already retired, return success
  4. If key.status == Transitional:
       - Set key.status = Retired
       - Set key.retired_at = now
       - Persist configuration
       - Log RotationOperation.KeyRetired
       - Emit WebhookKeyRetired event
       - Return success

Postconditions:
  - Key marked retired
  - Key no longer accepted for verification
  - At least one valid key remains
```

---

## Verification Logic

### Multi-Key Verification Algorithm

```
Function: VerifyWebhookSignature(payload, signature, timestamp) → Result<VerificationOutcome>

Input:
  payload: Bytes             // Webhook body
  signature: String          // HMAC or signature value
  timestamp: Timestamp       // When webhook was signed
  
Preconditions:
  1. At least one valid key exists
  2. signature and timestamp are provided
  3. payload is not empty

Algorithm:

  Step 1: Clock Skew Check
    │
    ├─ current_time = now()
    ├─ time_diff = abs(current_time - timestamp)
    │
    ├─ If time_diff > (config.clock_drift_tolerance_seconds + 10 min buffer):
    │    │
    │    └─ Return Error {
    │           code: KEY_EXPIRED,
    │           reason: "Signature timestamp too old",
    │           hint: "Check system clocks"
    │        }
    │
    └─ Continue

  Step 2: Get Valid Keys (in preference order)
    │
    ├─ valid_keys = []
    ├─ For each key in key_store:
    │    │
    │    ├─ If key.status ∈ [Active, Transitional]
    │    │    AND now() < key.expires_at:
    │    │    │
    │    │    └─ Add key to valid_keys
    │    │        (Active keys have higher priority)
    │    │
    │    └─ Continue
    │
    ├─ Sort valid_keys: [Active_keys..., Transitional_keys...]
    │
    ├─ If valid_keys is empty:
    │    │
    │    └─ Return Error {
    │           code: NO_VALID_KEYS,
    │           timestamp: now(),
    │           hint: "Contact operator - no keys available"
    │        }
    │
    └─ Continue

  Step 3: Attempt Verification (with constant-time comparison)
    │
    ├─ For each key in valid_keys (in order):
    │    │
    │    ├─ Decrypt key_material (AES-256-GCM)
    │    │
    │    ├─ expected_signature = compute_signature(payload, key_material, key.algorithm)
    │    │
    │    ├─ IF constant_time_compare(signature, expected_signature):
    │    │    │
    │    │    └─ Return Success {
    │    │           key_id: key.key_id,
    │    │           key_status: key.status,
    │    │           verified_at: now(),
    │    │           algorithm: key.algorithm,
    │    │           key_expires_at: key.expires_at,
    │    │           expires_in_seconds: key.expires_at - now()
    │    │        }
    │    │
    │    ├─ ELSE:
    │    │    │
    │    │    ├─ Clear temporary decrypted key_material from memory
    │    │    └─ Continue to next key
    │    │
    │    └─ Continue
    │
    └─ Continue

  Step 4: All Keys Failed
    │
    └─ Return Error {
           code: INVALID_SIGNATURE,
           reason: "Signature did not match any valid key",
           tried_keys: count(valid_keys),
           timestamp: now(),
           hint: "Check consumer's key configuration"
        }

Return Type: VerificationOutcome
  struct VerificationOutcome {
    key_id: String,
    key_status: KeyStatus,                    // For diagnostics
    verified_at: Timestamp,
    algorithm: KeyAlgorithm,
    key_expires_at: Timestamp,
    expires_in_seconds: u64,
  }

Performance Guarantees:
  - Total verification latency < 10ms (excluding network)
  - Constant-time comparison prevents timing attacks
  - Multiple keys do not degrade latency by > 5%
  - Memory cleanup after verification complete
```

### Decision Tree

```
Verify Webhook Signature
│
├─ Clock Skew Check
│  ├─ |now - timestamp| > tolerance?
│  │  └─ YES → REJECT (KEY_EXPIRED)
│  └─ NO → Continue
│
├─ Collect Valid Keys
│  ├─ status ∈ [Active, Transitional]?
│  │  └─ YES → Add to candidates
│  ├─ now() < expires_at?
│  │  └─ YES → Keep in candidates
│  └─ Any candidates?
│     ├─ NO → REJECT (NO_VALID_KEYS)
│     └─ YES → Continue
│
├─ Try Active Keys First
│  ├─ For each Active key (highest priority):
│  │  ├─ Decrypt key material
│  │  ├─ Compute expected signature
│  │  ├─ Constant-time compare
│  │  └─ MATCH?
│  │     ├─ YES → ACCEPT with key_status=Active
│  │     └─ NO → Continue
│  └─ All exhausted? → Continue
│
├─ Try Transitional Keys
│  ├─ For each Transitional key (lower priority):
│  │  ├─ Decrypt key material
│  │  ├─ Compute expected signature
│  │  ├─ Constant-time compare
│  │  └─ MATCH?
│  │     ├─ YES → ACCEPT with key_status=Transitional
│  │     └─ NO → Continue
│  └─ All exhausted? → Continue
│
└─ No Keys Matched
   └─ REJECT (INVALID_SIGNATURE)
```

---

## State Management

### Key Lifecycle State Transitions

The system maintains strict invariants for state transitions to prevent invalid states:

```rust
enum StateTransition {
    // Valid transitions
    CreatedToActive,       // New key becomes active during rotation
    ActiveToTransitional,  // Active key transitioned during new rotation
    TransitionalToRetired, // Transitional period expired
    TransitionalToRetired_Manual, // Operator manually retired early
    
    // Invalid transitions (rejected)
    ActiveToRetired,       // INVALID: Must go through Transitional
    CreatedToTransitional, // INVALID: Must be Active first
    RetiredToActive,       // INVALID: Cannot reactivate
}

/// Key Lifecycle Invariants
/// These conditions MUST always hold:

Invariant 1: Single Active Key
  len(keys where status == Active) == 1 ∨
  transition_in_progress() == true
  
Invariant 2: No Duplicate Keys
  ∀ key_i, key_j ∈ keys:
    key_i.key_id ≠ key_j.key_id ∧
    key_i.key_material ≠ key_j.key_material

Invariant 3: Timestamp Ordering
  ∀ key:
    key.created_at ≤ key.activated_at ≤
    key.expires_at ∧
    (key.retired_at is null ∨ key.expires_at ≤ key.retired_at)

Invariant 4: Status-Based Expiration
  status == Active → now() < expires_at
  status == Transitional → now() may be > expires_at (triggers retirement)
  status == Retired → always considered expired

Invariant 5: At Least One Valid Key
  ∃ key: key.status ∈ [Active, Transitional] ∧ now() < key.expires_at
```

### Atomic State Transitions

All state transitions must be atomic—either fully committed or fully rolled back:

```rust
impl KeyManager {
    fn rotate_key_atomic(
        &mut self,
        new_key_material: &[u8],
        custom_transition_period: Option<u64>,
    ) -> Result<KeyRotationResult> {
        // Begin transaction
        let transaction = self.storage.begin_transaction()?;
        
        // Phase 1: Prepare
        let new_key_id = Uuid::new_v4().to_string();
        let transition_period = custom_transition_period
            .unwrap_or(self.config.transition_period_seconds);
        
        let new_key = WebhookKey {
            key_id: new_key_id.clone(),
            key_material: self.encrypt_key_material(new_key_material)?,
            status: KeyStatus::Active,
            created_at: now(),
            activated_at: now(),
            expires_at: now() + Duration::seconds(transition_period as i64),
            // ... other fields
        };
        
        let current_active = transaction
            .find_key_by_status(KeyStatus::Active)?
            .ok_or(RotationError::NoActiveKey)?;
        
        // Phase 2: Validate invariants
        transaction.assert_single_active_key()?;
        transaction.assert_no_duplicate_keys(&new_key)?;
        
        // Phase 3: Update state
        transaction.mark_key_transitional(current_active.key_id.clone())?;
        transaction.insert_key(new_key.clone())?;
        
        // Phase 4: Write all-or-nothing
        transaction.commit()?; // ← Atomic commit point
        
        // Post-commit logging
        self.audit_log.record(AuditLogEntry {
            operation: RotationOperation::KeyRotationInitiated,
            // ... audit details
        })?;
        
        Ok(KeyRotationResult {
            new_key_id,
            previous_key_id: current_active.key_id,
            transition_period_seconds: transition_period,
        })
    }
}
```

---

## Concurrency Handling

### Race Condition Scenarios and Solutions

#### Scenario 1: In-Flight Webhook During Rotation

```
Timeline:
  T0:00 ─ Webhook generated with Active key A
  T0:01 ─ Key rotation initiated → Key A becomes Transitional, Key B becomes Active
  T0:02 ─ Webhook verification received
  T0:03 ─ Signature was created with Key A

Solution:
  ✓ Verification engine tries:
      1. Active key (Key B) - fails
      2. Transitional key (Key A) - succeeds ✓
  ✓ Webhook accepted
  ✓ Response includes key_status: "transitional" for diagnostics

Invariant Maintained:
  Both Active and Transitional keys valid for verification
```

#### Scenario 2: Verification During Exact Expiration Moment

```
Timeline:
  Key A expires_at = T1:00:00.000
  T0:59:59.999 ─ Verification request arrives with Key A
  T1:00:00.001 ─ Expiration check evaluated

Solution:
  1. Clock drift tolerance: config.clock_drift_tolerance_seconds (default 5 min)
  2. Additional buffer: +10 seconds for precision tolerance
  3. Actual tolerance window: ±5 minutes + 10 seconds
  
  Comparison: expires_at - now() > tolerance?
  ✓ Allows keys to remain valid through legitimate clock variance
  ✗ Prevents "zombie" keys from being accepted indefinitely

Edge Case Handling:
  - System clock moves backward: Detected and logged as "clock skew anomaly"
  - NTP sync events: Momentary tolerance increase during sync
```

#### Scenario 3: Concurrent Rotation Attempts

```
Timeline:
  T0:00 ─ Operator A initiates rotation
  T0:00.050 ─ Operator B attempts rotation (simultaneous)

Solution:
  Mutual exclusion lock on key store:
  
  T0:00.000 ─ Operator A: lock_acquired()
  T0:00.001 ─ Operator B: lock_acquire_attempt() → BLOCKED
  T0:00.500 ─ Operator A: rotation_complete(), lock_released()
  T0:00.501 ─ Operator B: lock_acquired()
  T0:00.502 ─ Operator B: rotation_complete(), lock_released()
  
  Result: Sequential execution, both complete successfully

Error Handling:
  If Operator B can't acquire lock within timeout (5 seconds):
    Return error: RotationInProgress { 
      current_operator: A,
      estimated_completion: T0:00.500
    }
```

#### Scenario 4: Crash During Rotation

```
State Before Crash:
  Key A: Active
  Key B: transitional (from previous rotation)

Crash Occurs At:
  T0:00.300 - After validation, before persistence

Recovery On Restart:
  1. Load persisted configuration
  2. Find incomplete transaction (key state inconsistent)
  3. Invariant check: Single Active key missing?
     → YES: Likely crash during transition
  4. Recovery strategy:
     a. Load last known good state
     b. If Key B was mid-transition:
        - Restore Key A as Active
        - Mark Key B as transitional (with original timeline)
     c. Persist recovered state
  5. Log: "Recovered from crash, rotation status unknown"
  6. Operator must verify and retry

Guarantee:
  ✓ Never enters invalid state (multiple Active keys)
  ✓ Previous state fully recoverable
  ✓ No key material loss
```

### Concurrency Safety Properties

```rust
// Concurrency guarantees maintained by the system:

1. Serializable State Transitions
   - All key state changes execute serially
   - No interleaving of partial transitions
   - Achieved via transactional storage

2. Safe Memory Access
   - Encrypted key material never exposed to race conditions
   - Decryption happens in isolated scope
   - Temporary decrypted keys cleared before next iteration

3. Atomic Verification
   - Each verification is independent and doesn't affect others
   - Concurrent verifications don't interfere
   - Key state read at verification start doesn't change mid-verification

4. Safe Restart
   - Key state persisted before operation completes
   - Configuration loaded atomically on startup
   - No partial rotations visible after recovery
```

---

## Secure Key Storage

### Encryption Strategy

```
Layer 1: Key Material Encryption (At Rest)
  │
  ├─ Algorithm: AES-256-GCM
  ├─ Mode: Galois/Counter Mode (authenticated encryption)
  ├─ Key Derivation:
  │   ├─ Master key: Stored securely (HSM, cloud vault, or generated at startup)
  │   ├─ Per-key IV: Random 96-bit nonce (stored with ciphertext)
  │   ├─ Associated data: key_id || algorithm || created_at
  │   └─ Authentication tag: Validates integrity and authenticity
  │
  └─ Result: Encrypted key material + IV + auth tag


Layer 2: Memory Protection (In Use)
  │
  ├─ Allocation:
  │   ├─ Use secure allocator (zeroize on drop)
  │   ├─ Allocate exactly needed size (no buffers)
  │   ├─ Pin to prevent page swapping
  │
  ├─ Usage:
  │   ├─ Decrypt immediately before use
  │   ├─ Keep decrypted key in narrowest scope
  │   ├─ Use only for immediate verification
  │
  ├─ Cleanup:
  │   ├─ Overwrite with zeros before freeing
  │   ├─ Use volatile writes to prevent compiler optimization
  │   ├─ Verify cleanup in tests
  │
  └─ Example:
      struct SecureKey {
          material: Zeroize<Vec<u8>>,  // Auto-zeros on drop
      }
      
      let key = decrypt_key(encrypted)?;  // In volatile scope
      let result = verify_signature(&key, payload)?;
      drop(key);  // Auto-zeros memory


Layer 3: Logging Protection
  │
  ├─ NEVER log key_material
  ├─ NEVER log decrypted key in any form
  ├─ DO log:
  │   ├─ key_id (safe identifier)
  │   ├─ key_hash (truncated SHA-256 of material for diagnostics)
  │   ├─ operations performed (rotate, verify)
  │   └─ timestamps and actors
  │
  └─ Example Audit Log:
      {
        "timestamp": "2024-01-15T10:30:00Z",
        "operation": "verify_webhook",
        "key_id": "k_abc123def456",
        "key_status": "transitional",
        "result": "success",
        "operator": "system"
      }


Layer 4: Persistent Storage
  │
  ├─ File System:
  │   ├─ File permissions: 600 (owner read/write only)
  │   ├─ Filesystem encryption: LUKS/BitLocker/FileVault recommended
  │   ├─ Stored format: JSON with base64-encoded encrypted material
  │
  ├─ Database:
  │   ├─ Column encryption: Encrypt at application level
  │   ├─ Connection encryption: TLS for all connections
  │   ├─ Access control: Row-level security, audit triggers
  │
  ├─ Cloud Vault (Recommended):
  │   ├─ AWS Secrets Manager / Azure Key Vault / Vault
  │   ├─ HSM-backed encryption
  │   ├─ Automatic rotation support
  │   ├─ Audit logging integrated
  │
  └─ Backup:
      ├─ Backups encrypted at rest (same algorithm)
      ├─ Backup access restricted to qualified admins
      ├─ Separate encryption keys for production/backup
```

### Constant-Time Comparison

```rust
/// Constant-time signature comparison
/// Prevents timing-based key recovery attacks
///
/// Standard approach (VULNERABLE):
///   if computed == provided { success } // Time varies with first mismatch
///
/// Constant-time approach (SECURE):
///   All bytes compared regardless of earlier mismatches

use subtle::ConstantTimeComparison;

fn verify_signature_secure(
    computed_sig: &[u8],
    provided_sig: &[u8],
) -> Result<(), SignatureError> {
    // Constant-time comparison
    if computed_sig.ct_eq(provided_sig).into() {
        Ok(())
    } else {
        Err(SignatureError::InvalidSignature)
    }
}

// Security property verified by timing analysis:
// - Execution time independent of where signatures diverge
// - Time ≈ constant regardless of match position
// - Resistant to differential power analysis
```

### Key Rotation Secure Erase

```
Old Key Erase Process:
  
  Step 1: Mark Key as Transitional
    └─ Set status field (safe metadata update)
  
  Step 2: Transition Period Tracking
    └─ Keep encrypted key_material in storage (protected by AES-256)
  
  Step 3: After Transition Period
    └─ Mark Key as Retired (safe metadata update)
  
  Step 4: After Retention Period Expires (default: 1 year)
    ├─ Fetch encrypted key_material from storage
    ├─ Option A - Overwrite: Write random bytes to storage location
    ├─ Option B - Delete: Remove key record entirely
    ├─ Option C - Archive: Move to secure archive with compliance hold
    └─ Log: "Key material securely erased: key_id"
  
  Step 5: Verification
    ├─ Confirm key_id not accessible
    ├─ Confirm storage reclaimed (if deleted)
    ├─ Confirm no residual key_material accessible
    └─ Log verification complete

Compliance Considerations:
  - GDPR: Right to be forgotten (can force immediate erase)
  - HIPAA: Maintain audit trail of erasure
  - SOC2: Document erasure procedure and verification
  - PCI DSS: Cryptographic erasure acceptable if HSM-backed
```

---

## API and Interface Design

### REST API Endpoints

```
╔════════════════════════════════════════════════════════════════╗
║              WEBHOOK KEY ROTATION REST API                    ║
╚════════════════════════════════════════════════════════════════╝

1. INITIATE ROTATION
─────────────────────────
POST /webhooks/keys/rotate

Request:
{
  "key_material": "hex_string_or_pem",
  "transition_period_seconds": 3600,  // optional, default from config
  "reason": "scheduled_rotation",      // optional
  "confirm": false
}

Response (Confirmation Required):
Status: 202 Accepted
{
  "rotation_id": "rot_abc123",
  "status": "awaiting_confirmation",
  "details": {
    "current_active_key_id": "k_xyz789",
    "new_key_id": "k_new123",
    "transition_period_seconds": 3600,
    "estimated_retirement_time": "2024-01-15T11:30:00Z"
  },
  "confirmation_url": "/webhooks/keys/rotate/rot_abc123/confirm"
}

Response (After Confirmation):
Status: 200 OK
{
  "rotation_id": "rot_abc123",
  "status": "completed",
  "new_key_id": "k_new123",
  "previous_key_id": "k_xyz789",
  "transition_period_seconds": 3600,
  "active_until": "2024-01-15T11:30:00Z",
  "webhook_signed_with": "k_new123"
}

Errors:
  Status: 400 Bad Request
  {
    "error_code": "INVALID_KEY_MATERIAL",
    "message": "Key material is not valid...",
    "suggestion": "Ensure key is in PEM or hex format"
  }
  
  Status: 409 Conflict
  {
    "error_code": "ROTATION_IN_PROGRESS",
    "message": "Another rotation is already in progress",
    "current_operator": "user_123",
    "estimated_completion": "2024-01-15T10:25:00Z"
  }

Security:
  - Requires: Authorization header with valid JWT/API key
  - Scope required: webhooks:rotate
  - Rate limited: 1 rotation per 5 minutes max
  - Logged: All rotation attempts (success and failure)


2. CONFIRM ROTATION
───────────────────
POST /webhooks/keys/rotate/{rotation_id}/confirm

Request:
{
  "operator_confirmation": true,
  "confirmation_token": "tok_xyz..."  // Optional, from previous response
}

Response:
Status: 200 OK
{
  "status": "completed",
  "new_key_id": "k_new123",
  "activated_at": "2024-01-15T10:30:00Z",
  "expires_at": "2024-01-15T11:30:00Z"
}

Errors:
  Status: 404 Not Found
  { "error_code": "ROTATION_NOT_FOUND" }
  
  Status: 410 Gone
  { "error_code": "ROTATION_EXPIRED", "reason": "confirmation expired after 5 minutes" }


3. LIST ALL KEYS
────────────────
GET /webhooks/keys

Query Parameters:
  - status: "active|transitional|retired" (optional filter)
  - include_history: true/false (default: true)
  - limit: 50 (default)
  - offset: 0 (default)

Response:
Status: 200 OK
{
  "keys": [
    {
      "key_id": "k_abc123",
      "status": "active",
      "algorithm": "HMAC-SHA256",
      "created_at": "2024-01-15T10:00:00Z",
      "activated_at": "2024-01-15T10:30:00Z",
      "expires_at": "2024-01-16T10:30:00Z",
      "expires_in_seconds": 85800,
      "rotation_reason": "scheduled_rotation"
    },
    {
      "key_id": "k_xyz789",
      "status": "transitional",
      "algorithm": "HMAC-SHA256",
      "created_at": "2024-01-14T10:00:00Z",
      "activated_at": "2024-01-14T10:30:00Z",
      "expires_at": "2024-01-15T10:30:00Z",
      "expires_in_seconds": -3600,  // Already expired
      "retired_at": "2024-01-15T10:30:00Z",
      "rotation_reason": "manual_rotation"
    }
  ],
  "pagination": {
    "total": 2,
    "limit": 50,
    "offset": 0
  }
}

Security:
  - Requires: Authorization header
  - Scope required: webhooks:read


4. GET KEY DETAILS
──────────────────
GET /webhooks/keys/{key_id}

Response:
Status: 200 OK
{
  "key_id": "k_abc123",
  "status": "active",
  "algorithm": "HMAC-SHA256",
  "created_at": "2024-01-15T10:00:00Z",
  "activated_at": "2024-01-15T10:30:00Z",
  "expires_at": "2024-01-16T10:30:00Z",
  "expires_in_seconds": 85800,
  "rotation_reason": "scheduled_rotation",
  "rotation_trigger": "manual",
  "operator_id": "op_user_123"
}

Security:
  - Does NOT return key_material
  - Does NOT return key_hash


5. VERIFY WEBHOOK SIGNATURE
────────────────────────────
POST /webhooks/verify

Request:
{
  "payload": "base64_encoded_webhook_body",
  "signature": "hmac_or_signature_value",
  "timestamp": "2024-01-15T10:30:00Z",
  "algorithm": "HMAC-SHA256"  // optional, defaults to configured
}

Response (Success):
Status: 200 OK
{
  "valid": true,
  "key_id": "k_abc123",
  "key_status": "active",
  "verified_at": "2024-01-15T10:30:05Z",
  "algorithm": "HMAC-SHA256",
  "expires_in_seconds": 85795
}

Response (Failure - Invalid Signature):
Status: 401 Unauthorized
{
  "valid": false,
  "error_code": "INVALID_SIGNATURE",
  "message": "Signature did not match any valid key",
  "tried_keys": 3,
  "timestamp": "2024-01-15T10:30:05Z"
}

Response (Failure - Key Expired):
Status: 401 Unauthorized
{
  "valid": false,
  "error_code": "KEY_EXPIRED",
  "message": "Signature created with an expired key",
  "key_id": "k_old789",
  "expired_at": "2024-01-15T09:30:00Z",
  "expired_seconds_ago": 3600,
  "timestamp": "2024-01-15T10:30:05Z"
}

Response (Failure - No Valid Keys):
Status: 503 Service Unavailable
{
  "valid": false,
  "error_code": "NO_VALID_KEYS",
  "message": "System has no valid keys for verification",
  "timestamp": "2024-01-15T10:30:05Z",
  "contact": "support@..."
}

Security:
  - Public endpoint (no authentication required for verification)
  - Rate limited: 100 requests per second
  - Does not leak information about attempted key_ids
  - Timing-constant comparison
  - Logged for audit trail


6. GET ACTIVE KEY INFO
──────────────────────
GET /webhooks/keys/active

Response:
Status: 200 OK
{
  "key_id": "k_abc123",
  "algorithm": "HMAC-SHA256",
  "created_at": "2024-01-15T10:00:00Z",
  "activated_at": "2024-01-15T10:30:00Z",
  "expires_at": "2024-01-16T10:30:00Z",
  "expires_in_seconds": 85800
}

Security:
  - Public endpoint for diagnostics
  - Does not return key_material


7. GET ROTATION HISTORY
────────────────────────
GET /webhooks/keys/history

Query Parameters:
  - limit: 100 (default)
  - offset: 0 (default)
  - start_time: ISO8601 (optional)
  - end_time: ISO8601 (optional)

Response:
Status: 200 OK
{
  "history": [
    {
      "timestamp": "2024-01-15T10:30:00Z",
      "operation": "KeyRotationInitiated",
      "key_id": "k_abc123",
      "old_status": "pending",
      "new_status": "active",
      "operator_id": "op_user_123",
      "success": true,
      "details": "Rotation completed successfully"
    },
    {
      "timestamp": "2024-01-15T09:30:00Z",
      "operation": "KeyRetired",
      "key_id": "k_xyz789",
      "old_status": "transitional",
      "new_status": "retired",
      "operator_id": "system",
      "success": true,
      "details": "Transition period expired"
    }
  ],
  "pagination": {
    "total": 2,
    "limit": 100,
    "offset": 0
  }
}

Security:
  - Requires: Authorization header
  - Scope required: webhooks:audit
  - Immutable: History records cannot be modified


8. HEALTH CHECK
────────────────
GET /webhooks/health

Response:
Status: 200 OK
{
  "status": "healthy",
  "active_key_id": "k_abc123",
  "keys_available": 2,
  "active_keys": 1,
  "transitional_keys": 1,
  "retired_keys": 0,
  "next_retirement": "2024-01-15T11:30:00Z",
  "verification_success_rate": 0.9999,
  "verification_failure_count": 1,
  "last_rotation": "2024-01-15T10:30:00Z",
  "up_time_seconds": 86400
}

Response (Degraded):
Status: 200 OK
{
  "status": "degraded",
  "warnings": [
    "Active key expires in 1 hour",
    "Verification failure rate elevated (0.5%)"
  ]
}

Response (Critical):
Status: 503 Service Unavailable
{
  "status": "critical",
  "errors": [
    "No valid keys available",
    "Configuration corrupted"
  ]
}

Security:
  - Public endpoint for monitoring
  - No sensitive key material revealed
```

### Programmatic Interface

```rust
/// High-level Rust API for key rotation

pub trait WebhookKeyManager {
    /// Initiate a new key rotation
    async fn rotate_key(
        &mut self,
        new_key_material: &[u8],
        transition_period: Option<Duration>,
    ) -> Result<KeyRotationResult>;
    
    /// Confirm a pending rotation
    async fn confirm_rotation(
        &self,
        rotation_id: &str,
    ) -> Result<KeyRotationDetails>;
    
    /// Get current active key (metadata only)
    async fn get_active_key(&self) -> Result<KeyMetadata>;
    
    /// List all keys
    async fn list_keys(
        &self,
        status_filter: Option<KeyStatus>,
    ) -> Result<Vec<KeyMetadata>>;
    
    /// Verify a webhook signature
    async fn verify_signature(
        &self,
        payload: &[u8],
        signature: &str,
        timestamp: Timestamp,
    ) -> Result<VerificationOutcome>;
    
    /// Get rotation history
    async fn get_history(
        &self,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<AuditLogEntry>>;
    
    /// Health check
    async fn health_check(&self) -> Result<HealthStatus>;
}

// Example usage:
let mut key_manager = WebhookKeyManager::new(config)?;

// Rotate key
let result = key_manager
    .rotate_key(new_key_bytes, Some(Duration::hours(1)))
    .await?;

println!("Rotation ID: {}", result.rotation_id);
println!("Please confirm at: {}", result.confirmation_url);

// Confirm rotation
let confirmed = key_manager.confirm_rotation(&result.rotation_id).await?;
println!("Rotation confirmed! New key: {}", confirmed.new_key_id);

// Verify a webhook
let outcome = key_manager
    .verify_signature(&payload, &signature, timestamp)
    .await?;

println!("Verified with key: {}", outcome.key_id);
println!("Key status: {:?}", outcome.key_status);
```

---

## Error Handling

### Error Codes and Meanings

```
VERIFICATION ERRORS:
─────────────────────

1. INVALID_SIGNATURE
   Code: 4001
   HTTP: 401 Unauthorized
   Meaning: Signature doesn't match any valid key
   Cause: Wrong key used by consumer, or payload was modified
   Action: Verify consumer using correct active key
   Logged: Yes, with key_id attempts
   
2. KEY_EXPIRED
   Code: 4002
   HTTP: 401 Unauthorized
   Meaning: Signature was created with a retired key
   Cause: Transition period expired, consumer didn't update
   Action: Consumer must update to new key from operator
   Timestamp: Included (when key expired)
   Logged: Yes, for compliance audits
   
3. NO_VALID_KEYS
   Code: 5001
   HTTP: 503 Service Unavailable
   Meaning: System has no keys available for verification
   Cause: Configuration error, all keys retired
   Action: Operator must immediately add valid key
   Severity: CRITICAL - service degraded
   Logged: Yes, with escalation alert


ROTATION ERRORS:
────────────────

4. ROTATION_IN_PROGRESS
   Code: 4091
   HTTP: 409 Conflict
   Meaning: Another rotation is already executing
   Cause: Concurrent rotation attempts
   Action: Wait for first rotation to complete, retry
   Estimated Wait: Included in response
   Logged: Yes
   
5. INVALID_KEY_MATERIAL
   Code: 4002
   HTTP: 400 Bad Request
   Meaning: New key material is not cryptographically valid
   Cause: Malformed key, wrong format, insufficient entropy
   Action: Verify key format and regenerate if needed
   Suggestion: Provided in error response
   Logged: Yes, without key details
   
6. DUPLICATE_KEY
   Code: 4003
   HTTP: 400 Bad Request
   Meaning: New key is identical to an existing key
   Cause: Attempting to "rotate" to same key
   Action: Generate a new key and retry
   Logged: Yes
   
7. NO_CONFIRMATION
   Code: 4004
   HTTP: 400 Bad Request
   Meaning: Rotation requires explicit confirmation
   Cause: confirm parameter not set or token not provided
   Action: Review rotation details and confirm
   Logged: Yes
   
8. INVALID_TRANSITION_PERIOD
   Code: 4005
   HTTP: 400 Bad Request
   Meaning: Transition period below minimum or invalid
   Cause: transition_period_seconds < minimum_allowed
   Action: Use default or increase to minimum
   Min value: Included in error response
   Logged: Yes
   
9. CANNOT_RETIRE_ACTIVE_KEY
   Code: 4006
   HTTP: 400 Bad Request
   Meaning: Attempted to manually retire the active key
   Cause: Active key cannot be retired early
   Action: Wait for next rotation or rotate manually
   Logged: Yes
   
10. WOULD_HAVE_ZERO_VALID_KEYS
    Code: 4007
    HTTP: 400 Bad Request
    Meaning: Operation would leave system with no valid keys
    Cause: Attempting to retire only remaining key
    Action: Add new key before retiring old one
    Invariant: System never has zero valid keys
    Logged: Yes, with severity CRITICAL


SYSTEM ERRORS:
───────────────

11. STORAGE_ERROR
    Code: 5002
    HTTP: 500 Internal Server Error
    Meaning: Could not read/write key configuration
    Cause: Database down, filesystem full, permission issue
    Action: Check storage system, retry
    Logged: Yes, with detailed error info
    Severity: HIGH
    
12. ENCRYPTION_ERROR
    Code: 5003
    HTTP: 500 Internal Server Error
    Meaning: Could not encrypt/decrypt key material
    Cause: Encryption key missing, algorithm mismatch
    Action: Check HSM/vault connection, restart service
    Logged: Yes, without key material
    Severity: CRITICAL
    
13. CONFIGURATION_CORRUPT
    Code: 5004
    HTTP: 500 Internal Server Error
    Meaning: Key configuration failed integrity check
    Cause: File corruption, manual edits, database corruption
    Action: Restore from backup or rebuild
    Logged: Yes, with validation errors
    Severity: CRITICAL
    
14. CLOCK_SKEW_DETECTED
    Code: 5005
    HTTP: 503 Service Unavailable
    Meaning: System detected excessive clock drift
    Cause: NTP not running, system clock adjusted
    Action: Sync system clocks to NTP
    Tolerance: ±5 minutes + 10 second buffer
    Logged: Yes
    Severity: MEDIUM


AUTHORIZATION ERRORS:
──────────────────────

15. INSUFFICIENT_PERMISSION
    Code: 4031
    HTTP: 403 Forbidden
    Meaning: User lacks permission for operation
    Cause: User doesn't have webhooks:rotate scope
    Action: Request elevated permissions
    Logged: Yes, with audit trail
    
16. INVALID_AUTHENTICATION
    Code: 4011
    HTTP: 401 Unauthorized
    Meaning: Authentication token invalid or missing
    Cause: Missing/expired token, invalid signature
    Action: Provide valid JWT or API key
    Logged: Yes
```

### Edge Case Handling

```
EDGE CASE 1: Consumer Delays Verification Beyond Transition Period
─────────────────────────────────────────────────────────────────────

Scenario:
  - Webhook generated at T0:00 with Key A (still Active)
  - Key rotated at T0:05 (Key A → Transitional, Key B → Active)
  - Transition period: 1 hour
  - Verification attempted at T1:05 (1 hour 5 minutes later)
  - Signature still with Key A

Expected Behavior:
  ✗ Rejection with error code: KEY_EXPIRED
  ✓ Include: When Key A expired, when verification occurred
  ✓ Provide: Action for consumer (update to Key B)
  ✓ Log: Diagnostic info for audit trail

Implementation:
  if (now() > key.expires_at + grace_period) {
      return Err(KeyExpired {
          key_id: key.key_id,
          expired_at: key.expires_at,
          expired_seconds_ago: now() - key.expires_at,
      })
  }


EDGE CASE 2: Rotation with Zero Transition Period
────────────────────────────────────────────────────

Scenario:
  - Operator configures transition_period_seconds = 0
  - Immediate rotation with no grace period

Expected Behavior:
  ⚠️ WARNING: Not recommended, breaks backward compatibility
  ✓ Allow rotation if explicitly confirmed with warning
  ✓ Existing webhooks with old key immediately fail
  ✓ All verification must use new key

Implementation:
  if (transition_period == 0) {
      confirm_message += "\nWARNING: Old keys will be retired immediately. \
          Any in-flight webhooks signed with old keys will fail verification."
  }


EDGE CASE 3: Multiple Transitional Keys Simultaneously
─────────────────────────────────────────────────────────

Scenario:
  - Rotation A: Key A → Transitional (1:00 expiration)
  - Rotation B: Key B → Transitional (2:00 expiration)
  - Rotation C: Key C → Active (current)
  - Verification at 1:30

Webhook Signed With:
  ✓ Key A: Accepted (still in Transitional, expires 1:00 hasn't passed)
  ✗ Key B: Accepted (still in Transitional, expires 2:00)
  ✓ Key C: Accepted (Active)
  ✗ Retired Key: Rejected

Expected Behavior:
  ✓ All Transitional keys honored until individual expiration
  ✓ Verification latency stays < 10ms despite multiple keys
  ✓ Each key maintains independent expiration

Implementation:
  valid_keys = keys.filter(|k| {
      (k.status == Active || k.status == Transitional) &&
      now() < k.expires_at
  }).sort_by(|a, b| {
      // Active keys first, then by creation time
      match (&a.status, &b.status) {
          (Active, Transitional) => Ordering::Less,
          (Transitional, Active) => Ordering::Greater,
          _ => b.created_at.cmp(&a.created_at)
      }
  });


EDGE CASE 4: System Clock Moves Backward
───────────────────────────────────────────

Scenario:
  - NTP sync causes system clock to move backward 2 hours
  - Key expired 1 hour ago by new clock, but still "future" by old clock

Expected Behavior:
  ✓ Detect clock skew (abs(clock_delta) > threshold)
  ⚠️ Log: "Clock skew detected: backward 2 hours"
  ✓ Temporarily increase tolerance to ±30 minutes
  ✓ Emit alert for operator investigation
  ✓ Re-sync NTP and verify consistency

Implementation:
  let now = SystemTime::now();
  let drift = abs(now - last_timestamp);
  
  if (drift > MAX_ACCEPTABLE_DRIFT) {
      log_alert!("Clock skew detected: {:?}", drift);
      emit_metric!("clock_skew_seconds", drift.as_secs());
      
      // Temporarily increase tolerance
      clock_tolerance = config.clock_drift_tolerance + Duration::minutes(25);
      
      // Trigger operator alert
      trigger_alert!("SystemClockAnomalySuspected");
  }


EDGE CASE 5: Storage Unavailable During Rotation
──────────────────────────────────────────────────

Scenario:
  - Database goes offline during rotation
  - State change partially written

Expected Behavior:
  ✓ Detect transaction failure
  ✗ Abort rotation cleanly
  ✓ Rollback all changes atomically
  ✓ Previous key remains Active and unchanged
  ✓ Return error to operator with retry guidance

Implementation:
  match transaction.commit() {
      Ok(_) => success(),
      Err(StorageError::Unavailable) => {
          transaction.rollback()?;
          log_error!("Storage unavailable, rolling back rotation");
          return Err(RotationError::StorageUnavailable {
              message: "Could not persist rotation. Previous state restored.",
              retry_after: Duration::seconds(30),
          });
      }
      Err(e) => {
          transaction.rollback()?;
          return Err(RotationError::from(e));
      }
  }


EDGE CASE 6: Operator Attempts Duplicate Rotation
────────────────────────────────────────────────────

Scenario:
  - Operator initiates rotation with Key X
  - Realizes mistake, attempts to rotate to same Key X

Expected Behavior:
  ✗ Reject with error: DUPLICATE_KEY
  ✓ Explain: Key already exists in system
  ✓ Suggest: Generate new key instead

Implementation:
  for existing_key in key_store.iter() {
      if constant_time_compare(
          &existing_key.material_hash,
          &new_key.material_hash
      ) {
          return Err(RotationError::DuplicateKey {
              key_id: existing_key.key_id,
              status: existing_key.status,
          });
      }
  }


EDGE CASE 7: Concurrent Verification During Rotation
────────────────────────────────────────────────────────

Scenario:
  Thread A: verify_signature() reads Active key
  Thread B: rotate_key() changes Active key
  Thread A: Still using old key for verification

Expected Behavior:
  ✓ Thread A uses snapshot of key state from beginning
  ✓ Verification either fully succeeds or fails
  ✗ No partial state reads
  ✓ No race condition between snapshot and usage

Implementation (using RwLock):
  let key_snapshot = {
      let lock = self.keys.read()?;  // Read lock acquired
      lock.clone()                    // Snapshot all keys
  };                                  // Read lock released
  
  // Now safe to verify without holding lock
  verify_with_snapshot(&key_snapshot, payload, signature)?
```

---

## Testing Strategy

### Unit Testing

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // Key Creation and Storage Tests
    #[test]
    fn test_key_creation_generates_unique_ids() {
        let key1 = WebhookKey::new(key_material_1)?;
        let key2 = WebhookKey::new(key_material_2)?;
        assert_ne!(key1.key_id, key2.key_id);
    }

    #[test]
    fn test_key_material_encrypted_at_rest() {
        let key = WebhookKey::new(key_material)?;
        assert!(key.key_material.is_encrypted());
        assert_ne!(key.key_material.as_bytes(), key_material);
    }

    #[test]
    fn test_key_metadata_populated_correctly() {
        let key = WebhookKey::new(key_material)?;
        assert!(key.created_at.is_recent());
        assert_eq!(key.status, KeyStatus::Active);
    }

    // State Transition Tests
    #[test]
    fn test_state_transition_active_to_transitional() {
        let mut key = WebhookKey::new(key_material)?;
        key.mark_transitional()?;
        assert_eq!(key.status, KeyStatus::Transitional);
    }

    #[test]
    fn test_state_transition_invalid_active_to_retired() {
        let mut key = WebhookKey::new(key_material)?;
        assert!(key.mark_retired().is_err());  // Can't skip Transitional
    }

    #[test]
    fn test_single_active_key_invariant() {
        let mut manager = KeyManager::new(config)?;
        let key1 = manager.add_key(material1)?;
        key1.mark_active()?;
        
        let key2 = manager.add_key(material2)?;
        assert!(key2.mark_active().is_err());  // Violates invariant
    }

    // Rotation Tests
    #[test]
    fn test_rotation_requires_confirmation() {
        let mut manager = KeyManager::new(config)?;
        let result = manager.rotate_key(new_material, false)?;
        assert_eq!(result.status, RotationStatus::AwaitingConfirmation);
    }

    #[test]
    fn test_rotation_rejects_duplicate_key() {
        let mut manager = KeyManager::new(config)?;
        let _ = manager.rotate_key(material1, true)?;
        assert!(manager.rotate_key(material1, true).is_err());
    }

    #[test]
    fn test_rotation_prevents_zero_valid_keys() {
        let mut manager = KeyManager::with_single_key(config)?;
        // Attempting to retire only key should fail
        assert!(manager.retire_all_keys().is_err());
    }

    // Verification Tests
    #[test]
    fn test_verify_with_active_key_succeeds() {
        let manager = KeyManager::new(config)?;
        let payload = b"test payload";
        let signature = manager.sign_payload(payload)?;
        
        assert!(manager.verify_payload(payload, &signature).is_ok());
    }

    #[test]
    fn test_verify_with_transitional_key_succeeds() {
        let mut manager = KeyManager::new(config)?;
        
        // Sign with original key
        let original_key_id = manager.get_active_key_id();
        let payload = b"test payload";
        let signature = manager.sign_payload(payload)?;
        
        // Rotate to new key
        manager.rotate_key(new_material, true)?;
        
        // Old key is now transitional
        let result = manager.verify_payload(payload, &signature)?;
        assert_eq!(result.key_status, KeyStatus::Transitional);
    }

    #[test]
    fn test_verify_with_retired_key_fails() {
        let mut manager = KeyManager::new(config)?;
        let payload = b"test payload";
        let signature = manager.sign_payload(payload)?;
        
        // Rotate and wait for transition
        manager.rotate_key(new_material, true)?;
        manager.advance_time(Duration::hours(2))?;
        
        // Old key is now retired
        let result = manager.verify_payload(payload, &signature);
        assert!(result.is_err());
        assert_eq!(result.error_code, ErrorCode::KeyExpired);
    }

    #[test]
    fn test_verify_with_invalid_signature_fails() {
        let manager = KeyManager::new(config)?;
        let payload = b"test payload";
        let wrong_signature = "invalid_signature";
        
        let result = manager.verify_payload(payload, wrong_signature);
        assert!(result.is_err());
        assert_eq!(result.error_code, ErrorCode::InvalidSignature);
    }

    #[test]
    fn test_verify_with_modified_payload_fails() {
        let manager = KeyManager::new(config)?;
        let original_payload = b"test payload";
        let signature = manager.sign_payload(original_payload)?;
        
        let modified_payload = b"modified payload";
        let result = manager.verify_payload(modified_payload, &signature);
        assert!(result.is_err());
    }

    // Security Tests
    #[test]
    fn test_key_material_not_logged() {
        let manager = KeyManager::new(config)?;
        let logs = capture_logs(|| {
            let _ = manager.rotate_key(new_material, true);
        });
        
        for log in logs {
            assert!(!log.contains(&hex::encode(new_material)));
        }
    }

    #[test]
    fn test_constant_time_comparison_resists_timing_attack() {
        let manager = KeyManager::new(config)?;
        let payload = b"test";
        let signature = manager.sign_payload(payload)?;
        
        // Time verification with correct signature
        let start = Instant::now();
        let _ = manager.verify_payload(payload, &signature);
        let time_correct = start.elapsed();
        
        // Time verification with wrong signature
        let start = Instant::now();
        let _ = manager.verify_payload(payload, "wrong_signature");
        let time_wrong = start.elapsed();
        
        // Timing should be similar (within 1ms)
        assert!((time_correct.as_micros() as i64 - time_wrong.as_micros() as i64).abs() < 1000);
    }

    // Configuration Tests
    #[test]
    fn test_transition_period_enforced() {
        let config = RotationConfig {
            transition_period_seconds: 3600,
            ..Default::default()
        };
        let mut manager = KeyManager::new(config)?;
        
        manager.rotate_key(new_material, true)?;
        
        // Check expiration timestamp
        let active_key = manager.get_active_key()?;
        assert_eq!(
            active_key.expires_at,
            active_key.activated_at + Duration::seconds(3600)
        );
    }

    #[test]
    fn test_minimum_transition_period_enforced() {
        let mut manager = KeyManager::new(config)?;
        let result = manager.rotate_key_with_period(
            new_material,
            Duration::seconds(60),  // Less than minimum
            true
        );
        assert!(result.is_err());
    }

    // Edge Case Tests
    #[test]
    fn test_clock_skew_detection() {
        let manager = KeyManager::new(config)?;
        
        // Simulate clock moving backward
        manager.set_system_time(now() - Duration::hours(2))?;
        
        // Should log alert
        let alerts = manager.capture_alerts();
        assert!(alerts.iter().any(|a| a.contains("clock")));
    }

    #[test]
    fn test_recovery_from_partial_rotation_crash() {
        let mut manager = KeyManager::with_persistent_storage()?;
        
        // Start rotation but don't complete
        manager.begin_rotation(new_material)?;
        
        // Simulate crash and restart
        drop(manager);
        let manager = KeyManager::with_persistent_storage()?;
        
        // Should recover to consistent state
        let active_keys = manager.list_keys(KeyStatus::Active)?;
        assert_eq!(active_keys.len(), 1);
    }
}
```

### Integration Testing

```rust
#[cfg(test)]
mod integration_tests {
    use super::*;

    #[tokio::test]
    async fn test_full_rotation_lifecycle() {
        let mut manager = KeyManager::new(config)?;
        
        // Step 1: Get initial state
        let initial_key = manager.get_active_key().await?;
        
        // Step 2: Sign a webhook
        let payload = b"webhook payload";
        let initial_sig = manager.sign_payload(payload).await?;
        
        // Step 3: Verify with initial key
        let result = manager.verify(payload, &initial_sig).await?;
        assert_eq!(result.key_id, initial_key.key_id);
        
        // Step 4: Rotate key
        let rotation = manager.rotate_key(new_material, true).await?;
        
        // Step 5: Verify with transitional key
        let result = manager.verify(payload, &initial_sig).await?;
        assert_eq!(result.key_status, KeyStatus::Transitional);
        
        // Step 6: New webhooks signed with new key
        let new_payload = b"new webhook";
        let new_sig = manager.sign_payload(new_payload).await?;
        let result = manager.verify(new_payload, &new_sig).await?;
        assert_eq!(result.key_id, rotation.new_key_id);
        
        // Step 7: Wait for transition period
        manager.advance_time(Duration::hours(2)).await?;
        
        // Step 8: Verify with old key now fails
        let result = manager.verify(payload, &initial_sig).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_concurrent_rotations_rejected() {
        let manager = KeyManager::new(config)?;
        
        let rotation1 = tokio::spawn({
            let mgr = manager.clone();
            async move { mgr.rotate_key(material1, true).await }
        });
        
        let rotation2 = tokio::spawn({
            let mgr = manager.clone();
            async move { mgr.rotate_key(material2, true).await }
        });
        
        let (result1, result2) = tokio::join!(rotation1, rotation2);
        
        assert_eq!(
            (result1.is_ok(), result2.is_ok()),
            (true, false)  // One succeeds, one fails
        );
    }

    #[tokio::test]
    async fn test_multiple_concurrent_verifications_during_rotation() {
        let manager = KeyManager::new(config)?;
        
        let payload = b"webhook";
        let sig = manager.sign_payload(payload).await?;
        
        // Start rotation in background
        let rotation_task = tokio::spawn({
            let mgr = manager.clone();
            async move { mgr.rotate_key(new_material, true).await }
        });
        
        // Concurrently verify with old key
        let verify_tasks: Vec<_> = (0..100)
            .map(|_| {
                let mgr = manager.clone();
                let sig = sig.clone();
                tokio::spawn(async move {
                    mgr.verify(payload, &sig).await
                })
            })
            .collect();
        
        // All should succeed (old key still transitional)
        let results = futures::future::join_all(verify_tasks).await;
        for result in results {
            assert!(result?.is_ok());
        }
        
        let _ = rotation_task.await;
    }

    #[tokio::test]
    async fn test_recovery_from_storage_crash() {
        let mut manager = KeyManager::with_persistent_storage()?;
        
        // Perform rotation
        manager.rotate_key(new_material, true).await?;
        let new_key_id = manager.get_active_key().await?.key_id;
        
        // Corrupt storage
        manager.storage.simulate_corruption()?;
        
        // Restart and verify recovery
        drop(manager);
        let manager = KeyManager::with_persistent_storage()?;
        
        // Should recover and have consistent state
        let active_key = manager.get_active_key().await?;
        assert_eq!(active_key.key_id, new_key_id);
    }
}
```

### Property-Based Testing

Property-based testing will be detailed after prework analysis (see section below).

---

## Backward Compatibility

### Existing Consumer Support

The webhook key rotation system maintains full backward compatibility with existing consumers:

```
Timeline: Consumer Migration (Non-Disruptive)

Day 0: Operator initiates rotation
  │
  ├─ Consumer A: No action yet (still working!)
  ├─ Consumer B: No action yet (still working!)
  ├─ Consumer C: No action yet (still working!)
  │
  └─ Both old key (transitional) and new key (active)
     are valid for verification

Day 1-7: Transition period (7 days)
  │
  ├─ New webhooks: Signed with new key
  ├─ Consumer A: Updates to new key (early adopter)
  ├─ Consumer B: Still using old key (works!)
  ├─ Consumer C: Still using old key (works!)
  │
  └─ Verification accepts both old and new keys

Day 7: Transition period expires
  │
  ├─ Old key: Retired (no longer accepted)
  ├─ Consumer A: ✓ Verified with new key
  ├─ Consumer B: ✓ Updated and verified with new key
  ├─ Consumer C: ✓ Updated and verified with new key
  │
  └─ Migration complete, all consumers on new key

Late Adopter Scenario:
  Consumer X arrives on Day 8:
    - Attempts verification with old key
    - Receives: KeyExpired error (clear and actionable)
    - Includes: When key expired, where to get new key
    - Can: Follow link to get new key from operator


Key Design Decisions for Compatibility:

1. No consumer configuration required during transition
   - Existing key remains valid
   - Backward-compatible verification algorithm
   - No API changes

2. Clear error messages for late adopters
   - Error includes which key expired and when
   - Provides actionable remediation steps
   - Links to documentation and support

3. Graceful degradation
   - If system encounters both old and new keys
   - Tries old key first (known to consumer)
   - Falls back to new key if available
   - Returns key_status in response for diagnostics

4. Non-breaking consumer contract
   - Webhook payload unchanged
   - Signature format unchanged (HMAC-SHA256)
   - Timestamp format unchanged
   - Additional fields optional in response
```

---

## Performance Considerations

### Latency Requirements

```
Operation                        Target Latency    Max Acceptable
──────────────────────────────   ──────────────    ──────────────
Webhook signature verification   < 5ms             < 10ms
Key rotation operation           < 500ms           < 1s
Key list retrieval               < 50ms            < 100ms
Health check                     < 20ms            < 50ms
Active key lookup                < 1ms             < 5ms

Multi-key impact:
  - 1 key:     ~1ms
  - 5 keys:    ~2ms (20% increase)
  - 10 keys:   ~2.5ms (25% increase, acceptable)
  - 100 keys:  ~5ms (400% increase, over limit)
    → System should never exceed 10 active/transitional keys


Optimization Strategies:

1. Key Ordering
   - Sort keys by likelihood of match
   - Try Active keys before Transitional
   - Try recent keys before old keys
   - Result: ~70% of verifications hit on first attempt

2. Caching
   - Cache active key_id (TTL: 1 second)
   - Cache decrypted keys in memory (TTL: 5 minutes)
   - Invalidate cache on key rotation
   - Result: ~99% cache hit rate

3. Concurrent Verification
   - Multiple verifications don't block each other
   - RwLock for key store (readers don't block)
   - Each verification gets isolated key snapshot
   - Result: No contention under typical load

4. Lazy Decryption
   - Keep keys encrypted until verification attempt
   - Decrypt only matching key candidate
   - Clear decrypted material immediately
   - Result: Minimal memory footprint, ~2ms per verification

5. Signature Verification Optimization
   - Use hardware acceleration (AES-NI, SIMD)
   - Pre-allocate buffers to prevent GC
   - Use memory-efficient constant-time compare
   - Result: < 1ms per verification (with caching)
```

### Scalability Considerations

```
Scenario: 1 Million Daily Webhooks

Throughput Analysis:
  - 1M webhooks / 86400 seconds ≈ 12 webhooks/sec
  - With 10x safety margin: 120 webhooks/sec
  - Average latency per verification: 2ms (cached)
  - Total compute per webhook: 0.24ms
  - Utilization: < 3% of single CPU core

Scaling Horizontally:
  - Key store is replicated across nodes
  - Each node maintains own decrypted key cache
  - Verification is stateless and parallelizable
  - Rotation is coordinated via distributed lock
  - Result: Linear scaling with # of servers

Storage Overhead:
  - Per key metadata: ~200 bytes
  - Encrypted key material: ~100 bytes
  - Audit log entries: ~500 bytes each
  - Assumptions: 10 keys max, 100 operations/day
  - Daily storage growth: ~50KB
  - Annual storage growth: ~18MB (negligible)
```

---

## Security Deep Dives

### Key Compromise Scenario

```
IF Key Compromise Suspected:

Immediate Actions (< 1 minute):
  1. Operator initiates emergency rotation
  2. New key generated and activated
  3. Old key marked as compromised (metadata flag)
  4. Verification engine updated to reject compromised key
  5. Alert sent to all webhook consumers
  6. Logs audited for suspicious verification attempts

Investigation Phase (1 hour):
  1. Audit all verifications with compromised key
  2. Check for patterns (mass verification attempts)
  3. Identify potentially forged webhooks
  4. Notify affected services
  5. Review access logs for who accessed key material

Remediation Phase:
  1. Rotate to new key (done in Immediate Actions)
  2. Review access control policies
  3. Update HSM/vault access logs
  4. Consider key rotation interval reduction
  5. Document incident and lessons learned

Verification During Compromise:
  - Signature verification fails for "new" forged webhooks
  - Legitimate old webhooks still verify during transition period
  - Transition period may be shortened in config
  - Error messages indicate compromised key detection
```

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property Analysis and Consolidation

From the prework analysis, we identified 50+ testable acceptance criteria. The following properties represent the consolidated set that provide comprehensive coverage without redundancy:

### Property 1: Active Key Exclusivity

*For any* webhook system state, exactly one key has status `active` at any time.

**Validates: Requirements 2.1, 2.2**

### Property 2: Webhook Signing Uses Active Key Only

*For any* generated webhook, the signature must have been created using the current active key, and never with a transitional or retired key.

**Validates: Requirements 2.2**

### Property 3: Multi-Key Verification Acceptance

*For any* signature created with an active or transitional key (within transition period), the verification system SHALL accept it and return success.

**Validates: Requirements 2.3, 2.5, 6.2, 6.3**

### Property 4: Key Metadata Storage

*For any* key in the system, all required metadata fields are present and populated: key_id, status, created_at, activated_at, expires_at, and (where applicable) rotation_reason.

**Validates: Requirements 2.4, 5.1**

### Property 5: Transition Period Enforcement

*For any* key rotation with a specified transition period, signatures with the previous (now transitional) key SHALL be accepted for exactly the duration of transition_period_seconds after rotation, then rejected afterward.

**Validates: Requirements 3.2, 3.4, 4.1**

### Property 6: Transition Period Default Application

*For any* rotation where transition_period_seconds is not specified, the system SHALL apply the configured default (minimum 3600 seconds), ensuring no rotation lacks a transition period.

**Validates: Requirements 3.5**

### Property 7: Retired Key Rejection

*For any* signature verification attempt with a retired key, the verification SHALL fail and return an error code indicating key expiration with a timestamp.

**Validates: Requirements 4.2, 4.3**

### Property 8: Key Status Consistency

*For any* query of system key state, all keys have status values in the set {active, transitional, retired}, and no other status values exist in the system.

**Validates: Requirements 5.3**

### Property 9: Audit Trail Completeness

*For any* key state transition, an audit log entry is created with timestamp, operation type, old status, new status, and operator identifier, making all transitions traceable.

**Validates: Requirements 5.4, 5.5**

### Property 10: Backward-Compatible Verification

*For any* webhook signature created before rotation, verification SHALL succeed both before and during the transition period without requiring consumer configuration changes.

**Validates: Requirements 6.1, 6.5**

### Property 11: Verification Response Diagnostics

*For any* successful signature verification, the response includes the key_id that was used, the key_status (active/transitional), and expiration metadata for diagnostics.

**Validates: Requirements 6.4, 12.4**

### Property 12: Zero-Valid-Keys Prevention

*For any* rotation operation, if it would result in zero valid keys remaining in the system, the operation SHALL be rejected with a clear error message.

**Validates: Requirements 7.2**

### Property 13: Duplicate Key Prevention

*For any* rotation operation where the new key material is identical to an existing key in the system, the operation SHALL be rejected.

**Validates: Requirements 7.4**

### Property 14: Rotation Confirmation Requirement

*For any* key rotation, the system SHALL not finalize the rotation without explicit operator confirmation, requiring a separate confirmation action.

**Validates: Requirements 7.5**

### Property 15: Secure Logging (No Key Material)

*For any* operation logged by the system, the raw key material never appears in plain text in any log entry (keys logged only by identifier or hash).

**Validates: Requirements 8.1**

### Property 16: Key Encryption at Rest

*For any* key stored in persistent storage, the key_material field is encrypted using AES-256-GCM or equivalent industry-standard algorithm, never stored in plaintext.

**Validates: Requirements 8.2**

### Property 17: Timing-Constant Comparison

*For any* signature verification operation, the execution time is independent of where the signature diverges from expected value—timing of successful verification is statistically identical to timing of failed verification.

**Validates: Requirements 8.4**

### Property 18: Metrics Emission

*For any* system state change, relevant metrics are emitted: active_key_count, transitional_key_count, retired_key_count, verification_success_rate updated continuously.

**Validates: Requirements 9.1, 9.5**

### Property 19: Escalation Alert Threshold

*For any* system state where verification failures exceed the configured threshold, an escalation alert is triggered and recorded.

**Validates: Requirements 9.3**

### Property 20: Concurrent Webhook and Rotation Safety

*For any* webhook generated during key rotation, the webhook signature uses the active key at generation time, not the new active key from the rotation.

**Validates: Requirements 10.1, 10.2**

### Property 21: Late Verification With Expired Key Rejection

*For any* signature verification attempted after the transition period expires, where the signature was created with the now-retired key, verification SHALL fail with a KEY_EXPIRED error including the expiration timestamp.

**Validates: Requirements 10.3, 12.2**

### Property 22: Clock Skew Tolerance

*For any* signature where the timestamp differs from system time within the configured clock_drift_tolerance_seconds, verification SHALL still succeed if all other conditions are met.

**Validates: Requirements 10.4, 10.5**

### Property 23: Time-Based Automatic Rotation

*For any* system configured with time-based automatic rotation, rotations are triggered at the configured interval (e.g., every 90 days) automatically without operator intervention.

**Validates: Requirements 11.2**

### Property 24: Rotation Logging

*For any* rotation operation (manual or automatic), the system logs the trigger source (manual/scheduled/event) and reason, making the origin of all rotations auditable.

**Validates: Requirements 11.4**

### Property 25: Error Response Structure

*For any* verification failure, the error response includes: error code (INVALID_SIGNATURE, KEY_EXPIRED, or NO_VALID_KEYS), human-readable message, suggested remediation, and timestamp.

**Validates: Requirements 12.1, 12.3, 12.4, 12.5**

### Property 26: Configuration Durability

*For any* key rotation operation completed, restarting the system loads all keys and their status unchanged, implementing a round-trip property for configuration persistence.

**Validates: Requirements 13.2, 13.3**

### Property 27: Crash Recovery Consistency

*For any* system crash during rotation, upon restart the system recovers to a consistent state (either pre-rotation or post-rotation, but never partially rotated).

**Validates: Requirements 13.4, 13.5**

### Property 28: API Key Query Completeness

*For any* query of all keys, the response includes all keys with their: identifier, status, creation_time, rotation_time, and expiration_time for all keys.

**Validates: Requirements 14.2**

### Property 29: Authentication on Rotation Operations

*For any* key rotation operation attempted without valid authentication credentials, the operation SHALL be rejected with a 401 or 403 error.

**Validates: Requirements 14.5**

### Property 30: Test Utility Rotation Simulation

*For any* test utility simulating key rotation, all properties of the rotation are reproducible in test environments with test keys, and never involve production key material.

**Validates: Requirements 15.2, 15.3**

---

## Error Handling Strategy

### Error Classification

Errors in the webhook key rotation system fall into three categories:

**Category 1: Verification Failures**
- User's responsibility (consumer must update keys)
- Clear remediation steps provided
- Examples: INVALID_SIGNATURE, KEY_EXPIRED

**Category 2: Operational Errors**
- Operator's responsibility (safe rotation requires fixes)
- Validation prevents invalid states
- Examples: WOULD_HAVE_ZERO_VALID_KEYS, DUPLICATE_KEY

**Category 3: System Errors**
- Requires immediate attention
- May indicate infrastructure issues
- Examples: STORAGE_ERROR, ENCRYPTION_ERROR

### Error Recovery Patterns

```
PATTERN 1: Transient Failures (Storage temporarily unavailable)
  ├─ Immediate: Return error to caller with retry guidance
  ├─ Auto-retry: Retry after exponential backoff (100ms → 5s)
  ├─ Logging: Include failure reason and retry attempt number
  └─ Outcome: Success on retry or permanent failure after max attempts

PATTERN 2: Permanent Failures (Invalid key material)
  ├─ Immediate: Return error with specific validation issue
  ├─ Logging: Detailed validation error for troubleshooting
  ├─ No retry: Clear that issue requires user action
  └─ Guidance: Specific instructions to fix issue

PATTERN 3: Configuration Errors (Corrupted config on startup)
  ├─ Startup: Fail to start with detailed error
  ├─ Logging: Full error context for recovery
  ├─ Require: Manual intervention to restore from backup
  └─ Prevention: Regular config validation

PATTERN 4: State Conflicts (Rotation already in progress)
  ├─ Return: Conflict error (409) with operator who initiated
  ├─ Information: Estimated time to completion
  ├─ Action: Wait or cancel previous rotation
  └─ Outcome: Retry after previous completes
```

---

## Testing Strategy

### Property-Based Testing Framework

The system uses property-based testing (PBT) with fast-check (JavaScript/TypeScript) or Hypothesis (Python) or QuickCheck (Rust) to verify correctness properties across generated inputs.

**Configuration:**
- Minimum 100 iterations per property test
- Each test tagged with: `Feature: webhook-key-rotation, Property N: [description]`
- Generators produce realistic key rotations, timing scenarios, and verification attempts

### Test Generators

```typescript
// Key Material Generator
const keyMaterialGenerator = fc.tuple(
  fc.uint8Array({ minLength: 32, maxLength: 32 })
).map(([bytes]) => Buffer.from(bytes).toString('hex'));

// Transition Period Generator
const transitionPeriodGenerator = fc.oneof(
  fc.constant(undefined),  // Use default
  fc.integer({ min: 3600, max: 604800 })  // 1 hour to 7 days
);

// Timestamp Generator
const timestampGenerator = fc.integer({ min: 0, max: 2147483647 })
  .map(ts => new Date(ts * 1000));

// Key State Generator
const keyStateGenerator = fc.constantFrom(
  KeyStatus.Active,
  KeyStatus.Transitional,
  KeyStatus.Retired
);

// Webhook Payload Generator
const webhookPayloadGenerator = fc.jsonObject();

// Rotation Scenario Generator
const rotationScenarioGenerator = fc.tuple(
  keyMaterialGenerator,
  transitionPeriodGenerator,
  fc.boolean()
).map(([material, period, confirm]) => ({
  newKeyMaterial: material,
  transitionPeriod: period,
  confirmed: confirm
}));
```

### Unit Tests for Critical Paths

```typescript
describe('Webhook Key Rotation - Unit Tests', () => {
  
  describe('Key Creation', () => {
    test('creates key with unique ID', () => {
      const key1 = createWebhookKey(keyMaterial1);
      const key2 = createWebhookKey(keyMaterial2);
      expect(key1.key_id).not.toBe(key2.key_id);
    });
    
    test('initializes key with Active status', () => {
      const key = createWebhookKey(keyMaterial);
      expect(key.status).toBe(KeyStatus.Active);
    });
  });

  describe('Rotation Operation', () => {
    test('rejects rotation with invalid key material', () => {
      const manager = createKeyManager();
      expect(() => {
        manager.rotateKey('invalid_hex', true);
      }).toThrow('InvalidKeyMaterial');
    });

    test('rejects rotation without confirmation', () => {
      const manager = createKeyManager();
      const result = manager.rotateKey(validMaterial, false);
      expect(result.status).toBe('awaiting_confirmation');
    });

    test('prevents duplicate key rotation', () => {
      const manager = createKeyManager();
      manager.rotateKey(keyMaterial, true);
      expect(() => {
        manager.rotateKey(keyMaterial, true);
      }).toThrow('DuplicateKey');
    });
  });

  describe('Verification', () => {
    test('verifies signature with active key', () => {
      const manager = createKeyManager();
      const payload = Buffer.from('test');
      const signature = manager.signPayload(payload);
      
      const result = manager.verifyPayload(payload, signature);
      expect(result.valid).toBe(true);
      expect(result.key_status).toBe(KeyStatus.Active);
    });

    test('falls back to transitional key', () => {
      const manager = createKeyManager();
      const payload = Buffer.from('test');
      const signature = manager.signPayload(payload);
      
      manager.rotateKey(newMaterial, true);
      
      const result = manager.verifyPayload(payload, signature);
      expect(result.valid).toBe(true);
      expect(result.key_status).toBe(KeyStatus.Transitional);
    });

    test('rejects retired key', () => {
      const manager = createKeyManager();
      const payload = Buffer.from('test');
      const signature = manager.signPayload(payload);
      
      manager.rotateKey(newMaterial, true);
      manager.advanceTime(Duration.hours(2));
      
      const result = manager.verifyPayload(payload, signature);
      expect(result.valid).toBe(false);
      expect(result.error_code).toBe('KEY_EXPIRED');
    });
  });

  describe('State Management', () => {
    test('maintains single active key invariant', () => {
      const manager = createKeyManager();
      const activeKeys = manager.listKeys(KeyStatus.Active);
      expect(activeKeys.length).toBe(1);
    });

    test('transitions transitional keys to retired after expiration', () => {
      const manager = createKeyManager();
      manager.rotateKey(newMaterial, true);
      
      let transKeys = manager.listKeys(KeyStatus.Transitional);
      expect(transKeys.length).toBe(1);
      
      manager.advanceTime(Duration.hours(2));
      
      transKeys = manager.listKeys(KeyStatus.Transitional);
      expect(transKeys.length).toBe(0);
      
      const retiredKeys = manager.listKeys(KeyStatus.Retired);
      expect(retiredKeys.length).toBe(1);
    });
  });

  describe('Security', () => {
    test('does not log key material', () => {
      const logs = captureConsoleLogs(() => {
        manager.rotateKey(sensitiveKeyMaterial, true);
      });
      
      expect(logs).not.toContain(sensitiveKeyMaterial);
    });

    test('encrypts keys at rest', () => {
      const manager = createKeyManager();
      const stored = manager.getStoredKeyData();
      
      expect(stored.key_material).not.toEqual(rawKeyMaterial);
      expect(isValidAES256GCM(stored.key_material)).toBe(true);
    });

    test('uses constant-time comparison for signatures', () => {
      const manager = createKeyManager();
      const timings = [];
      
      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        manager.verifyPayload(payload, wrongSignature);
        timings.push(performance.now() - start);
      }
      
      const mean = timings.reduce((a, b) => a + b) / timings.length;
      const variance = timings.reduce((sum, t) => sum + Math.pow(t - mean, 2)) / timings.length;
      const stdDev = Math.sqrt(variance);
      
      // Coefficient of variation should be low (high confidence in constant time)
      expect(stdDev / mean).toBeLessThan(0.3);
    });
  });

  describe('Configuration', () => {
    test('applies default transition period', () => {
      const manager = createKeyManager();
      manager.rotateKey(newMaterial, true, undefined);
      
      const newKey = manager.getActiveKey();
      const period = newKey.expires_at - newKey.activated_at;
      expect(period).toBe(3600); // Default 1 hour
    });

    test('respects custom transition period', () => {
      const manager = createKeyManager();
      manager.rotateKey(newMaterial, true, 7200);
      
      const newKey = manager.getActiveKey();
      const period = newKey.expires_at - newKey.activated_at;
      expect(period).toBe(7200); // Custom 2 hours
    });
  });

  describe('Error Handling', () => {
    test('returns INVALID_SIGNATURE for mismatched signature', () => {
      const result = manager.verifyPayload(payload, 'wrong_sig');
      expect(result.error_code).toBe('INVALID_SIGNATURE');
    });

    test('returns KEY_EXPIRED with timestamp', () => {
      // Set up expired key
      const result = manager.verifyPayload(payload, oldSignature);
      
      expect(result.error_code).toBe('KEY_EXPIRED');
      expect(result.expires_at).toBeDefined();
      expect(result.expired_seconds_ago).toBeGreaterThan(0);
    });

    test('returns NO_VALID_KEYS when necessary', () => {
      const emptyManager = createEmptyKeyManager();
      const result = emptyManager.verifyPayload(payload, signature);
      
      expect(result.error_code).toBe('NO_VALID_KEYS');
    });
  });

  describe('Persistence', () => {
    test('persists configuration across restarts', () => {
      let manager = createKeyManager();
      const keyId = manager.getActiveKey().key_id;
      
      // Save and reload
      manager.shutdown();
      manager = createKeyManager(); // Loads from storage
      
      expect(manager.getActiveKey().key_id).toBe(keyId);
    });

    test('recovers from partial rotation crash', () => {
      let manager = createKeyManager();
      manager.begin_rotation(newMaterial);
      
      // Simulate crash
      manager.crash();
      manager = createKeyManager(); // Restart
      
      // Should recover to consistent state
      const activeKeys = manager.listKeys(KeyStatus.Active);
      expect(activeKeys.length).toBe(1);
    });
  });

  describe('Edge Cases', () => {
    test('handles zero transition period', () => {
      const manager = createKeyManager();
      manager.rotateKey(newMaterial, true, 0);
      
      const newKey = manager.getActiveKey();
      expect(newKey.expires_at).toBe(newKey.activated_at);
    });

    test('handles very large transition period', () => {
      const manager = createKeyManager();
      const maxPeriod = 315360000; // 10 years
      manager.rotateKey(newMaterial, true, maxPeriod);
      
      const newKey = manager.getActiveKey();
      expect(newKey.expires_at - newKey.activated_at).toBe(maxPeriod);
    });

    test('handles multiple transitional keys', () => {
      const manager = createKeyManager();
      manager.rotateKey(material1, true);
      manager.rotateKey(material2, true);
      manager.rotateKey(material3, true);
      
      const transKeys = manager.listKeys(KeyStatus.Transitional);
      expect(transKeys.length).toBe(2); // Previous 2 rotations
    });
  });
});
```

### Property-Based Tests

```typescript
describe('Webhook Key Rotation - Property-Based Tests', () => {
  
  // Property 2: Webhook Signing Uses Active Key Only
  it('always signs new webhooks with the active key',
    fc.property(
      rotationScenarioGenerator.chain(scenario => {
        // Setup: Create manager and perform rotation
        const manager = createKeyManager();
        manager.rotateKey(scenario.newKeyMaterial, true);
        
        return fc.tuple(
          fc.constant(manager),
          fc.constant(scenario),
          webhookPayloadGenerator
        );
      }),
      ([manager, scenario, payload]) => {
        const signature = manager.signPayload(payload);
        const activeKeyId = manager.getActiveKey().key_id;
        
        const result = manager.verifyPayload(payload, signature);
        
        fc.pre(result.valid); // Only check successful verifications
        expect(result.key_id).toBe(activeKeyId);
      }
    )
  );
  // Tag: Feature: webhook-key-rotation, Property 2: Webhook signing uses active key only

  // Property 3: Multi-Key Verification Acceptance
  it('accepts signatures from both active and transitional keys',
    fc.property(
      rotationScenarioGenerator,
      (scenario) => {
        const manager = createKeyManager();
        const payload = Buffer.from('test');
        
        // Sign with original active key
        const originalSig = manager.signPayload(payload);
        
        // Rotate to new key
        manager.rotateKey(scenario.newKeyMaterial, true);
        
        // Both keys should verify
        const originalResult = manager.verifyPayload(payload, originalSig);
        const activeKeyId = manager.getActiveKey().key_id;
        
        expect(originalResult.valid).toBe(true);
        expect(originalResult.key_status).toBe(KeyStatus.Transitional);
        
        // Also verify new key works
        const newPayload = Buffer.from('new');
        const newSig = manager.signPayload(newPayload);
        const newResult = manager.verifyPayload(newPayload, newSig);
        
        expect(newResult.valid).toBe(true);
        expect(newResult.key_status).toBe(KeyStatus.Active);
      }
    )
  );
  // Tag: Feature: webhook-key-rotation, Property 3: Multi-key verification acceptance

  // Property 5: Transition Period Enforcement
  it('enforces exact transition period duration',
    fc.property(
      transitionPeriodGenerator,
      (period) => {
        const manager = createKeyManager();
        const customPeriod = period || 3600;
        
        manager.rotateKey(newMaterial, true, customPeriod);
        const payload = Buffer.from('test');
        const sig = manager.signPayload(payload);
        
        // Rotate again to get transitional key
        manager.rotateKey(material2, true);
        
        // Should verify during transition period
        let result = manager.verifyPayload(payload, sig);
        expect(result.valid).toBe(true);
        
        // Should fail after transition period
        manager.advanceTime(customPeriod + 1);
        result = manager.verifyPayload(payload, sig);
        
        expect(result.valid).toBe(false);
        expect(result.error_code).toBe('KEY_EXPIRED');
      }
    )
  );
  // Tag: Feature: webhook-key-rotation, Property 5: Transition period enforcement

  // Property 12: Zero-Valid-Keys Prevention
  it('never allows system to enter zero-valid-keys state',
    fc.property(
      fc.array(keyMaterialGenerator, { minLength: 2, maxLength: 5 }),
      (materials) => {
        const manager = createKeyManager();
        
        // Attempt to retire all keys should fail
        materials.forEach((material, idx) => {
          if (idx < materials.length - 1) {
            manager.rotateKey(material, true);
          }
          
          // Can't retire last key
          if (idx === materials.length - 1) {
            expect(() => {
              manager.retireAll();
            }).toThrow('WouldHaveZeroValidKeys');
          }
        });
        
        // At least one key should always exist
        const validKeys = manager.listKeys().filter(k => 
          (k.status === KeyStatus.Active || k.status === KeyStatus.Transitional)
        );
        expect(validKeys.length).toBeGreaterThan(0);
      }
    )
  );
  // Tag: Feature: webhook-key-rotation, Property 12: Zero-valid-keys prevention

  // Property 15: Secure Logging (No Key Material)
  it('never logs key material in plain text',
    fc.property(
      fc.array(rotationScenarioGenerator, { minLength: 1, maxLength: 3 }),
      (scenarios) => {
        const logs = captureAllLogs(() => {
          const manager = createKeyManager();
          scenarios.forEach(scenario => {
            manager.rotateKey(scenario.newKeyMaterial, true);
          });
        });
        
        scenarios.forEach(scenario => {
          const logContent = logs.join('\n');
          expect(logContent).not.toContain(scenario.newKeyMaterial);
        });
      }
    )
  );
  // Tag: Feature: webhook-key-rotation, Property 15: Secure logging

  // Property 20: Concurrent Webhook and Rotation Safety
  it('webhooks generated during rotation use correct active key',
    fc.property(
      fc.tuple(
        keyMaterialGenerator,
        fc.array(webhookPayloadGenerator, { minLength: 1, maxLength: 10 })
      ),
      ([newMaterial, payloads]) => {
        const manager = createKeyManager();
        const originalActiveId = manager.getActiveKey().key_id;
        
        // Record which key should have been used
        const signingsAndActiveKeys: Array<[string, string]> = [];
        
        // Simulate concurrent activity
        payloads.forEach((payload, idx) => {
          if (idx === Math.floor(payloads.length / 2)) {
            // Rotate in the middle
            manager.rotateKey(newMaterial, true);
          }
          
          const sig = manager.signPayload(payload);
          const currentActiveId = manager.getActiveKey().key_id;
          signingsAndActiveKeys.push([sig, currentActiveId]);
        });
        
        // Verify each signing was with the active key at that time
        signingsAndActiveKeys.forEach(([sig, expectedKeyId]) => {
          const result = manager.verifyPayload(Buffer.from('payload'), sig);
          expect(result.key_id).toBe(expectedKeyId);
        });
      }
    )
  );
  // Tag: Feature: webhook-key-rotation, Property 20: Concurrent safety

  // Property 22: Clock Skew Tolerance
  it('tolerates clock skew within configured tolerance',
    fc.property(
      fc.integer({ min: -300, max: 300 }), // ±5 minute tolerance
      (clockSkewSeconds) => {
        const manager = createKeyManager();
        const payload = Buffer.from('test');
        const signature = manager.signPayload(payload);
        
        // Simulate clock skew
        manager.simulateClockSkew(clockSkewSeconds);
        
        const result = manager.verifyPayload(payload, signature);
        
        // Should succeed within tolerance
        if (Math.abs(clockSkewSeconds) <= 300) {
          expect(result.valid).toBe(true);
        }
      }
    )
  );
  // Tag: Feature: webhook-key-rotation, Property 22: Clock skew tolerance

  // Property 26: Configuration Durability (Round-trip)
  it('persists and recovers configuration exactly',
    fc.property(
      fc.array(rotationScenarioGenerator, { minLength: 1, maxLength: 5 }),
      (scenarios) => {
        let manager = createKeyManager();
        
        scenarios.forEach(s => manager.rotateKey(s.newKeyMaterial, true));
        
        const snapshot = {
          activeKeyId: manager.getActiveKey().key_id,
          keys: manager.listKeys(),
          history: manager.getHistory()
        };
        
        // Persist and reload
        manager.shutdown();
        manager = createKeyManager();
        
        const reloaded = {
          activeKeyId: manager.getActiveKey().key_id,
          keys: manager.listKeys(),
          history: manager.getHistory()
        };
        
        expect(reloaded).toEqual(snapshot);
      }
    )
  );
  // Tag: Feature: webhook-key-rotation, Property 26: Configuration durability
});
```

---

## Future Enhancements

### Phase 2 Considerations

1. **Distributed Key Management**: Support HSM-backed keys across multiple datacenters
2. **Key Versioning**: Track multiple rotations per key with sub-versions
3. **Automated Remediation**: Trigger automated rotation on security events
4. **Performance Optimization**: Implement key cache with LRU eviction
5. **Compliance Reporting**: Generate compliance reports for audit purposes

### Potential Integrations

- AWS Secrets Manager / Azure Key Vault for key storage
- Prometheus for metrics export
- Sentry/Datadog for error tracking
- Splunk for audit log aggregation

---

## Conclusion

The webhook key rotation system provides a comprehensive, secure, and user-friendly mechanism for key management. Its design prioritizes:

- **Security**: Encrypted storage, constant-time comparison, no key material in logs
- **Reliability**: Atomic transitions, crash recovery, audit trails
- **Backward Compatibility**: Non-disruptive rotation with configurable transition periods
- **Observability**: Comprehensive metrics, health checks, and error reporting
- **Testability**: Property-based tests, unit tests, and integration tests

The system maintains strict invariants (single active key, never zero valid keys) and provides clear, actionable error messages to guide users through key migration.


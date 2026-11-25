/// Idempotent notification delivery — issue #371
///
/// Records delivery requests against a caller-supplied idempotency key so that
/// retried or concurrently submitted requests do not create duplicate
/// deliveries. The first caller to commit a given key wins; every later caller
/// with the same key observes the recorded outcome.
use crate::base::clock::current_time;
use crate::base::errors::Error;
use crate::base::idempotency::{IdempotencyKey, IdempotencyRecord};
use soroban_sdk::{Address, BytesN, Env, String};

/// Records a notification delivery attempt idempotently.
///
/// If `idempotency_key` has already been used, the identifier stored by the
/// first caller is returned and no new delivery is created. Otherwise a record
/// is persisted and `notification_id` is returned.
pub fn deliver_notification_idempotent(
    env: Env,
    idempotency_key: BytesN<32>,
    notification_id: BytesN<32>,
    recipient: Address,
) -> Result<BytesN<32>, Error> {
    recipient.require_auth();

    let key = IdempotencyKey::Record(idempotency_key.clone());

    // A duplicate request replays the first caller's outcome instead of
    // recording a second delivery.
    if let Some(existing) = env
        .storage()
        .persistent()
        .get::<IdempotencyKey, IdempotencyRecord>(&key)
    {
        return Ok(existing.notification_id);
    }

    let record = IdempotencyRecord {
        key: idempotency_key,
        notification_id: notification_id.clone(),
        submitter: recipient,
        created_at: current_time(&env),
        delivered: true,
        result: String::from_str(&env, "delivered"),
    };
    env.storage().persistent().set(&key, &record);

    Ok(notification_id)
}

/// Returns the stored idempotency record for `idempotency_key`, if any.
pub fn get_idempotency_record(env: Env, idempotency_key: BytesN<32>) -> Option<IdempotencyRecord> {
    env.storage()
        .persistent()
        .get(&IdempotencyKey::Record(idempotency_key))
}

/// Returns whether an idempotency key has already been used.
pub fn is_idempotency_key_used(env: Env, idempotency_key: BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .has(&IdempotencyKey::Record(idempotency_key))
}

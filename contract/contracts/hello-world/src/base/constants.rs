//! Shared input-size limits for the AutoShare contract.
//!
//! Every entry point that accepts a variable-length input (`String`, `Vec`,
//! `Map`, or a notification payload) enforces its bound against one of the
//! named constants defined here. Centralising the limits guarantees that:
//!
//! 1. The same numeric bound is applied consistently across every entry point
//!    (and by off-chain clients, which can mirror these values).
//! 2. Each limit has a single, documented source of truth, so tightening a
//!    bound is a one-line change.
//! 3. Boundary behaviour is explicit and testable.
//!
//! All byte-length limits are measured in **bytes** (`String::len` in the
//! Soroban SDK returns the UTF-8 byte length, not the character count).
//!
//! # Documented limits
//!
//! | Constant                        | Bound  | Applies to                                    |
//! |---------------------------------|--------|-----------------------------------------------|
//! | [`MAX_NAME_LEN`]                | 100 B  | AutoShare group name (`create`)               |
//! | [`MAX_MEMBER_COUNT`]            | 50     | group member list (`update_members`)          |
//! | [`MAX_BATCH_SIZE`]              | 50     | `batch_schedule_notifications` entries        |
//! | [`MAX_BATCH_SUBSCRIBE`]         | 50     | `batch_subscribe` channel ids                 |
//! | [`MAX_CHANNEL_NAME_LEN`]        | 100 B  | notification channel name (`create_channel`)  |
//! | [`MAX_CHANNEL_DESCRIPTION_LEN`] | 256 B  | channel description                           |
//! | [`MAX_CHANNEL_CUSTOM_FIELDS`]   | 20     | channel custom metadata fields                |
//! | [`MAX_TEMPLATE_NAME_LEN`]       | 100 B  | template name                                 |
//! | [`MAX_EVENT_PAYLOAD_LEN`]       | 4096 B | template content / notification payload body  |
//! | [`MAX_TOPIC_LEN`]               | 256 B  | notification title (event topic text)         |
//! | [`MAX_METADATA_STRING_LEN`]     | 256 B  | metadata string key / value                   |
//! | [`MAX_METADATA_FIELDS`]         | 20     | metadata custom-field entries                 |

/// Maximum byte-length of an AutoShare group name.
pub const MAX_NAME_LEN: u32 = 100;

/// Maximum number of members allowed in an AutoShare group.
pub const MAX_MEMBER_COUNT: u32 = 50;

/// Maximum number of notifications created in a single batch call.
pub const MAX_BATCH_SIZE: u32 = 50;

/// Maximum number of channel ids accepted by `batch_subscribe`.
pub const MAX_BATCH_SUBSCRIBE: u32 = 50;

/// Maximum byte-length of a notification channel name.
pub const MAX_CHANNEL_NAME_LEN: u32 = 100;

/// Maximum byte-length of a channel description string.
pub const MAX_CHANNEL_DESCRIPTION_LEN: u32 = 256;

/// Maximum number of custom metadata fields allowed on a channel.
pub const MAX_CHANNEL_CUSTOM_FIELDS: u32 = 20;

/// Maximum byte-length of a notification template name.
pub const MAX_TEMPLATE_NAME_LEN: u32 = 100;

/// Maximum byte-length of a notification payload / template content body.
pub const MAX_EVENT_PAYLOAD_LEN: u32 = 4096;

/// Maximum byte-length of a notification title (event topic text).
pub const MAX_TOPIC_LEN: u32 = 256;

/// Maximum byte-length of a metadata string key or value.
pub const MAX_METADATA_STRING_LEN: u32 = 256;

/// Maximum number of metadata custom-field entries.
pub const MAX_METADATA_FIELDS: u32 = 20;

/// Notification Metadata Validation — Issue #305
///
/// Provides validation for notification metadata to ensure consistency
/// and prevent malformed data from being stored on-chain.
use crate::base::errors::Error;
use soroban_sdk::{Map, String};

/// Maximum length for metadata string fields (bytes)
const MAX_METADATA_STRING_LENGTH: u32 = 256;

/// Maximum number of metadata fields
const MAX_METADATA_FIELDS: u32 = 20;

/// Metadata associated with a scheduled notification
#[derive(Clone, Debug)]
pub struct NotificationMetadata {
    /// Required: title of the notification
    pub title: String,
    /// Optional: description or body of the notification
    pub description: Option<String>,
    /// Optional: URI or reference to additional data
    pub data_uri: Option<String>,
    /// Optional: custom key-value fields (limited)
    pub custom_fields: Option<Map<String, String>>,
}

/// Validate an IPFS CID with an optional safe path.
fn is_valid_ipfs_reference(value: &str) -> bool {
    let mut parts = value.splitn(2, '/');
    let cid = parts.next().unwrap_or("");
    let path = parts.next();
    let valid_cid = (cid.len() == 46
        && cid.starts_with("Qm")
        && cid.as_bytes()[2..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() && *b != b'l' && *b != b'0' && *b != b'O' && *b != b'I'))
        || (cid.len() >= 51
            && cid.len() <= 61
            && cid.starts_with('b')
            && cid.as_bytes()[1..]
                .iter()
                .all(|b| matches!(b, b'a'..=b'z' | b'2'..=b'7')));
    if !valid_cid {
        return false;
    }
    match path {
        None => true,
        Some(path) => {
            !path.is_empty()
                && !path.contains("..")
                && path
                    .split('/')
                    .all(|segment| {
                        !segment.is_empty()
                            && segment
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
                    })
        }
    }
}

/// Validate an Arweave transaction id (43 base64url chars or 64 hex chars).
fn is_valid_arweave_id(value: &str) -> bool {
    (value.len() == 43
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
        || (value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Only allow IPFS/Arweave references: never resolve or fetch them here.
fn is_valid_external_reference(value: &str) -> bool {
    if value.is_empty()
        || value.len() > MAX_METADATA_STRING_LENGTH as usize
        || value.contains("..")
        || value.chars().any(|c| c.is_whitespace() || matches!(c, '?' | '@' | '#'))
    {
        return false;
    }
    if let Some(rest) = value.strip_prefix("ipfs://") {
        is_valid_ipfs_reference(rest)
    } else if let Some(rest) = value.strip_prefix("ar://") {
        is_valid_arweave_id(rest)
    } else if let Some(rest) = value.strip_prefix("https://arweave.net/") {
        is_valid_arweave_id(rest)
    } else {
        false
    }
}

/// Validates notification metadata
///
/// # Validation Rules
/// - `title` must be non-empty and <= MAX_METADATA_STRING_LENGTH bytes
/// - `description` if present must be <= MAX_METADATA_STRING_LENGTH bytes
/// - `data_uri` if present must be <= MAX_METADATA_STRING_LENGTH bytes and a
///   well-formed IPFS or Arweave reference (#1259)
/// - `custom_fields` must not exceed MAX_METADATA_FIELDS entries
/// - All string values in custom_fields must be <= MAX_METADATA_STRING_LENGTH bytes
///
/// # Errors
/// - `InvalidInput` if title is empty
/// - `InvalidInput` if any string exceeds maximum length
/// - `InvalidInput` if custom_fields exceeds maximum field count
/// - `InvalidInput` if `data_uri` is an unsupported or malformed reference
pub fn validate_metadata(metadata: &NotificationMetadata) -> Result<(), Error> {
    // Validate title (required)
    if metadata.title.is_empty() {
        return Err(Error::InvalidInput);
    }

    if metadata.title.len() > MAX_METADATA_STRING_LENGTH {
        return Err(Error::InvalidInput);
    }

    // Validate description if present
    if let Some(desc) = &metadata.description {
        if desc.len() > MAX_METADATA_STRING_LENGTH {
            return Err(Error::InvalidInput);
        }
    }

    // Validate data_uri if present
    if let Some(uri) = &metadata.data_uri {
        if uri.len() > MAX_METADATA_STRING_LENGTH {
            return Err(Error::InvalidInput);
        }
        let bytes = uri.to_bytes().to_buffer::<{ MAX_METADATA_STRING_LENGTH as usize }>();
        let value = core::str::from_utf8(bytes.as_slice()).map_err(|_| Error::InvalidInput)?;
        if !is_valid_external_reference(value) {
            return Err(Error::InvalidInput);
        }
    }

    // Validate custom fields if present
    if let Some(fields) = &metadata.custom_fields {
        if fields.len() > MAX_METADATA_FIELDS {
            return Err(Error::InvalidInput);
        }

        // Validate each field
        for field_key in fields.keys() {
            // Validate key length
            if field_key.len() > MAX_METADATA_STRING_LENGTH {
                return Err(Error::InvalidInput);
            }

            // Validate value length
            if let Some(value) = fields.get(field_key) {
                if value.len() > MAX_METADATA_STRING_LENGTH {
                    return Err(Error::InvalidInput);
                }
            }
        }
    }

    Ok(())
}

/// Validates metadata length to prevent storage bloat
///
/// Estimates the serialized size of metadata and ensures it doesn't exceed
/// the maximum allowed size for storage efficiency.
pub fn validate_metadata_size(metadata: &NotificationMetadata) -> Result<(), Error> {
    let estimated_size = estimate_metadata_size(metadata);

    // Maximum metadata size: 4KB
    const MAX_METADATA_SIZE: u32 = 4096;

    if estimated_size > MAX_METADATA_SIZE {
        return Err(Error::InvalidInput);
    }

    Ok(())
}

/// Estimates the serialized size of metadata
fn estimate_metadata_size(metadata: &NotificationMetadata) -> u32 {
    let mut size: u32 = 0;

    // Title
    size += metadata.title.len() as u32;

    // Description
    if let Some(desc) = &metadata.description {
        size += desc.len() as u32;
    }

    // Data URI
    if let Some(uri) = &metadata.data_uri {
        size += uri.len() as u32;
    }

    // Custom fields
    if let Some(fields) = &metadata.custom_fields {
        for field_key in fields.keys() {
            size += field_key.len() as u32;
            if let Some(value) = fields.get(field_key) {
                size += value.len() as u32;
            }
        }
    }

    size
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_metadata() {
        let metadata = NotificationMetadata {
            title: String::from_slice(&soroban_sdk::Env::default(), "Test"),
            description: None,
            data_uri: None,
            custom_fields: None,
        };
        assert!(validate_metadata(&metadata).is_ok());
    }

    #[test]
    fn test_empty_title_invalid() {
        let metadata = NotificationMetadata {
            title: String::from_slice(&soroban_sdk::Env::default(), ""),
            description: None,
            data_uri: None,
            custom_fields: None,
        };
        assert!(validate_metadata(&metadata).is_err());
    }

    #[test]
    fn test_long_title_invalid() {
        let env = soroban_sdk::Env::default();
        let long_string =
            String::from_slice(&env, &"a".repeat(MAX_METADATA_STRING_LENGTH as usize + 1));
        let metadata = NotificationMetadata {
            title: long_string,
            description: None,
            data_uri: None,
            custom_fields: None,
        };
        assert!(validate_metadata(&metadata).is_err());
    }

    #[test]
    fn test_long_description_invalid() {
        let env = soroban_sdk::Env::default();
        let long_desc =
            String::from_slice(&env, &"d".repeat(MAX_METADATA_STRING_LENGTH as usize + 1));
        let metadata = NotificationMetadata {
            title: String::from_slice(&env, "ok"),
            description: Some(long_desc),
            data_uri: None,
            custom_fields: None,
        };
        assert!(validate_metadata(&metadata).is_err());
    }

    #[test]
    fn test_long_data_uri_invalid() {
        let env = soroban_sdk::Env::default();
        let long_uri =
            String::from_slice(&env, &"u".repeat(MAX_METADATA_STRING_LENGTH as usize + 1));
        let metadata = NotificationMetadata {
            title: String::from_slice(&env, "ok"),
            description: None,
            data_uri: Some(long_uri),
            custom_fields: None,
        };
        assert!(validate_metadata(&metadata).is_err());
    }

    #[test]
    fn test_too_many_custom_fields_invalid() {
        let env = soroban_sdk::Env::default();
        let mut fields = Map::new(&env);
        let mut i = 0u32;
        while i < MAX_METADATA_FIELDS + 1 {
            let key_bytes = [b'k', b'0' + ((i / 10) as u8), b'0' + ((i % 10) as u8)];
            let key = String::from_slice(&env, core::str::from_utf8(&key_bytes).unwrap());
            let val = String::from_slice(&env, "v");
            fields.set(key, val);
            i += 1;
        }
        let metadata = NotificationMetadata {
            title: String::from_slice(&env, "ok"),
            description: None,
            data_uri: None,
            custom_fields: Some(fields),
        };
        assert!(validate_metadata(&metadata).is_err());
    }

    #[test]
    fn test_valid_custom_fields() {
        let env = soroban_sdk::Env::default();
        let mut fields = Map::new(&env);
        fields.set(
            String::from_slice(&env, "priority"),
            String::from_slice(&env, "high"),
        );
        let metadata = NotificationMetadata {
            title: String::from_slice(&env, "Alert"),
            description: Some(String::from_slice(&env, "Body")),
            data_uri: Some(String::from_slice(
                &env,
                "ipfs://QmYwAPJzv5CZsnAzt8auVZRnLXQ2rJxfp6tS6eQ9K5mXpZ/file.json",
            )),
            custom_fields: Some(fields),
        };
        assert!(validate_metadata(&metadata).is_ok());
        assert!(validate_metadata_size(&metadata).is_ok());
    }

    #[test]
    fn test_external_reference_forms() {
        assert!(is_valid_external_reference(
            "ipfs://QmYwAPJzv5CZsnAzt8auVZRnLXQ2rJxfp6tS6eQ9K5mXpZ"
        ));
        assert!(is_valid_external_reference("ar://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(is_valid_external_reference(
            "https://arweave.net/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ));
    }

    #[test]
    fn test_invalid_external_references_rejected() {
        for reference in [
            "ipfs://abc",
            "ipfs://QmYwAPJzv5CZsnAzt8auVZRnLXQ2rJxfp6tS6eQ9K5mXpZ/../../etc",
            "ar://short",
            "https://example.com/payload",
            "http://169.254.169.254/latest/meta-data",
            "file:///etc/passwd",
        ] {
            assert!(!is_valid_external_reference(reference), "accepted {reference}");
        }

        let env = soroban_sdk::Env::default();
        let metadata = NotificationMetadata {
            title: String::from_slice(&env, "ok"),
            description: None,
            data_uri: Some(String::from_slice(&env, "https://example.com/payload")),
            custom_fields: None,
        };
        assert!(validate_metadata(&metadata).is_err());
    }

    #[test]
    fn test_oversized_metadata_rejected() {
        let env = soroban_sdk::Env::default();
        let mut fields = Map::new(&env);
        let mut i = 0u32;
        while i < MAX_METADATA_FIELDS {
            let key_bytes = [b'k', b'0' + ((i / 10) as u8), b'0' + ((i % 10) as u8)];
            let key = String::from_slice(&env, core::str::from_utf8(&key_bytes).unwrap());
            let val = String::from_slice(&env, &"x".repeat(256));
            fields.set(key, val);
            i += 1;
        }
        let metadata = NotificationMetadata {
            title: String::from_slice(&env, &"t".repeat(256)),
            description: Some(String::from_slice(&env, &"d".repeat(256))),
            data_uri: Some(String::from_slice(&env, &"u".repeat(256))),
            custom_fields: Some(fields),
        };
        assert!(validate_metadata_size(&metadata).is_err());
    }
}

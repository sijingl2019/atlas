//! One image attached to an outbound prompt.
//!
//! The session wire is shared by protocol versions, so it owns a small,
//! protocol-independent value instead of borrowing either ACP schema type.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    pub mime_type: String,
    /// Raw base64 payload; no `data:` URI prefix.
    pub data_base64: String,
}

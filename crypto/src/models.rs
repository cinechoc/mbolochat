use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct AccountCreated {
    pub account_pickle: String,
    pub curve25519: String,
    pub ed25519: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OneTimeKey {
    pub key_id: String,
    pub key: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OneTimeKeysGenerated {
    pub account_pickle: String,
    pub keys: Vec<OneTimeKey>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OlmEnvelope {
    pub session_pickle: String,
    pub session_id: String,
    pub message_type: String,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OutboundCreated {
    pub session_pickle: String,
    pub session_id: String,
    pub message_type: String,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InboundCreated {
    pub account_pickle: String,
    pub session_pickle: String,
    pub session_id: String,
    pub plaintext_b64: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PlaintextDecrypted {
    pub session_pickle: String,
    pub plaintext_b64: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEncrypted {
    pub file_key_b64: String,
    pub nonce_b64: String,
    pub sha256_hex: String,
    pub plaintext_size: u64,
    pub ciphertext_size: u64,
}

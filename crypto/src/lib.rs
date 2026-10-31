//! Noyau cryptographique minimal de MboloChat.
//!
//! Ce crate ne contient aucune primitive ni protocole maison : il expose
//! vodozemac (Olm) et la construction STREAM de RustCrypto.
//!
//! Les secrets sont manipulés via `zeroize` et ne sont jamais journalisés.

mod b64;
mod error;
mod filecrypto;
mod messaging;
mod models;
mod selftest;

#[cfg(feature = "jni")]
mod jni;

pub use error::CryptoError;
pub use filecrypto::{decrypt_file, encrypt_file};
pub use messaging::{
    create_account, create_inbound_and_decrypt, create_outbound_and_encrypt, decrypt, encrypt,
    generate_fallback_key_signed, generate_one_time_keys, generate_one_time_keys_signed,
    verify_prekey,
};
pub use models::{
    AccountCreated, FallbackKeySigned, FileEncrypted, InboundCreated, OlmEnvelope, OneTimeKey,
    OneTimeKeysGenerated, OneTimeKeysSigned, OutboundCreated, PlaintextDecrypted, SignedOneTimeKey,
};
pub use selftest::{self_test, SelfTestReport, SelfTestStep};

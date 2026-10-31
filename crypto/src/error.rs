use thiserror::Error;

/// Erreurs exposées à la couche native, sans détail sensible.
#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("invalid input")]
    InvalidInput,
    #[error("pickle rejected")]
    Pickle,
    #[error("session creation failed")]
    SessionCreation,
    #[error("encryption failed")]
    Encryption,
    #[error("decryption failed")]
    Decryption,
    #[error("random source failed")]
    Random,
    #[error("io failed")]
    Io,
    #[error("hash mismatch")]
    HashMismatch,
    #[error("internal error")]
    Internal,
}

impl CryptoError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::InvalidInput => "invalid_input",
            Self::Pickle => "pickle",
            Self::SessionCreation => "session_creation",
            Self::Encryption => "encryption",
            Self::Decryption => "decryption",
            Self::Random => "random",
            Self::Io => "io",
            Self::HashMismatch => "hash_mismatch",
            Self::Internal => "internal",
        }
    }
}

impl From<std::io::Error> for CryptoError {
    fn from(_: std::io::Error) -> Self {
        Self::Io
    }
}

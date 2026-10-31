use base64::Engine;

use crate::error::CryptoError;

pub(crate) fn decode(input: &str) -> Result<Vec<u8>, CryptoError> {
    base64::engine::general_purpose::STANDARD
        .decode(input)
        .map_err(|_| CryptoError::InvalidInput)
}

pub(crate) fn encode(input: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(input)
}

pub(crate) fn decode_pickle_key(input: &str) -> Result<zeroize::Zeroizing<[u8; 32]>, CryptoError> {
    let bytes = decode(input)?;
    if bytes.len() != 32 {
        return Err(CryptoError::InvalidInput);
    }
    let mut key = zeroize::Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&bytes);
    Ok(key)
}

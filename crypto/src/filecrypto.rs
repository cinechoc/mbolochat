use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;

use aead_stream::aead::Payload;
use aead_stream::{NewStream, StreamBE32, StreamPrimitive};
use chacha20poly1305::{Key, XChaCha20Poly1305};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::b64;
use crate::error::CryptoError;
use crate::models::FileEncrypted;

const CHUNK_SIZE: usize = 256 * 1024;
const TAG_SIZE: usize = 16;
const KEY_SIZE: usize = 32;
const STREAM_NONCE_SIZE: usize = 19;
const AAD: &[u8] = b"mbolo-file-v1";

fn random_bytes<const N: usize>() -> Result<[u8; N], CryptoError> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|_| CryptoError::Random)?;
    Ok(bytes)
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn stream(
    key: &[u8; KEY_SIZE],
    nonce: &[u8; STREAM_NONCE_SIZE],
) -> Result<StreamBE32<XChaCha20Poly1305>, CryptoError> {
    let key = Key::try_from(&key[..]).map_err(|_| CryptoError::Internal)?;
    let nonce = aead_stream::Nonce::<XChaCha20Poly1305, StreamBE32<XChaCha20Poly1305>>::try_from(
        &nonce[..],
    )
    .map_err(|_| CryptoError::Internal)?;
    Ok(StreamBE32::new(&key, &nonce))
}

/// Chiffre un fichier en flux avec XChaCha20-Poly1305 (construction STREAM).
/// Retourne la clé et le nonce qui doivent voyager dans le message chiffré.
pub fn encrypt_file(input: &Path, output: &Path) -> Result<FileEncrypted, CryptoError> {
    let key = Zeroizing::new(random_bytes::<KEY_SIZE>()?);
    let nonce = random_bytes::<STREAM_NONCE_SIZE>()?;
    let plaintext_size = fs::metadata(input)?.len();
    let result = (|| -> Result<FileEncrypted, CryptoError> {
        let mut reader = BufReader::new(File::open(input)?);
        let mut writer = BufWriter::new(File::create(output)?);
        let cipher = stream(&key, &nonce)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; CHUNK_SIZE];
        let mut remaining = plaintext_size;
        let mut position: u32 = 0;
        let mut ciphertext_size: u64 = 0;

        loop {
            let want = usize::try_from(remaining.min(CHUNK_SIZE as u64))
                .map_err(|_| CryptoError::Internal)?;
            if want > 0 {
                reader.read_exact(&mut buffer[..want])?;
            }
            hasher.update(&buffer[..want]);
            remaining -= want as u64;
            let last = remaining == 0;
            let chunk = cipher
                .encrypt(
                    position,
                    last,
                    Payload {
                        msg: &buffer[..want],
                        aad: AAD,
                    },
                )
                .map_err(|_| CryptoError::Encryption)?;
            writer.write_all(&chunk)?;
            ciphertext_size += chunk.len() as u64;
            if last {
                break;
            }
            position = position.checked_add(1).ok_or(CryptoError::Internal)?;
        }
        writer.flush()?;

        Ok(FileEncrypted {
            file_key_b64: b64::encode(&*key),
            nonce_b64: b64::encode(&nonce),
            sha256_hex: to_hex(&hasher.finalize()),
            plaintext_size,
            ciphertext_size,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(output);
    }
    result
}

/// Déchiffre un fichier produit par [`encrypt_file`] et vérifie éventuellement
/// l'empreinte SHA-256 du contenu clair.
pub fn decrypt_file(
    input: &Path,
    output: &Path,
    file_key_b64: &str,
    nonce_b64: &str,
    expected_sha256_hex: Option<&str>,
) -> Result<u64, CryptoError> {
    let key_bytes = b64::decode(file_key_b64)?;
    if key_bytes.len() != KEY_SIZE {
        return Err(CryptoError::InvalidInput);
    }
    let mut key = Zeroizing::new([0u8; KEY_SIZE]);
    key.copy_from_slice(&key_bytes);
    let nonce_bytes = b64::decode(nonce_b64)?;
    if nonce_bytes.len() != STREAM_NONCE_SIZE {
        return Err(CryptoError::InvalidInput);
    }
    let mut nonce = [0u8; STREAM_NONCE_SIZE];
    nonce.copy_from_slice(&nonce_bytes);

    let ciphertext_size = fs::metadata(input)?.len();
    if ciphertext_size < TAG_SIZE as u64 {
        return Err(CryptoError::InvalidInput);
    }

    let result = (|| -> Result<u64, CryptoError> {
        let mut reader = BufReader::new(File::open(input)?);
        let mut writer = BufWriter::new(File::create(output)?);
        let cipher = stream(&key, &nonce)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; CHUNK_SIZE + TAG_SIZE];
        let mut consumed: u64 = 0;
        let mut written: u64 = 0;
        let mut position: u32 = 0;

        loop {
            let left = ciphertext_size - consumed;
            let want = usize::try_from(left.min((CHUNK_SIZE + TAG_SIZE) as u64))
                .map_err(|_| CryptoError::Internal)?;
            if want == 0 {
                return Err(CryptoError::Decryption);
            }
            reader.read_exact(&mut buffer[..want])?;
            consumed += want as u64;
            let last = consumed == ciphertext_size;
            let chunk = cipher
                .decrypt(
                    position,
                    last,
                    Payload {
                        msg: &buffer[..want],
                        aad: AAD,
                    },
                )
                .map_err(|_| CryptoError::Decryption)?;
            hasher.update(&chunk);
            writer.write_all(&chunk)?;
            written += chunk.len() as u64;
            if last {
                break;
            }
            position = position.checked_add(1).ok_or(CryptoError::Internal)?;
        }
        writer.flush()?;

        if let Some(expected) = expected_sha256_hex {
            if !expected.eq_ignore_ascii_case(&to_hex(&hasher.finalize())) {
                return Err(CryptoError::HashMismatch);
            }
        }
        Ok(written)
    })();
    if result.is_err() {
        let _ = fs::remove_file(output);
    }
    result
}

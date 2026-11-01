use vodozemac::olm::{
    Account, AccountPickle, Message, OlmMessage, PreKeyMessage, Session, SessionConfig,
    SessionPickle,
};
use vodozemac::{Curve25519PublicKey, Ed25519PublicKey, Ed25519Signature};
use zeroize::Zeroize;

use crate::b64;
use crate::error::CryptoError;
use crate::models::{
    AccountCreated, FallbackKeySigned, InboundCreated, OlmEnvelope, OneTimeKey,
    OneTimeKeysGenerated, OneTimeKeysSigned, OutboundCreated, PlaintextDecrypted, SignedOneTimeKey,
};

const DEFAULT_MAX_ONE_TIME_KEYS: usize = 50;

/// Clé de pickle fournie en octets bruts (frontière JNI) plutôt qu'en base64 :
/// aucun intermédiaire textuel de la clé maîtresse n'est créé.
fn key_from_bytes(key: &[u8]) -> Result<zeroize::Zeroizing<[u8; 32]>, CryptoError> {
    if key.len() != 32 {
        return Err(CryptoError::InvalidInput);
    }
    let mut out = zeroize::Zeroizing::new([0u8; 32]);
    out.copy_from_slice(key);
    Ok(out)
}

fn load_account(pickle: &str, key: &[u8; 32]) -> Result<Account, CryptoError> {
    let parsed = AccountPickle::from_encrypted(pickle, key).map_err(|_| CryptoError::Pickle)?;
    Ok(Account::from_pickle(parsed))
}

fn load_session(pickle: &str, key: &[u8; 32]) -> Result<Session, CryptoError> {
    let parsed = SessionPickle::from_encrypted(pickle, key).map_err(|_| CryptoError::Pickle)?;
    Ok(Session::from_pickle(parsed))
}

fn encode_message(message: &OlmMessage) -> (String, String) {
    match message {
        OlmMessage::Normal(normal) => ("normal".to_owned(), normal.to_base64()),
        OlmMessage::PreKey(prekey) => ("prekey".to_owned(), prekey.to_base64()),
    }
}

fn decode_message(kind: &str, message: &str) -> Result<OlmMessage, CryptoError> {
    match kind {
        "normal" => Message::from_base64(message)
            .map(OlmMessage::Normal)
            .map_err(|_| CryptoError::InvalidInput),
        "prekey" => PreKeyMessage::from_base64(message)
            .map(OlmMessage::PreKey)
            .map_err(|_| CryptoError::InvalidInput),
        _ => Err(CryptoError::InvalidInput),
    }
}

pub fn create_account(pickle_key_b64: &str) -> Result<AccountCreated, CryptoError> {
    let key = b64::decode_pickle_key(pickle_key_b64)?;
    create_account_with_key(key.as_slice())
}

/// Variante à clé brute : la clé arrive en octets depuis la frontière JNI et
/// vit dans un `Zeroizing` (effacée à la libération).
pub fn create_account_with_key(pickle_key: &[u8]) -> Result<AccountCreated, CryptoError> {
    let key = key_from_bytes(pickle_key)?;
    let account = Account::new();
    let identity = account.identity_keys();
    Ok(AccountCreated {
        account_pickle: account.pickle().encrypt(&key),
        curve25519: identity.curve25519.to_base64(),
        ed25519: identity.ed25519.to_base64(),
    })
}

pub fn generate_one_time_keys(
    account_pickle: &str,
    pickle_key_b64: &str,
    count: usize,
) -> Result<OneTimeKeysGenerated, CryptoError> {
    let key = b64::decode_pickle_key(pickle_key_b64)?;
    generate_one_time_keys_with_key(account_pickle, key.as_slice(), count)
}

pub fn generate_one_time_keys_with_key(
    account_pickle: &str,
    pickle_key: &[u8],
    count: usize,
) -> Result<OneTimeKeysGenerated, CryptoError> {
    if count == 0 || count > DEFAULT_MAX_ONE_TIME_KEYS {
        return Err(CryptoError::InvalidInput);
    }
    let key = key_from_bytes(pickle_key)?;
    let mut account = load_account(account_pickle, &key)?;
    account.generate_one_time_keys(count);
    let keys = account
        .one_time_keys()
        .iter()
        .map(|(id, public)| OneTimeKey {
            key_id: id.to_base64(),
            key: public.to_base64(),
        })
        .collect();
    account.mark_keys_as_published();
    Ok(OneTimeKeysGenerated {
        account_pickle: account.pickle().encrypt(&key),
        keys,
    })
}

pub fn create_outbound_and_encrypt(
    account_pickle: &str,
    pickle_key_b64: &str,
    their_identity_key_b64: &str,
    their_one_time_key_b64: &str,
    plaintext_b64: &str,
) -> Result<OutboundCreated, CryptoError> {
    let key = b64::decode_pickle_key(pickle_key_b64)?;
    let mut plaintext = zeroize::Zeroizing::new(b64::decode(plaintext_b64)?);
    create_outbound_and_encrypt_with_key(
        account_pickle,
        key.as_slice(),
        their_identity_key_b64,
        their_one_time_key_b64,
        &mut plaintext,
    )
}

/// Comme [`create_outbound_and_encrypt`], mais la clé de pickle arrive en octets
/// bruts et le tampon de texte clair est **effacé avant le retour** en cas de
/// succès. En cas d'erreur, l'effacement incombe à l'appelant (tampon `Zeroizing`).
pub fn create_outbound_and_encrypt_with_key(
    account_pickle: &str,
    pickle_key: &[u8],
    their_identity_key_b64: &str,
    their_one_time_key_b64: &str,
    plaintext: &mut Vec<u8>,
) -> Result<OutboundCreated, CryptoError> {
    let key = key_from_bytes(pickle_key)?;
    let account = load_account(account_pickle, &key)?;
    let identity_key = Curve25519PublicKey::from_base64(their_identity_key_b64)
        .map_err(|_| CryptoError::InvalidInput)?;
    let one_time_key = Curve25519PublicKey::from_base64(their_one_time_key_b64)
        .map_err(|_| CryptoError::InvalidInput)?;
    let mut session = account
        .create_outbound_session(SessionConfig::version_1(), identity_key, one_time_key)
        .map_err(|_| CryptoError::SessionCreation)?;
    let message = session
        .encrypt(plaintext.as_slice())
        .map_err(|_| CryptoError::Encryption)?;
    let (message_type, body) = encode_message(&message);
    plaintext.zeroize();
    Ok(OutboundCreated {
        session_pickle: session.pickle().encrypt(&key),
        session_id: session.session_id(),
        message_type,
        message: body,
    })
}

pub fn encrypt(
    session_pickle: &str,
    pickle_key_b64: &str,
    plaintext_b64: &str,
) -> Result<OlmEnvelope, CryptoError> {
    let key = b64::decode_pickle_key(pickle_key_b64)?;
    let mut plaintext = zeroize::Zeroizing::new(b64::decode(plaintext_b64)?);
    encrypt_with_key(session_pickle, key.as_slice(), &mut plaintext)
}

/// Comme [`encrypt`], mais la clé de pickle arrive en octets bruts et le tampon
/// de texte clair est **effacé avant le retour** en cas de succès. En cas
/// d'erreur, l'effacement incombe à l'appelant (tampon `Zeroizing`).
pub fn encrypt_with_key(
    session_pickle: &str,
    pickle_key: &[u8],
    plaintext: &mut Vec<u8>,
) -> Result<OlmEnvelope, CryptoError> {
    let key = key_from_bytes(pickle_key)?;
    let mut session = load_session(session_pickle, &key)?;
    let message = session
        .encrypt(plaintext.as_slice())
        .map_err(|_| CryptoError::Encryption)?;
    let (message_type, body) = encode_message(&message);
    plaintext.zeroize();
    Ok(OlmEnvelope {
        session_pickle: session.pickle().encrypt(&key),
        session_id: session.session_id(),
        message_type,
        message: body,
    })
}

pub fn create_inbound_and_decrypt(
    account_pickle: &str,
    pickle_key_b64: &str,
    their_identity_key_b64: &str,
    prekey_message_b64: &str,
) -> Result<InboundCreated, CryptoError> {
    let key = b64::decode_pickle_key(pickle_key_b64)?;
    create_inbound_and_decrypt_with_key(
        account_pickle,
        key.as_slice(),
        their_identity_key_b64,
        prekey_message_b64,
    )
}

pub fn create_inbound_and_decrypt_with_key(
    account_pickle: &str,
    pickle_key: &[u8],
    their_identity_key_b64: &str,
    prekey_message_b64: &str,
) -> Result<InboundCreated, CryptoError> {
    let key = key_from_bytes(pickle_key)?;
    let mut account = load_account(account_pickle, &key)?;
    let their_identity_key = Curve25519PublicKey::from_base64(their_identity_key_b64)
        .map_err(|_| CryptoError::InvalidInput)?;
    let prekey =
        PreKeyMessage::from_base64(prekey_message_b64).map_err(|_| CryptoError::InvalidInput)?;
    let result = account
        .create_inbound_session(SessionConfig::version_1(), their_identity_key, &prekey)
        .map_err(|_| CryptoError::SessionCreation)?;
    // Le texte clair produit est encodé pour la sortie puis effacé : seul
    // l'encodage base64 destiné à l'appelant survit (il doit atteindre JS).
    let mut plaintext = result.plaintext;
    let encoded = b64::encode(&plaintext);
    plaintext.zeroize();
    Ok(InboundCreated {
        account_pickle: account.pickle().encrypt(&key),
        session_pickle: result.session.pickle().encrypt(&key),
        session_id: result.session.session_id(),
        plaintext_b64: encoded,
    })
}

pub fn decrypt(
    session_pickle: &str,
    pickle_key_b64: &str,
    message_type: &str,
    message_b64: &str,
) -> Result<PlaintextDecrypted, CryptoError> {
    let key = b64::decode_pickle_key(pickle_key_b64)?;
    decrypt_with_key(session_pickle, key.as_slice(), message_type, message_b64)
}

pub fn decrypt_with_key(
    session_pickle: &str,
    pickle_key: &[u8],
    message_type: &str,
    message_b64: &str,
) -> Result<PlaintextDecrypted, CryptoError> {
    let key = key_from_bytes(pickle_key)?;
    let mut session = load_session(session_pickle, &key)?;
    let message = decode_message(message_type, message_b64)?;
    let mut plaintext = session
        .decrypt(&message)
        .map_err(|_| CryptoError::Decryption)?;
    let encoded = b64::encode(&plaintext);
    plaintext.zeroize();
    Ok(PlaintextDecrypted {
        session_pickle: session.pickle().encrypt(&key),
        plaintext_b64: encoded,
    })
}

/// Signe une clé publique Curve25519 avec la clé d'identité Ed25519 du compte.
fn sign_public(account: &Account, public: &Curve25519PublicKey) -> String {
    account.sign(public.as_bytes()).to_base64()
}

/// Génère des clés à usage unique signées et renvoie l'état mis à jour.
pub fn generate_one_time_keys_signed(
    account_pickle: &str,
    pickle_key_b64: &str,
    count: usize,
) -> Result<OneTimeKeysSigned, CryptoError> {
    let key = b64::decode_pickle_key(pickle_key_b64)?;
    generate_one_time_keys_signed_with_key(account_pickle, key.as_slice(), count)
}

pub fn generate_one_time_keys_signed_with_key(
    account_pickle: &str,
    pickle_key: &[u8],
    count: usize,
) -> Result<OneTimeKeysSigned, CryptoError> {
    if count == 0 || count > DEFAULT_MAX_ONE_TIME_KEYS {
        return Err(CryptoError::InvalidInput);
    }
    let key = key_from_bytes(pickle_key)?;
    let mut account = load_account(account_pickle, &key)?;
    account.generate_one_time_keys(count);
    let keys = account
        .one_time_keys()
        .iter()
        .map(|(id, public)| SignedOneTimeKey {
            key_id: id.to_base64(),
            key: public.to_base64(),
            signature: sign_public(&account, public),
        })
        .collect();
    account.mark_keys_as_published();
    Ok(OneTimeKeysSigned {
        account_pickle: account.pickle().encrypt(&key),
        keys,
    })
}

/// Génère une clé de secours signée (utilisée si la réserve est épuisée).
pub fn generate_fallback_key_signed(
    account_pickle: &str,
    pickle_key_b64: &str,
) -> Result<FallbackKeySigned, CryptoError> {
    let key = b64::decode_pickle_key(pickle_key_b64)?;
    generate_fallback_key_signed_with_key(account_pickle, key.as_slice())
}

pub fn generate_fallback_key_signed_with_key(
    account_pickle: &str,
    pickle_key: &[u8],
) -> Result<FallbackKeySigned, CryptoError> {
    let key = key_from_bytes(pickle_key)?;
    let mut account = load_account(account_pickle, &key)?;
    account.generate_fallback_key();
    let fallback = account
        .fallback_key()
        .into_iter()
        .next()
        .ok_or(CryptoError::Internal)?;
    let result = FallbackKeySigned {
        account_pickle: String::new(),
        key_id: fallback.0.to_base64(),
        key: fallback.1.to_base64(),
        signature: sign_public(&account, &fallback.1),
    };
    account.mark_keys_as_published();
    Ok(FallbackKeySigned {
        account_pickle: account.pickle().encrypt(&key),
        ..result
    })
}

/// Vérifie la signature d'une clé à usage unique ou de secours.
pub fn verify_prekey(
    signing_key_b64: &str,
    prekey_key_b64: &str,
    signature_b64: &str,
) -> Result<bool, CryptoError> {
    let signing =
        Ed25519PublicKey::from_base64(signing_key_b64).map_err(|_| CryptoError::InvalidInput)?;
    let prekey =
        Curve25519PublicKey::from_base64(prekey_key_b64).map_err(|_| CryptoError::InvalidInput)?;
    let signature =
        Ed25519Signature::from_base64(signature_b64).map_err(|_| CryptoError::InvalidInput)?;
    Ok(signing.verify(prekey.as_bytes(), &signature).is_ok())
}

use vodozemac::olm::{
    Account, AccountPickle, Message, OlmMessage, PreKeyMessage, Session, SessionConfig,
    SessionPickle,
};
use vodozemac::Curve25519PublicKey;

use crate::b64;
use crate::error::CryptoError;
use crate::models::{
    AccountCreated, InboundCreated, OlmEnvelope, OneTimeKey, OneTimeKeysGenerated, OutboundCreated,
    PlaintextDecrypted,
};

const DEFAULT_MAX_ONE_TIME_KEYS: usize = 50;

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
    if count == 0 || count > DEFAULT_MAX_ONE_TIME_KEYS {
        return Err(CryptoError::InvalidInput);
    }
    let key = b64::decode_pickle_key(pickle_key_b64)?;
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
    let account = load_account(account_pickle, &key)?;
    let identity_key = Curve25519PublicKey::from_base64(their_identity_key_b64)
        .map_err(|_| CryptoError::InvalidInput)?;
    let one_time_key = Curve25519PublicKey::from_base64(their_one_time_key_b64)
        .map_err(|_| CryptoError::InvalidInput)?;
    let mut session = account
        .create_outbound_session(SessionConfig::version_1(), identity_key, one_time_key)
        .map_err(|_| CryptoError::SessionCreation)?;
    let plaintext = b64::decode(plaintext_b64)?;
    let message = session
        .encrypt(&plaintext)
        .map_err(|_| CryptoError::Encryption)?;
    let (message_type, body) = encode_message(&message);
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
    let mut session = load_session(session_pickle, &key)?;
    let plaintext = b64::decode(plaintext_b64)?;
    let message = session
        .encrypt(&plaintext)
        .map_err(|_| CryptoError::Encryption)?;
    let (message_type, body) = encode_message(&message);
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
    let mut account = load_account(account_pickle, &key)?;
    let their_identity_key = Curve25519PublicKey::from_base64(their_identity_key_b64)
        .map_err(|_| CryptoError::InvalidInput)?;
    let prekey =
        PreKeyMessage::from_base64(prekey_message_b64).map_err(|_| CryptoError::InvalidInput)?;
    let result = account
        .create_inbound_session(SessionConfig::version_1(), their_identity_key, &prekey)
        .map_err(|_| CryptoError::SessionCreation)?;
    Ok(InboundCreated {
        account_pickle: account.pickle().encrypt(&key),
        session_pickle: result.session.pickle().encrypt(&key),
        session_id: result.session.session_id(),
        plaintext_b64: b64::encode(&result.plaintext),
    })
}

pub fn decrypt(
    session_pickle: &str,
    pickle_key_b64: &str,
    message_type: &str,
    message_b64: &str,
) -> Result<PlaintextDecrypted, CryptoError> {
    let key = b64::decode_pickle_key(pickle_key_b64)?;
    let mut session = load_session(session_pickle, &key)?;
    let message = decode_message(message_type, message_b64)?;
    let plaintext = session
        .decrypt(&message)
        .map_err(|_| CryptoError::Decryption)?;
    Ok(PlaintextDecrypted {
        session_pickle: session.pickle().encrypt(&key),
        plaintext_b64: b64::encode(&plaintext),
    })
}

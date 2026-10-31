use std::fs;
use std::path::PathBuf;

use base64::Engine;
use mbolo_crypto::{
    create_account, create_inbound_and_decrypt, create_outbound_and_encrypt, decrypt, decrypt_file,
    encrypt, encrypt_file, generate_one_time_keys, self_test, CryptoError,
};

const PICKLE_KEY: [u8; 32] = [7u8; 32];

fn key_b64() -> String {
    base64::engine::general_purpose::STANDARD.encode(PICKLE_KEY)
}

fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn unb64(data: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .unwrap()
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mbolo-crypto-test-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn olm_roundtrip_and_reply() {
    let alice = create_account(&key_b64()).unwrap();
    let alice_keys = generate_one_time_keys(&alice.account_pickle, &key_b64(), 3).unwrap();
    let bob = create_account(&key_b64()).unwrap();
    let otk = &alice_keys.keys[0];

    let outbound = create_outbound_and_encrypt(
        &bob.account_pickle,
        &key_b64(),
        &alice.curve25519,
        &otk.key,
        &b64(b"bonjour Alice"),
    )
    .unwrap();
    assert_eq!(outbound.message_type, "prekey");

    let inbound = create_inbound_and_decrypt(
        &alice_keys.account_pickle,
        &key_b64(),
        &bob.curve25519,
        &outbound.message,
    )
    .unwrap();
    assert_eq!(unb64(&inbound.plaintext_b64), b"bonjour Alice");
    assert_eq!(inbound.session_id, outbound.session_id);

    let reply = encrypt(&inbound.session_pickle, &key_b64(), &b64(b"salut Bob")).unwrap();
    assert_eq!(reply.message_type, "normal");
    let received = decrypt(
        &outbound.session_pickle,
        &key_b64(),
        &reply.message_type,
        &reply.message,
    )
    .unwrap();
    assert_eq!(unb64(&received.plaintext_b64), b"salut Bob");
}

#[test]
fn olm_out_of_order_messages() {
    let alice = create_account(&key_b64()).unwrap();
    let alice_keys = generate_one_time_keys(&alice.account_pickle, &key_b64(), 1).unwrap();
    let bob = create_account(&key_b64()).unwrap();
    let otk = &alice_keys.keys[0];

    let outbound = create_outbound_and_encrypt(
        &bob.account_pickle,
        &key_b64(),
        &alice.curve25519,
        &otk.key,
        &b64(b"init"),
    )
    .unwrap();
    let inbound = create_inbound_and_decrypt(
        &alice_keys.account_pickle,
        &key_b64(),
        &bob.curve25519,
        &outbound.message,
    )
    .unwrap();

    let mut alice_session = inbound.session_pickle.clone();
    let mut messages = Vec::new();
    let mut bob_session = outbound.session_pickle.clone();
    for payload in [b"un".as_slice(), b"deux".as_slice(), b"trois".as_slice()] {
        let envelope = encrypt(&bob_session, &key_b64(), &b64(payload)).unwrap();
        bob_session = envelope.session_pickle;
        messages.push((envelope.message_type, envelope.message));
    }

    let expected: [&[u8]; 3] = [b"un", b"deux", b"trois"];
    for index in [2usize, 0, 1] {
        let (kind, body) = &messages[index];
        let opened = decrypt(&alice_session, &key_b64(), kind, body).unwrap();
        alice_session = opened.session_pickle;
        assert_eq!(unb64(&opened.plaintext_b64), expected[index]);
    }
}

#[test]
fn tampered_message_is_rejected() {
    let alice = create_account(&key_b64()).unwrap();
    let alice_keys = generate_one_time_keys(&alice.account_pickle, &key_b64(), 1).unwrap();
    let bob = create_account(&key_b64()).unwrap();
    let outbound = create_outbound_and_encrypt(
        &bob.account_pickle,
        &key_b64(),
        &alice.curve25519,
        &alice_keys.keys[0].key,
        &b64(b"secret"),
    )
    .unwrap();

    let mut body = outbound.message.into_bytes();
    let index = body.len() / 2;
    body[index] = if body[index] == b'A' { b'B' } else { b'A' };
    let tampered = String::from_utf8(body).unwrap();
    let error = create_inbound_and_decrypt(
        &alice_keys.account_pickle,
        &key_b64(),
        &bob.curve25519,
        &tampered,
    )
    .unwrap_err();
    assert!(matches!(
        error,
        CryptoError::InvalidInput | CryptoError::SessionCreation
    ));
}

#[test]
fn wrong_pickle_key_is_rejected() {
    let account = create_account(&key_b64()).unwrap();
    let other = base64::engine::general_purpose::STANDARD.encode([9u8; 32]);
    let error = generate_one_time_keys(&account.account_pickle, &other, 1).unwrap_err();
    assert!(matches!(error, CryptoError::Pickle));
}

#[test]
fn file_roundtrip_and_hash() {
    let dir = temp_dir("file");
    let input = dir.join("input.bin");
    let encrypted = dir.join("input.enc");
    let output = dir.join("output.bin");
    let mut data = Vec::with_capacity(10 * 1024 * 1024 + 123);
    for i in 0..(10 * 1024 * 1024 + 123) {
        data.push((i % 251) as u8);
    }
    fs::write(&input, &data).unwrap();

    let meta = encrypt_file(&input, &encrypted).unwrap();
    assert_eq!(meta.plaintext_size, data.len() as u64);
    let ciphertext = fs::read(&encrypted).unwrap();
    assert!(ciphertext.len() as u64 > data.len() as u64);
    assert!(!ciphertext.windows(16).any(|w| w == &data[..16]));

    let written = decrypt_file(
        &encrypted,
        &output,
        &meta.file_key_b64,
        &meta.nonce_b64,
        Some(&meta.sha256_hex),
    )
    .unwrap();
    assert_eq!(written, data.len() as u64);
    assert_eq!(fs::read(&output).unwrap(), data);
}

#[test]
fn file_tamper_and_truncation_are_rejected() {
    let dir = temp_dir("tamper");
    let input = dir.join("input.bin");
    let encrypted = dir.join("input.enc");
    let output = dir.join("output.bin");
    fs::write(&input, vec![42u8; 600_000]).unwrap();
    let meta = encrypt_file(&input, &encrypted).unwrap();

    let mut ciphertext = fs::read(&encrypted).unwrap();
    let mid = ciphertext.len() / 2;
    ciphertext[mid] ^= 0x01;
    fs::write(&encrypted, &ciphertext).unwrap();
    let error = decrypt_file(
        &encrypted,
        &output,
        &meta.file_key_b64,
        &meta.nonce_b64,
        Some(&meta.sha256_hex),
    )
    .unwrap_err();
    assert!(matches!(error, CryptoError::Decryption));

    let truncated = dir.join("truncated.enc");
    fs::write(&truncated, &ciphertext[..ciphertext.len() - 8]).unwrap();
    let error = decrypt_file(
        &truncated,
        &output,
        &meta.file_key_b64,
        &meta.nonce_b64,
        Some(&meta.sha256_hex),
    )
    .unwrap_err();
    assert!(matches!(error, CryptoError::Decryption | CryptoError::Io));
}

#[test]
fn file_hash_mismatch_is_reported() {
    let dir = temp_dir("hash");
    let input = dir.join("input.bin");
    let encrypted = dir.join("input.enc");
    let output = dir.join("output.bin");
    fs::write(&input, b"mbolo").unwrap();
    let meta = encrypt_file(&input, &encrypted).unwrap();
    let error = decrypt_file(
        &encrypted,
        &output,
        &meta.file_key_b64,
        &meta.nonce_b64,
        Some("0000000000000000000000000000000000000000000000000000000000000000"),
    )
    .unwrap_err();
    assert!(matches!(error, CryptoError::HashMismatch));
}

#[test]
fn empty_file_roundtrip() {
    let dir = temp_dir("empty");
    let input = dir.join("empty.bin");
    let encrypted = dir.join("empty.enc");
    let output = dir.join("empty.out");
    fs::write(&input, b"").unwrap();
    let meta = encrypt_file(&input, &encrypted).unwrap();
    let written = decrypt_file(
        &encrypted,
        &output,
        &meta.file_key_b64,
        &meta.nonce_b64,
        Some(&meta.sha256_hex),
    )
    .unwrap();
    assert_eq!(written, 0);
    assert_eq!(fs::read(&output).unwrap(), b"");
}

#[test]
fn native_self_test_reports_steps_without_secrets() {
    let dir = temp_dir("selftest");
    let report = self_test(&dir, 1).unwrap();
    assert_eq!(report.steps.len(), 7);
    assert!(report.steps.iter().all(|step| !step.key.is_empty()));
    assert!(report.plaintext_size > report.file_mb as u64 * 1024 * 1024);
    assert!(report.ciphertext_size > report.plaintext_size);
    let serialized = serde_json::to_string(&report).unwrap();
    assert!(!serialized.contains("curve25519"));
    assert!(!serialized.contains("pickle"));
    assert!(!serialized.contains("selftest message"));
}

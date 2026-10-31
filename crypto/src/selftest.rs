use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;

use crate::b64;
use crate::error::CryptoError;
use crate::filecrypto::{decrypt_file, encrypt_file};
use crate::messaging::{
    create_account, create_inbound_and_decrypt, create_outbound_and_encrypt, decrypt, encrypt,
    generate_one_time_keys,
};

#[derive(Debug, Serialize)]
pub struct SelfTestStep {
    pub key: &'static str,
    pub ms: u64,
}

#[derive(Debug, Serialize)]
pub struct SelfTestReport {
    pub file_mb: usize,
    pub plaintext_size: u64,
    pub ciphertext_size: u64,
    pub steps: Vec<SelfTestStep>,
}

fn push_step(steps: &mut Vec<SelfTestStep>, key: &'static str, started: Instant) {
    steps.push(SelfTestStep {
        key,
        ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    });
}

fn random_key() -> Result<Vec<u8>, CryptoError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| CryptoError::Random)?;
    Ok(bytes.to_vec())
}

fn write_pattern(path: &Path, size: u64) -> Result<(), CryptoError> {
    let mut writer = BufWriter::new(File::create(path)?);
    let chunk = 64 * 1024;
    let mut buffer = vec![0u8; chunk];
    let mut written = 0u64;
    while written < size {
        let take = usize::try_from((size - written).min(chunk as u64)).unwrap_or(chunk);
        for (index, byte) in buffer[..take].iter_mut().enumerate() {
            *byte = ((written as usize + index) % 251) as u8;
        }
        writer.write_all(&buffer[..take])?;
        written += take as u64;
    }
    writer.flush()?;
    Ok(())
}

fn files_equal(left: &Path, right: &Path) -> Result<bool, CryptoError> {
    let mut first = BufReader::new(File::open(left)?);
    let mut second = BufReader::new(File::open(right)?);
    let mut a = vec![0u8; 64 * 1024];
    let mut b = vec![0u8; 64 * 1024];
    loop {
        let read_a = first.read(&mut a)?;
        let read_b = second.read(&mut b)?;
        if read_a != read_b || a[..read_a] != b[..read_b] {
            return Ok(false);
        }
        if read_a == 0 {
            return Ok(true);
        }
    }
}

fn tamper_copy(source: &Path, target: &Path) -> Result<(), CryptoError> {
    fs::copy(source, target)?;
    let length = fs::metadata(target)?.len();
    let offset = length / 2;
    let mut file = OpenOptions::new().read(true).write(true).open(target)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut byte = [0u8; 1];
    file.read_exact(&mut byte)?;
    byte[0] ^= 0x01;
    file.seek(SeekFrom::Start(offset))?;
    file.write_all(&byte)?;
    Ok(())
}

pub fn self_test(work_dir: &Path, file_mb: usize) -> Result<SelfTestReport, CryptoError> {
    if work_dir.as_os_str().is_empty() || file_mb == 0 || file_mb > 200 {
        return Err(CryptoError::InvalidInput);
    }
    let run_dir: PathBuf = work_dir.join(format!("mbolo-selftest-{}", std::process::id()));
    let _ = fs::remove_dir_all(&run_dir);
    fs::create_dir_all(&run_dir)?;
    let result = run_checks(&run_dir, file_mb);
    let _ = fs::remove_dir_all(&run_dir);
    result
}

fn run_checks(run_dir: &Path, file_mb: usize) -> Result<SelfTestReport, CryptoError> {
    let pickle_key = b64::encode(&random_key()?);
    let mut steps = Vec::new();

    let started = Instant::now();
    let alice = create_account(&pickle_key)?;
    let alice_keys = generate_one_time_keys(&alice.account_pickle, &pickle_key, 5)?;
    let bob = create_account(&pickle_key)?;
    push_step(&mut steps, "accounts", started);

    let started = Instant::now();
    let otk = alice_keys
        .keys
        .first()
        .ok_or(CryptoError::Internal)?
        .key
        .clone();
    let outbound = create_outbound_and_encrypt(
        &bob.account_pickle,
        &pickle_key,
        &alice.curve25519,
        &otk,
        &b64::encode(b"selftest message"),
    )?;
    let inbound = create_inbound_and_decrypt(
        &alice_keys.account_pickle,
        &pickle_key,
        &bob.curve25519,
        &outbound.message,
    )?;
    if b64::decode(&inbound.plaintext_b64)? != b"selftest message" {
        return Err(CryptoError::Internal);
    }
    push_step(&mut steps, "session", started);

    let started = Instant::now();
    let reply = encrypt(
        &inbound.session_pickle,
        &pickle_key,
        &b64::encode(b"selftest reply"),
    )?;
    let received = decrypt(
        &outbound.session_pickle,
        &pickle_key,
        &reply.message_type,
        &reply.message,
    )?;
    if b64::decode(&received.plaintext_b64)? != b"selftest reply" {
        return Err(CryptoError::Internal);
    }
    push_step(&mut steps, "reply", started);

    let started = Instant::now();
    let payloads: [&[u8]; 3] = [b"one", b"two", b"three"];
    let mut envelopes = Vec::new();
    let mut bob_session = outbound.session_pickle;
    for payload in payloads {
        let envelope = encrypt(&bob_session, &pickle_key, &b64::encode(payload))?;
        bob_session = envelope.session_pickle;
        envelopes.push((envelope.message_type, envelope.message));
    }
    let mut alice_session = inbound.session_pickle;
    for index in [2usize, 0, 1] {
        let (kind, body) = &envelopes[index];
        let opened = decrypt(&alice_session, &pickle_key, kind, body)?;
        alice_session = opened.session_pickle;
        if b64::decode(&opened.plaintext_b64)? != payloads[index] {
            return Err(CryptoError::Internal);
        }
    }
    push_step(&mut steps, "out_of_order", started);

    let input = run_dir.join("media.bin");
    let encrypted = run_dir.join("media.enc");
    let output = run_dir.join("media.out");
    let size = file_mb as u64 * 1024 * 1024 + 123;
    write_pattern(&input, size)?;

    let started = Instant::now();
    let meta = encrypt_file(&input, &encrypted)?;
    let ciphertext_size = fs::metadata(&encrypted)?.len();
    if ciphertext_size <= size {
        return Err(CryptoError::Internal);
    }
    push_step(&mut steps, "file_encrypt", started);

    let started = Instant::now();
    let written = decrypt_file(
        &encrypted,
        &output,
        &meta.file_key_b64,
        &meta.nonce_b64,
        Some(&meta.sha256_hex),
    )?;
    if written != size || !files_equal(&input, &output)? {
        return Err(CryptoError::Internal);
    }
    push_step(&mut steps, "file_decrypt", started);

    let started = Instant::now();
    let tampered = run_dir.join("media.tampered");
    tamper_copy(&encrypted, &tampered)?;
    let rejected = decrypt_file(
        &tampered,
        &run_dir.join("media.rejected"),
        &meta.file_key_b64,
        &meta.nonce_b64,
        Some(&meta.sha256_hex),
    )
    .is_err();
    if !rejected {
        return Err(CryptoError::Internal);
    }
    push_step(&mut steps, "tamper_rejected", started);

    Ok(SelfTestReport {
        file_mb,
        plaintext_size: size,
        ciphertext_size,
        steps,
    })
}

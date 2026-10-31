use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use base64::Engine;
use mbolo_crypto::{
    create_account, create_inbound_and_decrypt, create_outbound_and_encrypt, decrypt, decrypt_file,
    encrypt, encrypt_file, generate_one_time_keys,
};

const DEFAULT_FILE_MB: usize = 10;

struct Device {
    name: &'static str,
    account: String,
    session: Option<String>,
}

fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn unb64(data: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .expect("base64")
}

fn write(path: &Path, value: &str) -> Result<(), String> {
    fs::write(path, value).map_err(|e| e.to_string())
}

fn read(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}

fn print_pass(label: &str, elapsed: std::time::Duration) {
    println!("PASS {label} ({} ms)", elapsed.as_millis());
}

#[derive(Serialize, Deserialize)]
struct PublicBundle {
    curve25519: String,
    ed25519: String,
    one_time_key: String,
}

#[derive(Serialize, Deserialize)]
struct WireMessage {
    message_type: String,
    message: String,
}

fn wait_for(path: &Path) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if path.exists() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Err(format!("timeout waiting for {}", path.display()))
}

fn shared_dir(args: &mut impl Iterator<Item = String>) -> Result<PathBuf, String> {
    let dir = PathBuf::from(args.next().ok_or("missing shared dir")?);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn file_roundtrip(dir: &Path, label: &str, megabytes: usize) -> Result<(), String> {
    let size = megabytes.max(1) * 1024 * 1024 + 7;
    let input = dir.join(format!("{label}.bin"));
    let encrypted = dir.join(format!("{label}.enc"));
    let output = dir.join(format!("{label}.out"));
    let data: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
    fs::write(&input, &data).map_err(|e| e.to_string())?;
    let started = Instant::now();
    let meta = encrypt_file(&input, &encrypted).map_err(|e| e.code().to_owned())?;
    let written = decrypt_file(
        &encrypted,
        &output,
        &meta.file_key_b64,
        &meta.nonce_b64,
        Some(&meta.sha256_hex),
    )
    .map_err(|e| e.code().to_owned())?;
    if written != size as u64 || fs::read(&output).map_err(|e| e.to_string())? != data {
        return Err("file roundtrip mismatch".into());
    }
    println!(
        "PASS {label}: fichier {megabytes} Mio chiffré/déchiffré ({} ms)",
        started.elapsed().as_millis()
    );
    Ok(())
}

fn pair_alice(dir: &Path) -> Result<(), String> {
    let mut pickle_key = [0u8; 32];
    getrandom::fill(&mut pickle_key).map_err(|e| e.to_string())?;
    let pickle_key = b64(&pickle_key);

    let alice = create_account(&pickle_key).map_err(|e| e.code().to_owned())?;
    let alice_keys = generate_one_time_keys(&alice.account_pickle, &pickle_key, 5)
        .map_err(|e| e.code().to_owned())?;
    let otk = alice_keys
        .keys
        .first()
        .ok_or("no one-time key")?
        .key
        .clone();
    let bundle = PublicBundle {
        curve25519: alice.curve25519.clone(),
        ed25519: alice.ed25519.clone(),
        one_time_key: otk,
    };
    write(
        &dir.join("alice.bundle.json"),
        &serde_json::to_string(&bundle).map_err(|e| e.to_string())?,
    )?;

    wait_for(&dir.join("bob.bundle.json"))?;
    let bob: PublicBundle =
        serde_json::from_str(&read(&dir.join("bob.bundle.json"))?).map_err(|e| e.to_string())?;

    let outbound = create_outbound_and_encrypt(
        &alice_keys.account_pickle,
        &pickle_key,
        &bob.curve25519,
        &bob.one_time_key,
        &b64(b"bonjour depuis Alice"),
    )
    .map_err(|e| e.code().to_owned())?;
    let session_path = dir.join("alice.session");
    write(&dir.join("alice.session"), &outbound.session_pickle)?;
    write(
        &dir.join("alice.to.bob.json"),
        &serde_json::to_string(&WireMessage {
            message_type: outbound.message_type.clone(),
            message: outbound.message.clone(),
        })
        .map_err(|e| e.to_string())?,
    )?;
    write(&dir.join("alice.sent"), "1")?;

    wait_for(&dir.join("bob.to.alice.json"))?;
    let reply: WireMessage =
        serde_json::from_str(&read(&dir.join("bob.to.alice.json"))?).map_err(|e| e.to_string())?;
    let session = read(&session_path)?;
    let opened = decrypt(&session, &pickle_key, &reply.message_type, &reply.message)
        .map_err(|e| e.code().to_owned())?;
    let plaintext = unb64(&opened.plaintext_b64);
    if plaintext != b"reponse depuis Bob" {
        return Err("alice reply mismatch".into());
    }
    file_roundtrip(dir, "alice-media", 2)?;
    println!("PASS alice: session et aller-retour entre deux processus");
    write(&dir.join("alice.done"), "1")
}

fn pair_bob(dir: &Path) -> Result<(), String> {
    let mut pickle_key = [0u8; 32];
    getrandom::fill(&mut pickle_key).map_err(|e| e.to_string())?;
    let pickle_key = b64(&pickle_key);

    let bob = create_account(&pickle_key).map_err(|e| e.code().to_owned())?;
    let bob_keys = generate_one_time_keys(&bob.account_pickle, &pickle_key, 5)
        .map_err(|e| e.code().to_owned())?;
    let otk = bob_keys.keys.first().ok_or("no one-time key")?.key.clone();
    let bundle = PublicBundle {
        curve25519: bob.curve25519.clone(),
        ed25519: bob.ed25519.clone(),
        one_time_key: otk,
    };
    write(
        &dir.join("bob.bundle.json"),
        &serde_json::to_string(&bundle).map_err(|e| e.to_string())?,
    )?;

    wait_for(&dir.join("alice.to.bob.json"))?;
    let message: WireMessage =
        serde_json::from_str(&read(&dir.join("alice.to.bob.json"))?).map_err(|e| e.to_string())?;
    let alice: PublicBundle =
        serde_json::from_str(&read(&dir.join("alice.bundle.json"))?).map_err(|e| e.to_string())?;
    let inbound = create_inbound_and_decrypt(
        &bob_keys.account_pickle,
        &pickle_key,
        &alice.curve25519,
        &message.message,
    )
    .map_err(|e| e.code().to_owned())?;
    if unb64(&inbound.plaintext_b64) != b"bonjour depuis Alice" {
        return Err("bob prekey mismatch".into());
    }
    let session_path = dir.join("bob.session");
    write(&session_path, &inbound.session_pickle)?;

    let session = read(&session_path)?;
    let reply = encrypt(&session, &pickle_key, &b64(b"reponse depuis Bob"))
        .map_err(|e| e.code().to_owned())?;
    write(
        &dir.join("bob.to.alice.json"),
        &serde_json::to_string(&WireMessage {
            message_type: reply.message_type.clone(),
            message: reply.message.clone(),
        })
        .map_err(|e| e.to_string())?,
    )?;
    file_roundtrip(dir, "bob-media", 2)?;
    println!("PASS bob: session et aller-retour entre deux processus");
    write(&dir.join("bob.done"), "1")
}

fn run(file_mb: usize) -> Result<(), String> {
    let base = std::env::var("MBOLO_SPIKE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            if cfg!(target_os = "android") {
                PathBuf::from("/data/local/tmp")
            } else {
                std::env::temp_dir()
            }
        });
    let dir = base.join(format!("mbolo-spike-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut pickle_key = [0u8; 32];
    getrandom::fill(&mut pickle_key).map_err(|e| e.to_string())?;
    let pickle_key = b64(&pickle_key);

    let started = Instant::now();
    let alice_created = create_account(&pickle_key).map_err(|e| e.code().to_owned())?;
    let bob_created = create_account(&pickle_key).map_err(|e| e.code().to_owned())?;
    write(&dir.join("alice.account"), &alice_created.account_pickle)?;
    write(&dir.join("bob.account"), &bob_created.account_pickle)?;
    print_pass("comptes créés et persistés", started.elapsed());

    let started = Instant::now();
    let alice_keys = generate_one_time_keys(&alice_created.account_pickle, &pickle_key, 5)
        .map_err(|e| e.code().to_owned())?;
    write(&dir.join("alice.account"), &alice_keys.account_pickle)?;
    let otk = alice_keys.keys.first().ok_or("no one-time key")?;
    print_pass(
        &format!("{} clés à usage unique générées", alice_keys.keys.len()),
        started.elapsed(),
    );

    let mut alice = Device {
        name: "alice",
        account: read(&dir.join("alice.account"))?,
        session: None,
    };
    let mut bob = Device {
        name: "bob",
        account: read(&dir.join("bob.account"))?,
        session: None,
    };

    let started = Instant::now();
    let first = create_outbound_and_encrypt(
        &bob.account,
        &pickle_key,
        &alice_created.curve25519,
        &otk.key,
        &b64(b"bonjour depuis le telephone"),
    )
    .map_err(|e| e.code().to_owned())?;
    bob.session = Some(first.session_pickle);
    let opened = create_inbound_and_decrypt(
        &alice.account,
        &pickle_key,
        &bob_created.curve25519,
        &first.message,
    )
    .map_err(|e| e.code().to_owned())?;
    alice.account = opened.account_pickle;
    alice.session = Some(opened.session_pickle);
    if unb64(&opened.plaintext_b64) != b"bonjour depuis le telephone" {
        return Err("prekey plaintext mismatch".into());
    }
    write(&dir.join("alice.account"), &alice.account)?;
    write(
        &dir.join("bob.session"),
        bob.session.as_deref().unwrap_or_default(),
    )?;
    print_pass("session Olm établie (prekey)", started.elapsed());

    let started = Instant::now();
    let reply = encrypt(
        alice.session.as_deref().ok_or("alice session")?,
        &pickle_key,
        &b64(b"reponse de bob vers alice"),
    )
    .map_err(|e| e.code().to_owned())?;
    alice.session = Some(reply.session_pickle);
    let received = decrypt(
        bob.session.as_deref().ok_or("bob session")?,
        &pickle_key,
        &reply.message_type,
        &reply.message,
    )
    .map_err(|e| e.code().to_owned())?;
    bob.session = Some(received.session_pickle);
    if unb64(&received.plaintext_b64) != b"reponse de bob vers alice" {
        return Err("reply plaintext mismatch".into());
    }
    print_pass("message de retour déchiffré", started.elapsed());

    let started = Instant::now();
    let payloads: [&[u8]; 3] = [b"un", b"deux", b"trois"];
    let mut envelopes = Vec::new();
    for payload in payloads {
        let envelope = encrypt(
            bob.session.as_deref().ok_or("bob session")?,
            &pickle_key,
            &b64(payload),
        )
        .map_err(|e| e.code().to_owned())?;
        bob.session = Some(envelope.session_pickle);
        envelopes.push((envelope.message_type, envelope.message));
    }
    for index in [2usize, 0, 1] {
        let (kind, body) = &envelopes[index];
        let opened = decrypt(
            alice.session.as_deref().ok_or("alice session")?,
            &pickle_key,
            kind,
            body,
        )
        .map_err(|e| e.code().to_owned())?;
        alice.session = Some(opened.session_pickle);
        if unb64(&opened.plaintext_b64) != payloads[index] {
            return Err("out-of-order plaintext mismatch".into());
        }
    }
    print_pass("messages dans le désordre", started.elapsed());

    let file_size = file_mb.max(1) * 1024 * 1024 + 123;
    let input = dir.join("media.bin");
    let encrypted = dir.join("media.enc");
    let output = dir.join("media.out");
    let mut data = Vec::with_capacity(file_size);
    for i in 0..file_size {
        data.push((i % 251) as u8);
    }
    fs::write(&input, &data).map_err(|e| e.to_string())?;

    let started = Instant::now();
    let meta = encrypt_file(&input, &encrypted).map_err(|e| e.code().to_owned())?;
    let elapsed_encrypt = started.elapsed();
    let ciphertext_size = fs::metadata(&encrypted).map_err(|e| e.to_string())?.len();
    let mut probe = Vec::new();
    fs::File::open(&encrypted)
        .and_then(|mut f| f.read_to_end(&mut probe))
        .map_err(|e| e.to_string())?;
    if probe.windows(16).any(|window| window == &data[..16]) {
        return Err("plaintext leaked in ciphertext".into());
    }
    drop(probe);
    print_pass(
        &format!("fichier {file_mb} Mio chiffré ({ciphertext_size} octets)"),
        elapsed_encrypt,
    );

    let started = Instant::now();
    let written = decrypt_file(
        &encrypted,
        &output,
        &meta.file_key_b64,
        &meta.nonce_b64,
        Some(&meta.sha256_hex),
    )
    .map_err(|e| e.code().to_owned())?;
    if written != file_size as u64 {
        return Err("file size mismatch".into());
    }
    let decrypted = fs::read(&output).map_err(|e| e.to_string())?;
    if decrypted != data {
        return Err("file roundtrip mismatch".into());
    }
    print_pass("fichier déchiffré et empreinte vérifiée", started.elapsed());

    let started = Instant::now();
    let mut tampered = fs::read(&encrypted).map_err(|e| e.to_string())?;
    let middle = tampered.len() / 2;
    tampered[middle] ^= 0x01;
    let tampered_path = dir.join("tampered.enc");
    fs::write(&tampered_path, &tampered).map_err(|e| e.to_string())?;
    let rejected = decrypt_file(
        &tampered_path,
        &dir.join("tampered.out"),
        &meta.file_key_b64,
        &meta.nonce_b64,
        Some(&meta.sha256_hex),
    )
    .is_err();
    if !rejected {
        return Err("tampered ciphertext accepted".into());
    }
    print_pass("fichier altéré rejeté", started.elapsed());

    println!(
        "SPIKE OK dir={} devices={}+{} sessions={}+{}",
        dir.display(),
        alice.name,
        bob.name,
        alice.session.is_some(),
        bob.session.is_some()
    );
    Ok(())
}

fn main() {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "selftest".to_owned());
    match command.as_str() {
        "selftest" => {
            let file_mb = args
                .next()
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(DEFAULT_FILE_MB);
            match run(file_mb) {
                Ok(()) => {}
                Err(error) => {
                    eprintln!("SPIKE FAIL {error}");
                    std::process::exit(1);
                }
            }
        }
        "pair-a" | "pair-b" => {
            let result = shared_dir(&mut args).and_then(|dir| {
                let role = if command == "pair-a" { "alice" } else { "bob" };
                println!("PAIR {role} started in {}", dir.display());
                if role == "alice" {
                    pair_alice(&dir)
                } else {
                    pair_bob(&dir)
                }
            });
            if let Err(error) = result {
                eprintln!("SPIKE FAIL {error}");
                std::process::exit(1);
            }
        }
        other => {
            eprintln!("SPIKE FAIL unknown command {other}");
            std::process::exit(2);
        }
    }
}

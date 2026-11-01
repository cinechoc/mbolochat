use std::fs;
use std::path::PathBuf;

use base64::Engine;
use serde::{Deserialize, Serialize};

use mbolo_crypto::{
    create_account, create_inbound_and_decrypt, create_outbound_and_encrypt, decrypt, encrypt,
    generate_fallback_key_signed, generate_one_time_keys_signed,
};

#[derive(Serialize, Deserialize)]
struct Bundle {
    #[serde(rename = "identityKey")]
    identity_key: String,
    #[serde(rename = "signingKey")]
    signing_key: String,
    #[serde(rename = "fallbackPrekey")]
    fallback_prekey: Option<String>,
    #[serde(rename = "fallbackPrekeySignature")]
    fallback_prekey_signature: Option<String>,
    #[serde(rename = "fallbackPrekeyKeyId")]
    fallback_prekey_key_id: Option<String>,
    #[serde(rename = "oneTimeKeys")]
    one_time_keys: Vec<SignedKey>,
}

#[derive(Serialize, Deserialize)]
struct SignedKey {
    #[serde(rename = "keyId")]
    key_id: String,
    key: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetBundle {
    identity_key: String,
    one_time_key: Option<TargetKey>,
    fallback: Option<TargetKey>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetKey {
    key: String,
}

#[derive(Serialize, Deserialize)]
struct Wire {
    #[serde(rename = "payloadType")]
    payload_type: String,
    payload: String,
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(value: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .expect("base64")
}

fn text_payload(text: &str) -> String {
    b64(serde_json::json!({ "v": 1, "text": text }).to_string().as_bytes())
}

fn read_text(path: &PathBuf) -> String {
    fs::read_to_string(path).expect("read")
}

fn main() {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_default();
    let dir = PathBuf::from(args.next().unwrap_or_else(|| "/tmp/mbolo-peer".into()));
    fs::create_dir_all(&dir).expect("dir");
    let key_path = dir.join("pickle.key");
    let account_path = dir.join("account.pickle");

    match command.as_str() {
        "init" => {
            let mut key = [0u8; 32];
            getrandom::fill(&mut key).expect("random");
            let key_b64 = b64(&key);
            let created = create_account(&key_b64).expect("account");
            let signed = generate_one_time_keys_signed(&created.account_pickle, &key_b64, 5)
                .expect("otk");
            let fallback = generate_fallback_key_signed(&signed.account_pickle, &key_b64)
                .expect("fallback");
            fs::write(&key_path, &key_b64).expect("key");
            fs::write(&account_path, &fallback.account_pickle).expect("account");
            // Nouvelle identité : la session ouverte précédente n'a plus de sens.
            let _ = fs::remove_file(dir.join("session.pickle"));
            let bundle = Bundle {
                identity_key: created.curve25519,
                signing_key: created.ed25519,
                fallback_prekey: Some(fallback.key),
                fallback_prekey_signature: Some(fallback.signature),
                fallback_prekey_key_id: Some(fallback.key_id),
                one_time_keys: signed
                    .keys
                    .into_iter()
                    .map(|entry| SignedKey {
                        key_id: entry.key_id,
                        key: entry.key,
                        signature: entry.signature,
                    })
                    .collect(),
            };
            println!("{}", serde_json::to_string(&bundle).expect("json"));
        }
        "send" => {
            let text = args.next().unwrap_or_else(|| "hello".into());
            let key = read_text(&key_path);
            let account = read_text(&account_path);
            let session_path = dir.join("session.pickle");
            let wire = if session_path.exists() {
                // Session déjà ouverte : message normal, on repersiste le
                // pickle avancé pour ne pas rejouer le ratchet.
                let session = read_text(&session_path);
                let envelope = encrypt(&session, &key, &text_payload(&text)).expect("encrypt");
                fs::write(&session_path, &envelope.session_pickle).expect("session");
                Wire {
                    payload_type: envelope.message_type,
                    payload: envelope.message,
                }
            } else {
                let target: TargetBundle =
                    serde_json::from_str(&read_text(&dir.join("target.json"))).expect("target");
                let prekey = target
                    .one_time_key
                    .map(|entry| entry.key)
                    .or_else(|| target.fallback.map(|entry| entry.key))
                    .expect("target prekey");
                let outbound = create_outbound_and_encrypt(
                    &account,
                    &key,
                    &target.identity_key,
                    &prekey,
                    &text_payload(&text),
                )
                .expect("outbound");
                fs::write(&session_path, &outbound.session_pickle).expect("session");
                Wire {
                    payload_type: outbound.message_type,
                    payload: outbound.message,
                }
            };
            println!("{}", serde_json::to_string(&wire).expect("json"));
        }
        "receive" => {
            let kind = args.next().unwrap_or_else(|| "prekey".into());
            let payload = args.next().expect("payload");
            let peer_identity = args.next().expect("peer identity");
            let key = read_text(&key_path);
            let account = read_text(&account_path);
            let session_path = dir.join("session.pickle");
            let (plaintext_b64, next_session) = if kind == "normal" && session_path.exists() {
                let session = read_text(&session_path);
                let decrypted = decrypt(&session, &key, "normal", &payload).expect("decrypt");
                (decrypted.plaintext_b64, decrypted.session_pickle)
            } else {
                if kind != "prekey" {
                    panic!("receive: expected prekey or an open normal session");
                }
                let inbound = create_inbound_and_decrypt(&account, &key, &peer_identity, &payload)
                    .expect("inbound");
                fs::write(&account_path, &inbound.account_pickle).expect("account");
                (inbound.plaintext_b64, inbound.session_pickle)
            };
            fs::write(&session_path, &next_session).expect("session");
            let decoded = unb64(&plaintext_b64);
            let json: serde_json::Value = serde_json::from_slice(&decoded).expect("json");
            println!("{}", json.get("text").and_then(|v| v.as_str()).unwrap_or(""));
        }
        _ => panic!("commands: init | send | receive"),
    }
}

use std::panic::{catch_unwind, AssertUnwindSafe};

use jni::objects::{JByteArray, JObject, JString};
use jni::sys::jstring;
use jni::JNIEnv;
use serde::Serialize;
use zeroize::Zeroizing;

use crate::error::CryptoError;
use crate::{
    create_account_with_key, create_inbound_and_decrypt_with_key,
    create_outbound_and_encrypt_with_key, decrypt_file, decrypt_with_key, encrypt_file,
    encrypt_with_key, generate_fallback_key_signed_with_key,
    generate_one_time_keys_signed_with_key, generate_one_time_keys_with_key, self_test,
    verify_prekey,
};

/// Lit une chaîne sensible : la copie Rust est effacée à la libération.
/// (La copie côté JVM, immuable, ne peut pas être zeroïsée : risque résiduel
/// documenté pour les entrées qui existent déjà côté JS.)
fn read_secret_string(env: &mut JNIEnv, value: &JString) -> Result<Zeroizing<String>, CryptoError> {
    env.get_string(value)
        .map(|reference| Zeroizing::new(String::from(reference)))
        .map_err(|_| CryptoError::InvalidInput)
}

/// Lit un tableau d'octets sensible (clé de pickle, clé de fichier) : les deux
/// copies intermédiaires (jbyte i8 puis u8) sont effacées à la libération.
fn read_secret_bytes(
    env: &mut JNIEnv,
    value: &JByteArray,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let length = env
        .get_array_length(value)
        .map_err(|_| CryptoError::InvalidInput)? as usize;
    let mut scratch = Zeroizing::new(vec![0i8; length]);
    env.get_byte_array_region(value, 0, &mut scratch[..])
        .map_err(|_| CryptoError::InvalidInput)?;
    let bytes = scratch.iter().map(|&byte| byte as u8).collect::<Vec<u8>>();
    Ok(Zeroizing::new(bytes))
}

/// Clé de pickle brute : exactement 32 octets, jamais en base64 côté JVM.
fn read_pickle_key(
    env: &mut JNIEnv,
    value: &JByteArray,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let key = read_secret_bytes(env, value)?;
    if key.len() != 32 {
        return Err(CryptoError::InvalidInput);
    }
    Ok(key)
}

fn finish<T: Serialize>(env: &mut JNIEnv, result: Result<T, CryptoError>) -> jstring {
    let payload = match result {
        Ok(value) => serde_json::json!({ "ok": true, "data": value }).to_string(),
        Err(error) => serde_json::json!({ "ok": false, "error": error.code() }).to_string(),
    };
    env.new_string(payload)
        .map(JString::into_raw)
        .unwrap_or(std::ptr::null_mut())
}

fn guarded<T>(f: impl FnOnce() -> Result<T, CryptoError>) -> Result<T, CryptoError> {
    catch_unwind(AssertUnwindSafe(f)).unwrap_or(Err(CryptoError::Internal))
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_mbolocrypto_MboloCryptoNative_nativeVersion(
    mut env: JNIEnv,
    _this: JObject,
) -> jstring {
    finish(
        &mut env,
        Ok(serde_json::json!({ "version": env!("CARGO_PKG_VERSION") })),
    )
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_mbolocrypto_MboloCryptoNative_nativeCreateAccount(
    mut env: JNIEnv,
    _this: JObject,
    pickle_key: JByteArray,
) -> jstring {
    let key = match read_pickle_key(&mut env, &pickle_key) {
        Ok(value) => value,
        Err(error) => return finish::<()>(&mut env, Err(error)),
    };
    finish(&mut env, guarded(|| create_account_with_key(&key)))
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_mbolocrypto_MboloCryptoNative_nativeGenerateOneTimeKeys(
    mut env: JNIEnv,
    _this: JObject,
    account_pickle: JString,
    pickle_key: JByteArray,
    count: jni::sys::jint,
) -> jstring {
    let (account, key) = match (
        read_secret_string(&mut env, &account_pickle),
        read_pickle_key(&mut env, &pickle_key),
    ) {
        (Ok(account), Ok(key)) => (account, key),
        (Err(error), _) | (_, Err(error)) => return finish::<()>(&mut env, Err(error)),
    };
    if count <= 0 {
        return finish::<()>(&mut env, Err(CryptoError::InvalidInput));
    }
    finish(
        &mut env,
        guarded(|| generate_one_time_keys_with_key(&account, &key, count as usize)),
    )
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_mbolocrypto_MboloCryptoNative_nativeCreateOutbound(
    mut env: JNIEnv,
    _this: JObject,
    account_pickle: JString,
    pickle_key: JByteArray,
    identity_key: JString,
    one_time_key: JString,
    plaintext_b64: JString,
) -> jstring {
    let (account, key, identity, otk, plaintext) = match (
        read_secret_string(&mut env, &account_pickle),
        read_pickle_key(&mut env, &pickle_key),
        read_secret_string(&mut env, &identity_key),
        read_secret_string(&mut env, &one_time_key),
        read_secret_string(&mut env, &plaintext_b64),
    ) {
        (Ok(a), Ok(k), Ok(i), Ok(o), Ok(p)) => (a, k, i, o, p),
        (Err(error), ..)
        | (_, Err(error), ..)
        | (_, _, Err(error), ..)
        | (_, _, _, Err(error), _)
        | (_, _, _, _, Err(error)) => return finish::<()>(&mut env, Err(error)),
    };
    let mut buffer = Zeroizing::new(match crate::b64::decode(&plaintext) {
        Ok(value) => value,
        Err(error) => return finish::<()>(&mut env, Err(error)),
    });
    finish(
        &mut env,
        guarded(|| {
            create_outbound_and_encrypt_with_key(&account, &key, &identity, &otk, &mut buffer)
        }),
    )
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_mbolocrypto_MboloCryptoNative_nativeEncrypt(
    mut env: JNIEnv,
    _this: JObject,
    session_pickle: JString,
    pickle_key: JByteArray,
    plaintext_b64: JString,
) -> jstring {
    let (session, key, plaintext) = match (
        read_secret_string(&mut env, &session_pickle),
        read_pickle_key(&mut env, &pickle_key),
        read_secret_string(&mut env, &plaintext_b64),
    ) {
        (Ok(s), Ok(k), Ok(p)) => (s, k, p),
        (Err(error), ..) | (_, Err(error), _) | (_, _, Err(error)) => {
            return finish::<()>(&mut env, Err(error))
        }
    };
    let mut buffer = Zeroizing::new(match crate::b64::decode(&plaintext) {
        Ok(value) => value,
        Err(error) => return finish::<()>(&mut env, Err(error)),
    });
    finish(
        &mut env,
        guarded(|| encrypt_with_key(&session, &key, &mut buffer)),
    )
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_mbolocrypto_MboloCryptoNative_nativeCreateInbound(
    mut env: JNIEnv,
    _this: JObject,
    account_pickle: JString,
    pickle_key: JByteArray,
    identity_key: JString,
    prekey_message: JString,
) -> jstring {
    let (account, key, identity, message) = match (
        read_secret_string(&mut env, &account_pickle),
        read_pickle_key(&mut env, &pickle_key),
        read_secret_string(&mut env, &identity_key),
        read_secret_string(&mut env, &prekey_message),
    ) {
        (Ok(a), Ok(k), Ok(i), Ok(m)) => (a, k, i, m),
        (Err(error), ..) | (_, Err(error), ..) | (_, _, Err(error), _) | (_, _, _, Err(error)) => {
            return finish::<()>(&mut env, Err(error))
        }
    };
    finish(
        &mut env,
        guarded(|| create_inbound_and_decrypt_with_key(&account, &key, &identity, &message)),
    )
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_mbolocrypto_MboloCryptoNative_nativeDecrypt(
    mut env: JNIEnv,
    _this: JObject,
    session_pickle: JString,
    pickle_key: JByteArray,
    message_type: JString,
    message_b64: JString,
) -> jstring {
    let (session, key, kind, message) = match (
        read_secret_string(&mut env, &session_pickle),
        read_pickle_key(&mut env, &pickle_key),
        read_secret_string(&mut env, &message_type),
        read_secret_string(&mut env, &message_b64),
    ) {
        (Ok(s), Ok(k), Ok(t), Ok(m)) => (s, k, t, m),
        (Err(error), ..) | (_, Err(error), ..) | (_, _, Err(error), _) | (_, _, _, Err(error)) => {
            return finish::<()>(&mut env, Err(error))
        }
    };
    finish(
        &mut env,
        guarded(|| decrypt_with_key(&session, &key, &kind, &message)),
    )
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_mbolocrypto_MboloCryptoNative_nativeEncryptFile(
    mut env: JNIEnv,
    _this: JObject,
    input_path: JString,
    output_path: JString,
) -> jstring {
    let values = (
        read_secret_string(&mut env, &input_path),
        read_secret_string(&mut env, &output_path),
    );
    let (input, output) = match values {
        (Ok(i), Ok(o)) => (i, o),
        (Err(error), _) | (_, Err(error)) => return finish::<()>(&mut env, Err(error)),
    };
    finish(
        &mut env,
        guarded(|| encrypt_file(std::path::Path::new(&input), std::path::Path::new(&output))),
    )
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_mbolocrypto_MboloCryptoNative_nativeDecryptFile(
    mut env: JNIEnv,
    _this: JObject,
    input_path: JString,
    output_path: JString,
    file_key: JByteArray,
    nonce: JByteArray,
    expected_sha256: JString,
) -> jstring {
    let (input, output, key, nonce, expected) = match (
        read_secret_string(&mut env, &input_path),
        read_secret_string(&mut env, &output_path),
        read_secret_bytes(&mut env, &file_key),
        read_secret_bytes(&mut env, &nonce),
        read_secret_string(&mut env, &expected_sha256),
    ) {
        (Ok(i), Ok(o), Ok(k), Ok(n), Ok(s)) => (i, o, k, n, s),
        (Err(error), ..)
        | (_, Err(error), ..)
        | (_, _, Err(error), ..)
        | (_, _, _, Err(error), _)
        | (_, _, _, _, Err(error)) => return finish::<()>(&mut env, Err(error)),
    };
    let expected = if expected.is_empty() {
        None
    } else {
        Some(expected.as_str())
    };
    // decrypt_file attend du base64 : l'encodage des octets bruts reste confiné
    // dans des Zeroizing libérées dès l'appel.
    let key_b64 = Zeroizing::new(crate::b64::encode(&key));
    let nonce_b64 = Zeroizing::new(crate::b64::encode(&nonce));
    finish(
        &mut env,
        guarded(|| {
            decrypt_file(
                std::path::Path::new(&input),
                std::path::Path::new(&output),
                &key_b64,
                &nonce_b64,
                expected,
            )
            .map(|size| serde_json::json!({ "plaintext_size": size }))
        }),
    )
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_mbolocrypto_MboloCryptoNative_nativeSelfTest(
    mut env: JNIEnv,
    _this: JObject,
    work_dir: JString,
    file_mb: jni::sys::jint,
) -> jstring {
    let directory = match read_secret_string(&mut env, &work_dir) {
        Ok(value) => value,
        Err(error) => return finish::<()>(&mut env, Err(error)),
    };
    if file_mb <= 0 {
        return finish::<()>(&mut env, Err(CryptoError::InvalidInput));
    }
    finish(
        &mut env,
        guarded(|| self_test(std::path::Path::new(&directory), file_mb as usize)),
    )
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_mbolocrypto_MboloCryptoNative_nativeGenerateOneTimeKeysSigned(
    mut env: JNIEnv,
    _this: JObject,
    account_pickle: JString,
    pickle_key: JByteArray,
    count: jni::sys::jint,
) -> jstring {
    let (account, key) = match (
        read_secret_string(&mut env, &account_pickle),
        read_pickle_key(&mut env, &pickle_key),
    ) {
        (Ok(account), Ok(key)) => (account, key),
        (Err(error), _) | (_, Err(error)) => return finish::<()>(&mut env, Err(error)),
    };
    if count <= 0 {
        return finish::<()>(&mut env, Err(CryptoError::InvalidInput));
    }
    finish(
        &mut env,
        guarded(|| generate_one_time_keys_signed_with_key(&account, &key, count as usize)),
    )
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_mbolocrypto_MboloCryptoNative_nativeGenerateFallbackKeySigned(
    mut env: JNIEnv,
    _this: JObject,
    account_pickle: JString,
    pickle_key: JByteArray,
) -> jstring {
    let (account, key) = match (
        read_secret_string(&mut env, &account_pickle),
        read_pickle_key(&mut env, &pickle_key),
    ) {
        (Ok(account), Ok(key)) => (account, key),
        (Err(error), _) | (_, Err(error)) => return finish::<()>(&mut env, Err(error)),
    };
    finish(
        &mut env,
        guarded(|| generate_fallback_key_signed_with_key(&account, &key)),
    )
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_mbolocrypto_MboloCryptoNative_nativeVerifyPrekey(
    mut env: JNIEnv,
    _this: JObject,
    signing_key: JString,
    prekey: JString,
    signature: JString,
) -> jstring {
    let (signing, key, sig) = match (
        read_secret_string(&mut env, &signing_key),
        read_secret_string(&mut env, &prekey),
        read_secret_string(&mut env, &signature),
    ) {
        (Ok(s), Ok(k), Ok(v)) => (s, k, v),
        (Err(error), ..) | (_, Err(error), _) | (_, _, Err(error)) => {
            return finish::<()>(&mut env, Err(error))
        }
    };
    finish(
        &mut env,
        guarded(|| {
            verify_prekey(&signing, &key, &sig).map(|valid| serde_json::json!({ "valid": valid }))
        }),
    )
}

use std::panic::{catch_unwind, AssertUnwindSafe};

use jni::objects::{JObject, JString};
use jni::sys::jstring;
use jni::JNIEnv;
use serde::Serialize;

use crate::error::CryptoError;
use crate::{
    create_account, create_inbound_and_decrypt, create_outbound_and_encrypt, decrypt, decrypt_file,
    encrypt, encrypt_file, generate_one_time_keys,
};

fn read_string(env: &mut JNIEnv, value: &JString) -> Result<String, CryptoError> {
    env.get_string(value)
        .map(Into::into)
        .map_err(|_| CryptoError::InvalidInput)
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
    pickle_key: JString,
) -> jstring {
    let key = match read_string(&mut env, &pickle_key) {
        Ok(value) => value,
        Err(error) => return finish::<()>(&mut env, Err(error)),
    };
    finish(&mut env, guarded(|| create_account(&key)))
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_mbolocrypto_MboloCryptoNative_nativeGenerateOneTimeKeys(
    mut env: JNIEnv,
    _this: JObject,
    account_pickle: JString,
    pickle_key: JString,
    count: jni::sys::jint,
) -> jstring {
    let (account, key) = match (
        read_string(&mut env, &account_pickle),
        read_string(&mut env, &pickle_key),
    ) {
        (Ok(account), Ok(key)) => (account, key),
        (Err(error), _) | (_, Err(error)) => return finish::<()>(&mut env, Err(error)),
    };
    if count <= 0 {
        return finish::<()>(&mut env, Err(CryptoError::InvalidInput));
    }
    finish(
        &mut env,
        guarded(|| generate_one_time_keys(&account, &key, count as usize)),
    )
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_mbolocrypto_MboloCryptoNative_nativeCreateOutbound(
    mut env: JNIEnv,
    _this: JObject,
    account_pickle: JString,
    pickle_key: JString,
    identity_key: JString,
    one_time_key: JString,
    plaintext_b64: JString,
) -> jstring {
    let values = (
        read_string(&mut env, &account_pickle),
        read_string(&mut env, &pickle_key),
        read_string(&mut env, &identity_key),
        read_string(&mut env, &one_time_key),
        read_string(&mut env, &plaintext_b64),
    );
    let (account, key, identity, otk, plaintext) = match values {
        (Ok(a), Ok(k), Ok(i), Ok(o), Ok(p)) => (a, k, i, o, p),
        (Err(error), ..)
        | (_, Err(error), ..)
        | (_, _, Err(error), ..)
        | (_, _, _, Err(error), _)
        | (_, _, _, _, Err(error)) => return finish::<()>(&mut env, Err(error)),
    };
    finish(
        &mut env,
        guarded(|| create_outbound_and_encrypt(&account, &key, &identity, &otk, &plaintext)),
    )
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_mbolocrypto_MboloCryptoNative_nativeEncrypt(
    mut env: JNIEnv,
    _this: JObject,
    session_pickle: JString,
    pickle_key: JString,
    plaintext_b64: JString,
) -> jstring {
    let values = (
        read_string(&mut env, &session_pickle),
        read_string(&mut env, &pickle_key),
        read_string(&mut env, &plaintext_b64),
    );
    let (session, key, plaintext) = match values {
        (Ok(s), Ok(k), Ok(p)) => (s, k, p),
        (Err(error), ..) | (_, Err(error), _) | (_, _, Err(error)) => {
            return finish::<()>(&mut env, Err(error))
        }
    };
    finish(&mut env, guarded(|| encrypt(&session, &key, &plaintext)))
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_mbolocrypto_MboloCryptoNative_nativeCreateInbound(
    mut env: JNIEnv,
    _this: JObject,
    account_pickle: JString,
    pickle_key: JString,
    identity_key: JString,
    prekey_message: JString,
) -> jstring {
    let values = (
        read_string(&mut env, &account_pickle),
        read_string(&mut env, &pickle_key),
        read_string(&mut env, &identity_key),
        read_string(&mut env, &prekey_message),
    );
    let (account, key, identity, message) = match values {
        (Ok(a), Ok(k), Ok(i), Ok(m)) => (a, k, i, m),
        (Err(error), ..) | (_, Err(error), ..) | (_, _, Err(error), _) | (_, _, _, Err(error)) => {
            return finish::<()>(&mut env, Err(error))
        }
    };
    finish(
        &mut env,
        guarded(|| create_inbound_and_decrypt(&account, &key, &identity, &message)),
    )
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_mbolocrypto_MboloCryptoNative_nativeDecrypt(
    mut env: JNIEnv,
    _this: JObject,
    session_pickle: JString,
    pickle_key: JString,
    message_type: JString,
    message_b64: JString,
) -> jstring {
    let values = (
        read_string(&mut env, &session_pickle),
        read_string(&mut env, &pickle_key),
        read_string(&mut env, &message_type),
        read_string(&mut env, &message_b64),
    );
    let (session, key, kind, message) = match values {
        (Ok(s), Ok(k), Ok(t), Ok(m)) => (s, k, t, m),
        (Err(error), ..) | (_, Err(error), ..) | (_, _, Err(error), _) | (_, _, _, Err(error)) => {
            return finish::<()>(&mut env, Err(error))
        }
    };
    finish(
        &mut env,
        guarded(|| decrypt(&session, &key, &kind, &message)),
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
        read_string(&mut env, &input_path),
        read_string(&mut env, &output_path),
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
    file_key_b64: JString,
    nonce_b64: JString,
    expected_sha256: JString,
) -> jstring {
    let values = (
        read_string(&mut env, &input_path),
        read_string(&mut env, &output_path),
        read_string(&mut env, &file_key_b64),
        read_string(&mut env, &nonce_b64),
        read_string(&mut env, &expected_sha256),
    );
    let (input, output, key, nonce, expected) = match values {
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
    finish(
        &mut env,
        guarded(|| {
            decrypt_file(
                std::path::Path::new(&input),
                std::path::Path::new(&output),
                &key,
                &nonce,
                expected,
            )
            .map(|size| serde_json::json!({ "plaintext_size": size }))
        }),
    )
}

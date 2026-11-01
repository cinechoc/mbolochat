//! Compatibilité du noyau avec des références **indépendantes** de notre
//! harnais de test scripté.
//!
//! Deux familles de vecteurs sont figées ici :
//!
//! 1. Des sorties produites par **libolm 3.2.16** (l'implémentation de
//!    référence en C), générées une fois par `scripts/gen-libolm-vectors.c`
//!    avec un PRNG déterministe. Elles prouvent que ce que nous produisons et
//!    consommons est bien au format Olm tel que défini par la bibliothèque
//!    historique, et pas seulement cohérent avec nous-mêmes.
//! 2. Les vecteurs officiels **RFC 8032** (Ed25519) pour la primitive de
//!    signature, indépendants de tout code Olm.
//!
//! Ces tests n'ont pas besoin que libolm soit installé : les valeurs sont
//! figées ci-dessous. Pour les renouveler, recompiler et relancer le
//! générateur puis coller les nouvelles constantes.
//!
//! Rappel : `vodozemac` est ici en dépendance de développement avec la
//! fonctionnalité `libolm-compat`, ce qui n'entre **pas** dans le binaire
//! livré (le noyau embarque vodozemac sans cette fonctionnalité).

use base64::Engine;
use mbolo_crypto::verify_prekey;
use vodozemac::olm::{Account, PreKeyMessage, SessionConfig};
use vodozemac::{Curve25519PublicKey, Ed25519PublicKey, Ed25519Signature};

/// Clé de pickle fixe (32 octets) partagée avec `scripts/gen-libolm-vectors.c`.
const PICKLE_KEY: &[u8] = b"mbolo-libolm-compat-vector-key32";

/// Texte clair chiffré par libolm dans le vecteur pré-clé.
const PLAINTEXT: &[u8] = b"Message de compatibilite libolm vers vodozemac.";

/// Compte Bob picklé par libolm (format libolm, version 4).
const BOB_LIBOLM_PICKLE: &str = "i/ONTj449KdenHPk7ftAzC/b1uQm98lII+Dy9zNN/QlRf5N+Fjl5XjAC+c62CjI93jiU26R5d5cIr4XyaGHHRSl176TZ1k8N5cxnqSED9Mgr0aHz73cjGeyfl3fYc0anQRgGZstrVf2asyxcORLXDfQ3z9KWH5w5QfOzloEpHImzNr1keL9ui0aV/7vyeg6LqAZ82KERTjxYjP/8E1Kv3V2XYVUQ7aoGeuE7ehnp0SBANh6f8eRkroJ6UsFeiVXDGd4EJXMgEXXu4cYNuiXXUh3tqHgLZWUZjNJfFUzxdwW1AUYTRT68TUcca3/2zOEVjwH7pfc9Ud8MPL548BXZJchWBR6JAlh8";
const BOB_CURVE25519: &str = "nbEhZ0/Z1vir6agfO/85vMoiYOR24D38b5g1dq6jhEs";
const BOB_ED25519: &str = "ND5K2G/bbn6MFx8MB0H+9RIkIwEn1wky7p02ygRs4zA";
const BOB_ONE_TIME_KEY: &str = "j8xoutlMBOXuCFZQJOcouxhFLVWUAUTplq3WwYdqzQc";
const BOB_ONE_TIME_KEY_SIGNATURE: &str =
    "ev7nc4GzwPf3YiKemjUuj8XxEdRFxFCvoVF7mP17wYIQdbxelURHT89LIFcqwqNC3HZrhGcyPgA4X+xr1+FeCw";

/// Compte Alice (libolm) et le message pré-clé qu'elle a chiffré vers Bob.
const ALICE_CURVE25519: &str = "+zmcJaDgkh2ZJO65vFTrcTi4AGlXhmzm5Ypdkxm50mE";
const PREKEY_MESSAGE: &str = "Awogj8xoutlMBOXuCFZQJOcouxhFLVWUAUTplq3WwYdqzQcSIKZoVlwyFIk19uZloU1NHWp4vO2YljXehy+yyTsnm/V5GiD7OZwloOCSHZkk7rm8VOtxOLgAaVeGbOblil2TGbnSYSJfAwog6Mc6djv+dKg2tXEQX/ZnnTMzVg8QFF2IdykKk7sm8AAQACIw4GD7zrCAR161XD6ssb51fLr6GRfxkJ6s+BLJqDwh127f0zHfavoNLUe/UUSN/Z1EFDmazMrk0mA";

fn b64(input: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(input)
}

/// Le noyau ouvre un pickle écrit par libolm : preuve de compatibilité du
/// format de compte (dérivation AES/IV, structure du pickle, version 4).
#[test]
fn opens_libolm_account_pickle() {
    let account = Account::from_libolm_pickle(BOB_LIBOLM_PICKLE, PICKLE_KEY)
        .expect("le pickle libolm doit s'ouvrir");
    let identity = account.identity_keys();
    assert_eq!(identity.curve25519.to_base64(), BOB_CURVE25519);
    assert_eq!(identity.ed25519.to_base64(), BOB_ED25519);
}

/// Interopérabilité complète : un message pré-clé produit par libolm (Alice)
/// est déchiffré par vodozemac (Bob) et redonne le texte clair attendu.
#[test]
fn decrypts_libolm_prekey_message() {
    let mut bob = Account::from_libolm_pickle(BOB_LIBOLM_PICKLE, PICKLE_KEY)
        .expect("le pickle libolm doit s'ouvrir");
    let alice_key = Curve25519PublicKey::from_base64(ALICE_CURVE25519).unwrap();
    let message = PreKeyMessage::from_base64(PREKEY_MESSAGE).unwrap();
    let result = bob
        .create_inbound_session(SessionConfig::version_1(), alice_key, &message)
        .expect("la session entrante doit se créer");
    assert_eq!(result.plaintext, PLAINTEXT);
}

/// Une signature Ed25519 produite par libolm est acceptée, et une altération du
/// message la fait échouer : la vérification n'est pas un simple « oui ».
#[test]
fn verifies_libolm_signature() {
    let signing = Ed25519PublicKey::from_base64(BOB_ED25519).unwrap();
    let signature = Ed25519Signature::from_base64(BOB_ONE_TIME_KEY_SIGNATURE).unwrap();
    let prekey = Curve25519PublicKey::from_base64(BOB_ONE_TIME_KEY).unwrap();
    signing
        .verify(prekey.as_bytes(), &signature)
        .expect("la signature libolm doit vérifier");

    let mut tampered = prekey.as_bytes().to_vec();
    tampered[0] ^= 0x01;
    assert!(
        signing.verify(&tampered, &signature).is_err(),
        "une clé modifiée ne doit pas vérifier"
    );
}

/// Le même vecteur libolm passe par **notre** fonction de vérification
/// (`verify_prekey`, exposée jusqu'à la frontière JNI) : c'est le chemin de
/// code réellement utilisé par l'application qui est exercé ici.
#[test]
fn our_verify_prekey_accepts_libolm_vectors() {
    assert!(verify_prekey(BOB_ED25519, BOB_ONE_TIME_KEY, BOB_ONE_TIME_KEY_SIGNATURE).unwrap());

    // Mauvais signataire : la signature ne doit plus correspondre.
    let other_signing = "PUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw";
    assert!(!verify_prekey(other_signing, BOB_ONE_TIME_KEY, BOB_ONE_TIME_KEY_SIGNATURE).unwrap());

    // Signature d'une autre clé : rejet attendu.
    let other_signature =
        "kqAJqfDUyrhyDoILX2QlQKKye1QWUD+Ps3YiI+vbadoIWsHkPhWZbkWPNhPQ8R2MOHsurrQwKu6wDSkWErsMAA";
    assert!(!verify_prekey(BOB_ED25519, BOB_ONE_TIME_KEY, other_signature).unwrap());
}

/// Vecteurs officiels RFC 8032 (Ed25519). Ils valident la primitive de
/// signature du noyau contre la référence normative, sans dépendre d'Olm ni de
/// libolm.
#[test]
fn verifies_rfc8032_official_vectors() {
    // TEST 1 : message vide.
    check_rfc8032(
        "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=",
        b"",
        "5VZDAMNgrHKQhuLMgG6CioSHfx645dl02HPgZSJJAVVfuIIVkKM7rMYeOXAc+bRr0lv18FlbviRlUUFDjnoQCw==",
    );
    // TEST 2 : message d'un octet (0x72).
    check_rfc8032(
        "PUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=",
        &[0x72],
        "kqAJqfDUyrhyDoILX2QlQKKye1QWUD+Ps3YiI+vbadoIWsHkPhWZbkWPNhPQ8R2MOHsurrQwKu6wDSkWErsMAA==",
    );
    // TEST 3 : message de deux octets (0xaf 0x82).
    check_rfc8032(
        "/FHNjmIYoaONpH7QAjDwWAgW7RO6MwOsXeuRFUiQgCU=",
        &[0xaf, 0x82],
        "YpHWV97sJAJIJ+acOr4BowzlSKKEdDpEXjaA19taw6wY/5tTjRbykK5n92CYTcZZSnwV6XFu0o3AJ77O6h7ECg==",
    );
}

fn check_rfc8032(public_b64: &str, message: &[u8], signature_b64: &str) {
    let public = Ed25519PublicKey::from_base64(public_b64).unwrap();
    let signature = Ed25519Signature::from_base64(signature_b64).unwrap();
    public
        .verify(message, &signature)
        .expect("le vecteur RFC 8032 doit vérifier");

    // Le message modifié doit être rejeté (le vecteur ne passe pas par hasard).
    let mut tampered = message.to_vec();
    tampered.push(0x00);
    assert!(public.verify(&tampered, &signature).is_err());
}

/// Non-régression sur notre propre format : une clé signée par notre noyau est
/// vérifiable, et le champ base64 non padé que nous émettons reste lisible par
/// l'implémentation de référence (donc interopérable dans les deux sens).
#[test]
fn our_signed_key_format_is_interoperable() {
    let key_b64 = b64(&[7u8; 32]);
    let created = mbolo_crypto::create_account(&key_b64).unwrap();
    let signed =
        mbolo_crypto::generate_one_time_keys_signed(&created.account_pickle, &key_b64, 1).unwrap();
    let key = &signed.keys[0];

    // Notre chemin de vérification interne.
    assert!(verify_prekey(&created.ed25519, &key.key, &key.signature).unwrap());

    // Les mêmes chaînes, relues par la référence : format base64 non padé
    // accepté des deux côtés.
    let signing = Ed25519PublicKey::from_base64(&created.ed25519).unwrap();
    let signature = Ed25519Signature::from_base64(&key.signature).unwrap();
    let prekey = Curve25519PublicKey::from_base64(&key.key).unwrap();
    signing
        .verify(prekey.as_bytes(), &signature)
        .expect("notre signature doit vérifier côté vodozemac");

    // Une clé substituée ne doit pas vérifier : la signature lie bien le contenu.
    let other =
        mbolo_crypto::generate_one_time_keys_signed(&created.account_pickle, &key_b64, 1).unwrap();
    assert!(!verify_prekey(&created.ed25519, &other.keys[0].key, &key.signature).unwrap());
}

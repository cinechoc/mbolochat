/*
 * Génère une fois des vecteurs de compatibilité croisée libolm → vodozemac.
 *
 * Les sorties de ce programme sont figées dans crypto/tests/compat_vectors.rs :
 * elles proviennent de libolm (implémentation de référence C), indépendamment
 * de notre noyau Rust. Regénérer n'est nécessaire que pour renouveler les
 * vecteurs ; le test n'a pas besoin de libolm.
 *
 * Le "hasard" est un générateur déterministe (xorshift) destiné uniquement à
 * rendre les vecteurs reproductibles : relancer ce programme doit redonner
 * exactement les mêmes valeurs. Il ne faut donc jamais s'en servir hors de ce
 * script de génération hors-ligne.
 *
 * Build : cc -o /tmp/gen-libolm-vectors scripts/gen-libolm-vectors.c -lolm -lm
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include <olm/olm.h>

/* Clé de pickle fixe, 32 octets exactement (même clé dans le test Rust). */
static const uint8_t PICKLE_KEY[32] = "mbolo-libolm-compat-vector-key32";
static const char PLAINTEXT[] = "Message de compatibilite libolm vers vodozemac.";

/* PRNG déterministe (xorshift64*), graine fixe. */
static uint64_t prng_state = 0x9e3779b97f4a7c15ULL;

static void random_buffer(uint8_t *buffer, size_t length) {
  for (size_t i = 0; i < length; i++) {
    prng_state ^= prng_state >> 12;
    prng_state ^= prng_state << 25;
    prng_state ^= prng_state >> 27;
    buffer[i] = (uint8_t)((prng_state * 0x2545f4914f6cdd1dULL) >> 56);
  }
}

static uint8_t *alloc_random(size_t length) {
  uint8_t *buffer = malloc(length);
  random_buffer(buffer, length);
  return buffer;
}

/* Extrait la première valeur "clé":"valeur" du JSON des clés à usage unique. */
static void extract_one_time_key(const char *json, char *out, size_t out_len) {
  const char *start = strstr(json, "\":\"");
  if (!start) { fprintf(stderr, "OTK introuvable\n"); exit(1); }
  start += 3;
  const char *end = strchr(start, '"');
  if (!end) { fprintf(stderr, "OTK non terminé\n"); exit(1); }
  size_t length = (size_t)(end - start);
  if (length >= out_len) { fprintf(stderr, "OTK trop long\n"); exit(1); }
  memcpy(out, start, length);
  out[length] = '\0';
}

static void print_label(const char *label, const char *value) {
  printf("%s=%s\n", label, value);
}

/* Décodeur base64 minimal (alphabet standard, sans retour à la ligne). */
static size_t base64_decode(const char *input, uint8_t *out, size_t out_len) {
  static const char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  int values[256];
  for (int i = 0; i < 256; i++) { values[i] = -1; }
  for (int i = 0; i < 64; i++) { values[(uint8_t)alphabet[i]] = i; }

  size_t produced = 0;
  uint32_t accumulator = 0;
  int bits = 0;
  for (const char *cursor = input; *cursor; cursor++) {
    int value = values[(uint8_t)*cursor];
    if (value < 0) { continue; }
    accumulator = (accumulator << 6) | (uint32_t)value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (produced >= out_len) { return (size_t)-1; }
      out[produced++] = (uint8_t)((accumulator >> bits) & 0xFF);
    }
  }
  return produced;
}

int main(void) {
  /* --- Compte Bob : identité + une clé à usage unique, pickle libolm --- */
  OlmAccount *bob = olm_account(malloc(olm_account_size()));
  size_t random_length = olm_create_account_random_length(bob);
  uint8_t *random = alloc_random(random_length);
  if (olm_create_account(bob, random, random_length) == olm_error()) {
    fprintf(stderr, "create_account: %s\n", olm_account_last_error(bob));
    return 1;
  }
  free(random);

  random_length = olm_account_generate_one_time_keys_random_length(bob, 1);
  random = alloc_random(random_length);
  if (olm_account_generate_one_time_keys(bob, 1, random, random_length) == olm_error()) {
    fprintf(stderr, "generate_one_time_keys: %s\n", olm_account_last_error(bob));
    return 1;
  }
  free(random);

  size_t keys_length = olm_account_identity_keys_length(bob);
  char *keys = malloc(keys_length + 1);
  olm_account_identity_keys(bob, keys, keys_length);
  keys[keys_length] = '\0';
  /* JSON : {"curve25519":"...","ed25519":"..."} */
  char bob_curve25519[64], bob_ed25519[64];
  const char *curve_start = strstr(keys, "curve25519\":\"") + strlen("curve25519\":\"");
  const char *curve_end = strchr(curve_start, '"');
  memcpy(bob_curve25519, curve_start, (size_t)(curve_end - curve_start));
  bob_curve25519[curve_end - curve_start] = '\0';
  const char *ed_start = strstr(keys, "ed25519\":\"") + strlen("ed25519\":\"");
  const char *ed_end = strchr(ed_start, '"');
  memcpy(bob_ed25519, ed_start, (size_t)(ed_end - ed_start));
  bob_ed25519[ed_end - ed_start] = '\0';

  size_t otk_length = olm_account_one_time_keys_length(bob);
  char *otk_json = malloc(otk_length + 1);
  olm_account_one_time_keys(bob, otk_json, otk_length);
  otk_json[otk_length] = '\0';
  char bob_otk[64];
  extract_one_time_key(otk_json, bob_otk, sizeof(bob_otk));

  /* Signature Ed25519 libolm du dernier mot de 32 octets de la clé OTK : c'est
   * exactement le message que le noyau signe et vérifie côté vodozemac. */
  uint8_t otk_bytes[64];
  size_t otk_size = base64_decode(bob_otk, otk_bytes, sizeof(otk_bytes));
  if (otk_size == (size_t)-1 || otk_size != 32) {
    fprintf(stderr, "OTK non décodable en 32 octets\n");
    return 1;
  }
  size_t signature_length = olm_account_signature_length(bob);
  char *bob_signature = malloc(signature_length + 1);
  if (olm_account_sign(bob, otk_bytes, otk_size, bob_signature, signature_length) == olm_error()) {
    fprintf(stderr, "sign: %s\n", olm_account_last_error(bob));
    return 1;
  }
  bob_signature[signature_length] = '\0';

  size_t pickle_length = olm_pickle_account_length(bob);
  char *bob_pickle = malloc(pickle_length + 1);
  if (olm_pickle_account(bob, PICKLE_KEY, sizeof(PICKLE_KEY), bob_pickle, pickle_length) == olm_error()) {
    fprintf(stderr, "pickle_account: %s\n", olm_account_last_error(bob));
    return 1;
  }
  bob_pickle[pickle_length] = '\0';

  /* --- Compte Alice + session sortante vers Bob + message prékey --- */
  OlmAccount *alice = olm_account(malloc(olm_account_size()));
  random_length = olm_create_account_random_length(alice);
  random = alloc_random(random_length);
  if (olm_create_account(alice, random, random_length) == olm_error()) {
    fprintf(stderr, "create_account alice: %s\n", olm_account_last_error(alice));
    return 1;
  }
  free(random);

  keys_length = olm_account_identity_keys_length(alice);
  keys = malloc(keys_length + 1);
  olm_account_identity_keys(alice, keys, keys_length);
  keys[keys_length] = '\0';
  curve_start = strstr(keys, "curve25519\":\"") + strlen("curve25519\":\"");
  curve_end = strchr(curve_start, '"');
  char alice_curve25519[64];
  memcpy(alice_curve25519, curve_start, (size_t)(curve_end - curve_start));
  alice_curve25519[curve_end - curve_start] = '\0';

  OlmSession *session = olm_session(malloc(olm_session_size()));
  random_length = olm_create_outbound_session_random_length(session);
  random = alloc_random(random_length);
  if (olm_create_outbound_session(
          session, alice,
          bob_curve25519, strlen(bob_curve25519),
          bob_otk, strlen(bob_otk),
          random, random_length) == olm_error()) {
    fprintf(stderr, "create_outbound_session: %s\n", olm_session_last_error(session));
    return 1;
  }
  free(random);

  size_t message_type = olm_encrypt_message_type(session);
  size_t encrypt_random_length = olm_encrypt_random_length(session);
  random = alloc_random(encrypt_random_length > 0 ? encrypt_random_length : 1);
  size_t ciphertext_length = olm_encrypt_message_length(session, strlen(PLAINTEXT));
  char *ciphertext = malloc(ciphertext_length + 1);
  if (olm_encrypt(session, PLAINTEXT, strlen(PLAINTEXT),
                  random, encrypt_random_length,
                  ciphertext, ciphertext_length) == olm_error()) {
    fprintf(stderr, "encrypt: %s\n", olm_session_last_error(session));
    return 1;
  }
  ciphertext[ciphertext_length] = '\0';

  /* --- Sorties figées --- */
  print_label("BOB_CURVE25519", bob_curve25519);
  print_label("BOB_ED25519", bob_ed25519);
  print_label("BOB_ONE_TIME_KEY", bob_otk);
  print_label("BOB_ONE_TIME_KEY_SIGNATURE", bob_signature);
  print_label("BOB_LIBOLM_PICKLE", bob_pickle);
  print_label("ALICE_CURVE25519", alice_curve25519);
  printf("PREKEY_MESSAGE_TYPE=%zu\n", message_type);
  print_label("PREKEY_MESSAGE", ciphertext);
  print_label("PLAINTEXT", PLAINTEXT);
  return 0;
}

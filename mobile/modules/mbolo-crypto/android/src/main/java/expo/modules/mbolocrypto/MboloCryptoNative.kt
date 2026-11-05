package expo.modules.mbolocrypto

/**
 * Surface JNI minimale. Toutes les méthodes renvoient un JSON { ok, data|error }.
 *
 * La clé de pickle transite en tableau d'octets bruts (32 octets) : elle
 * n'existe jamais sous forme de String côté JVM, donc aucune copie immuable
 * du secret ne peut persister dans le tas Java. Les tableaux sont zeroïsés
 * par l'appelant (E2eeKeyStore) et par le noyau Rust (Zeroizing).
 */
class MboloCryptoNative {
  companion object {
    init {
      System.loadLibrary("mbolo_crypto")
    }
  }

  external fun nativeVersion(): String
  external fun nativeCreateAccount(pickleKey: ByteArray): String
  external fun nativeGenerateOneTimeKeys(accountPickle: String, pickleKey: ByteArray, count: Int): String
  external fun nativeCreateOutbound(
    accountPickle: String,
    pickleKey: ByteArray,
    identityKey: String,
    oneTimeKey: String,
    plaintextB64: String,
  ): String
  external fun nativeEncrypt(sessionPickle: String, pickleKey: ByteArray, plaintextB64: String): String
  external fun nativeCreateInbound(
    accountPickle: String,
    pickleKey: ByteArray,
    identityKey: String,
    prekeyMessage: String,
  ): String
  external fun nativeDecrypt(
    sessionPickle: String,
    pickleKey: ByteArray,
    messageType: String,
    messageB64: String,
  ): String
  external fun nativeEncryptFile(inputPath: String, outputPath: String): String
  external fun nativeDecryptFile(
    inputPath: String,
    outputPath: String,
    key: ByteArray,
    nonce: ByteArray,
    expectedSha256: String,
  ): String
  external fun nativeSelfTest(workDir: String, fileMb: Int): String
  external fun nativeGenerateOneTimeKeysSigned(accountPickle: String, pickleKey: ByteArray, count: Int): String
  external fun nativeGenerateFallbackKeySigned(accountPickle: String, pickleKey: ByteArray): String
  external fun nativeVerifyPrekey(signingKey: String, prekey: String, signature: String): String
}

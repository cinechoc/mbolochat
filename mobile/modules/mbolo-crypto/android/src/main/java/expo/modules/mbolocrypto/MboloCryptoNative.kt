package expo.modules.mbolocrypto

/** Surface JNI minimale. Toutes les méthodes renvoient un JSON { ok, data|error }. */
class MboloCryptoNative {
  companion object {
    init {
      System.loadLibrary("mbolo_crypto")
    }
  }

  external fun nativeVersion(): String
  external fun nativeCreateAccount(pickleKey: String): String
  external fun nativeGenerateOneTimeKeys(accountPickle: String, pickleKey: String, count: Int): String
  external fun nativeCreateOutbound(
    accountPickle: String,
    pickleKey: String,
    identityKey: String,
    oneTimeKey: String,
    plaintextB64: String,
  ): String
  external fun nativeEncrypt(sessionPickle: String, pickleKey: String, plaintextB64: String): String
  external fun nativeCreateInbound(
    accountPickle: String,
    pickleKey: String,
    identityKey: String,
    prekeyMessage: String,
  ): String
  external fun nativeDecrypt(
    sessionPickle: String,
    pickleKey: String,
    messageType: String,
    messageB64: String,
  ): String
  external fun nativeEncryptFile(inputPath: String, outputPath: String): String
  external fun nativeDecryptFile(
    inputPath: String,
    outputPath: String,
    keyB64: String,
    nonceB64: String,
    expectedSha256: String,
  ): String
}

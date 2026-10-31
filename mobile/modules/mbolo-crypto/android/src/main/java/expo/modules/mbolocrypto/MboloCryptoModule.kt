package expo.modules.mbolocrypto

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Les AsyncFunction d'Expo s'exécutent sur une file native dédiée : aucun
 * chiffrement ne doit tourner sur le fil JavaScript.
 */
class MboloCryptoModule : Module() {
  private val native = MboloCryptoNative()

  override fun definition() = ModuleDefinition {
    Name("MboloCrypto")

    Function("version") {
      native.nativeVersion()
    }

    AsyncFunction("createAccount") { pickleKey: String ->
      native.nativeCreateAccount(pickleKey)
    }

    AsyncFunction("generateOneTimeKeys") { accountPickle: String, pickleKey: String, count: Int ->
      native.nativeGenerateOneTimeKeys(accountPickle, pickleKey, count)
    }

    AsyncFunction("createOutbound") {
      accountPickle: String,
      pickleKey: String,
      identityKey: String,
      oneTimeKey: String,
      plaintextB64: String,
      ->
      native.nativeCreateOutbound(accountPickle, pickleKey, identityKey, oneTimeKey, plaintextB64)
    }

    AsyncFunction("encrypt") { sessionPickle: String, pickleKey: String, plaintextB64: String ->
      native.nativeEncrypt(sessionPickle, pickleKey, plaintextB64)
    }

    AsyncFunction("createInbound") {
      accountPickle: String,
      pickleKey: String,
      identityKey: String,
      prekeyMessage: String,
      ->
      native.nativeCreateInbound(accountPickle, pickleKey, identityKey, prekeyMessage)
    }

    AsyncFunction("decrypt") {
      sessionPickle: String,
      pickleKey: String,
      messageType: String,
      messageB64: String,
      ->
      native.nativeDecrypt(sessionPickle, pickleKey, messageType, messageB64)
    }

    AsyncFunction("encryptFile") { inputPath: String, outputPath: String ->
      native.nativeEncryptFile(inputPath, outputPath)
    }

    AsyncFunction("decryptFile") {
      inputPath: String,
      outputPath: String,
      keyB64: String,
      nonceB64: String,
      expectedSha256: String,
      ->
      native.nativeDecryptFile(inputPath, outputPath, keyB64, nonceB64, expectedSha256)
    }
  }
}

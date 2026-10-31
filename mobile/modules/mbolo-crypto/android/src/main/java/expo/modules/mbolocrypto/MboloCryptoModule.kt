package expo.modules.mbolocrypto

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Les AsyncFunction d'Expo s'exécutent sur une file native dédiée : aucun
 * chiffrement ne doit tourner sur le fil JavaScript.
 */
class MboloCryptoModule : Module() {
  private val native = MboloCryptoNative()
  private val keyStore by lazy {
    E2eeKeyStore(requireNotNull(appContext.reactContext) { "Contexte Android indisponible" })
  }

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

    AsyncFunction("selfTest") { workDir: String, fileMb: Int ->
      native.nativeSelfTest(workDir, fileMb)
    }

    AsyncFunction("ensureKeys") {
      keyStore.ensureKeysJson()
    }

    AsyncFunction("sqlCipherKey") {
      keyStore.sqlCipherKeyJson()
    }

    AsyncFunction("secureCreateAccount") {
      keyStore.createAccountJson(native)
    }

    AsyncFunction("secureGenerateOneTimeKeys") { accountPickle: String, count: Int ->
      keyStore.generateOneTimeKeysJson(native, accountPickle, count)
    }

    AsyncFunction("secureGenerateOneTimeKeysSigned") { accountPickle: String, count: Int ->
      keyStore.generateOneTimeKeysSignedJson(native, accountPickle, count)
    }

    AsyncFunction("secureGenerateFallbackKey") { accountPickle: String ->
      keyStore.generateFallbackKeyJson(native, accountPickle)
    }

    AsyncFunction("verifyPrekey") { signingKey: String, prekey: String, signature: String ->
      native.nativeVerifyPrekey(signingKey, prekey, signature)
    }

    AsyncFunction("secureCreateOutbound") {
      accountPickle: String,
      identityKey: String,
      oneTimeKey: String,
      plaintextB64: String,
      ->
      keyStore.createOutboundJson(native, accountPickle, identityKey, oneTimeKey, plaintextB64)
    }

    AsyncFunction("secureEncrypt") { sessionPickle: String, plaintextB64: String ->
      keyStore.encryptJson(native, sessionPickle, plaintextB64)
    }

    AsyncFunction("secureCreateInbound") {
      accountPickle: String,
      identityKey: String,
      prekeyMessage: String,
      ->
      keyStore.createInboundJson(native, accountPickle, identityKey, prekeyMessage)
    }

    AsyncFunction("secureDecrypt") {
      sessionPickle: String,
      messageType: String,
      messageB64: String,
      ->
      keyStore.decryptJson(native, sessionPickle, messageType, messageB64)
    }

    AsyncFunction("simulateKeyLoss") {
      keyStore.simulateKeyLossJson()
    }
  }
}

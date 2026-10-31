package expo.modules.mbolocrypto

import android.content.Context
import android.content.pm.ApplicationInfo
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/**
 * Clé AES non exportable du Keystore Android qui protège les clés de pickle et
 * SQLCipher. Les clés en clair ne quittent jamais Kotlin vers JavaScript.
 */
class E2eeKeyStore(private val context: Context) {
  private val prefs = context.getSharedPreferences("mbolo_e2ee_keys_v1", Context.MODE_PRIVATE)
  private val alias = "mbolo_e2ee_master_v1"

  private data class Material(val pickleKey: ByteArray, val dbKey: ByteArray, val recovered: Boolean)

  private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  private fun secretKey(): SecretKey {
    val store = keyStore()
    (store.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(
        alias,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return generator.generateKey()
  }

  private fun encrypt(material: ByteArray): String {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, secretKey())
    val encrypted = cipher.doFinal(material)
    val combined = ByteArray(cipher.iv.size + encrypted.size)
    cipher.iv.copyInto(combined)
    encrypted.copyInto(combined, cipher.iv.size)
    return Base64.encodeToString(combined, Base64.NO_WRAP)
  }

  private fun decrypt(encoded: String): ByteArray {
    val combined = Base64.decode(encoded, Base64.NO_WRAP)
    if (combined.size < 13) throw IllegalStateException("short blob")
    val iv = combined.copyOfRange(0, 12)
    val payload = combined.copyOfRange(12, combined.size)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
    return cipher.doFinal(payload)
  }

  private fun randomKey(): ByteArray = ByteArray(32).also { SecureRandom().nextBytes(it) }

  private fun freshMaterial(): Material =
    Material(randomKey(), randomKey(), recovered = false)

  private fun serialize(material: Material): String =
    JSONObject()
      .put("p", Base64.encodeToString(material.pickleKey, Base64.NO_WRAP))
      .put("d", Base64.encodeToString(material.dbKey, Base64.NO_WRAP))
      .toString()

  private fun parse(bytes: ByteArray): Material {
    val json = JSONObject(String(bytes, Charsets.UTF_8))
    val pickle = Base64.decode(json.getString("p"), Base64.NO_WRAP)
    val database = Base64.decode(json.getString("d"), Base64.NO_WRAP)
    if (pickle.size != 32 || database.size != 32) throw IllegalStateException("bad material")
    return Material(pickle, database, recovered = false)
  }

  private fun ensureMaterial(): Material {
    val initialized = prefs.getBoolean("initialized", false)
    val stored = prefs.getString("material", null)
    if (!initialized) {
      val material = freshMaterial()
      prefs.edit().putString("material", encrypt(serialize(material).toByteArray())).putBoolean("initialized", true).apply()
      return material
    }
    if (stored != null) {
      try {
        return parse(decrypt(stored))
      } catch (_: Throwable) {
        // Blob illisible : on repart proprement, l'appelant signale la perte.
      }
    }
    val material = freshMaterial()
    prefs.edit().putString("material", encrypt(serialize(material).toByteArray())).putBoolean("initialized", true).apply()
    return material.copy(recovered = true)
  }

  private fun zero(material: Material) {
    material.pickleKey.fill(0)
    material.dbKey.fill(0)
  }

  private fun ok(data: JSONObject): String = JSONObject().put("ok", true).put("data", data).toString()

  private fun error(code: String): String =
    JSONObject().put("ok", false).put("error", code).toString()

  fun ensureKeysJson(): String =
    try {
      val material = ensureMaterial()
      val recovered = material.recovered
      zero(material)
      ok(JSONObject().put("recovered", recovered))
    } catch (_: Throwable) {
      error("keystore")
    }

  fun sqlCipherKeyJson(): String =
    try {
      val material = ensureMaterial()
      val hex = material.dbKey.joinToString("") { "%02x".format(it) }
      zero(material)
      ok(JSONObject().put("key", hex))
    } catch (_: Throwable) {
      error("keystore")
    }

  fun createAccountJson(native: MboloCryptoNative): String =
    try {
      val material = ensureMaterial()
      val key = Base64.encodeToString(material.pickleKey, Base64.NO_WRAP)
      val result = native.nativeCreateAccount(key)
      zero(material)
      result
    } catch (_: Throwable) {
      error("keystore")
    }

  fun generateOneTimeKeysJson(native: MboloCryptoNative, accountPickle: String, count: Int): String =
    withKey { key ->
      native.nativeGenerateOneTimeKeys(accountPickle, key, count)
    }

  fun generateOneTimeKeysSignedJson(
    native: MboloCryptoNative,
    accountPickle: String,
    count: Int,
  ): String = withKey { key ->
    native.nativeGenerateOneTimeKeysSigned(accountPickle, key, count)
  }

  fun generateFallbackKeyJson(native: MboloCryptoNative, accountPickle: String): String =
    withKey { key -> native.nativeGenerateFallbackKeySigned(accountPickle, key) }

  fun createOutboundJson(
    native: MboloCryptoNative,
    accountPickle: String,
    identityKey: String,
    oneTimeKey: String,
    plaintextB64: String,
  ): String = withKey { key ->
    native.nativeCreateOutbound(accountPickle, key, identityKey, oneTimeKey, plaintextB64)
  }

  fun encryptJson(native: MboloCryptoNative, sessionPickle: String, plaintextB64: String): String =
    withKey { key -> native.nativeEncrypt(sessionPickle, key, plaintextB64) }

  fun createInboundJson(
    native: MboloCryptoNative,
    accountPickle: String,
    identityKey: String,
    prekeyMessage: String,
  ): String = withKey { key ->
    native.nativeCreateInbound(accountPickle, key, identityKey, prekeyMessage)
  }

  fun decryptJson(
    native: MboloCryptoNative,
    sessionPickle: String,
    messageType: String,
    messageB64: String,
  ): String = withKey { key ->
    native.nativeDecrypt(sessionPickle, key, messageType, messageB64)
  }

  /** Outil de développement : rend le blob illisible sans toucher au Keystore. */
  fun simulateKeyLossJson(): String {
    return try {
      val debuggable = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
      if (!debuggable) {
        error("forbidden")
      } else {
        prefs.edit().putString("material", "AAAA").putBoolean("initialized", true).apply()
        ok(JSONObject().put("simulated", true))
      }
    } catch (_: Throwable) {
      error("keystore")
    }
  }

  private fun withKey(block: (String) -> String): String =
    try {
      val material = ensureMaterial()
      val key = Base64.encodeToString(material.pickleKey, Base64.NO_WRAP)
      val result = block(key)
      zero(material)
      result
    } catch (_: Throwable) {
      error("keystore")
    }
}

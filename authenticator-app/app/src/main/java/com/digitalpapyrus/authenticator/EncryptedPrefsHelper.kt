package com.digitalpapyrus.authenticator

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Helper for storing sensitive data using EncryptedSharedPreferences.
 *
 * This uses Android Keystore to encrypt data at rest, preventing extraction
 * of the enrollment secret from the APK or device storage.
 *
 * Per ADR-016, the AUTHENTICATOR_ENROLLMENT_SECRET must be supplied at runtime
 * (first-run prompt) and stored securely, never compiled into BuildConfig.
 */
object EncryptedPrefsHelper {

  private const val PREFS_FILE_NAME = "authenticator_encrypted_prefs"
  private const val KEY_ENROLLMENT_SECRET = "enrollment_secret"

  private var encryptedPrefs: SharedPreferences? = null

  /**
   * Initializes the EncryptedSharedPreferences instance.
   * Must be called before any get/store operations.
   *
   * If the Android Keystore key has been invalidated (e.g. after a signing key change
   * or certain device security changes), decryption throws AEADBadTagException.
   * In that case we wipe the corrupted prefs file and start fresh — the user will
   * be prompted to re-enter the enrollment secret on next launch.
   *
   * @param context Application context
   */
  fun initialize(context: Context) {
    try {
      encryptedPrefs = createEncryptedPrefs(context)
    } catch (e: Exception) {
      // Corrupted keyset or invalidated Keystore key — wipe and recreate.
      // The enrollment secret will need to be re-entered.
      android.util.Log.w("EncryptedPrefsHelper", "Prefs corrupted or key invalidated, wiping and recreating", e)
      context.deleteSharedPreferences(PREFS_FILE_NAME)
      encryptedPrefs = createEncryptedPrefs(context)
    }
  }

  /**
   * Creates a fresh EncryptedSharedPreferences instance.
   */
  private fun createEncryptedPrefs(context: Context): SharedPreferences {
    val masterKey = MasterKey.Builder(context)
      .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
      .build()

    return EncryptedSharedPreferences.create(
      context,
      PREFS_FILE_NAME,
      masterKey,
      EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
      EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )
  }

  /**
   * Stores the enrollment secret securely.
   *
   * @param context Application context
   * @param secret The enrollment secret (32+ characters)
   */
  fun storeEnrollmentSecret(context: Context, secret: String) {
    if (encryptedPrefs == null) {
      initialize(context)
    }

    if (secret.length < 32) {
      throw IllegalArgumentException("Enrollment secret must be at least 32 characters")
    }

    encryptedPrefs?.edit()
      ?.putString(KEY_ENROLLMENT_SECRET, secret)
      ?.apply()
  }

  /**
   * Retrieves the enrollment secret.
   *
   * @param context Application context
   * @return The enrollment secret, or null if not set
   */
  fun getEnrollmentSecret(context: Context): String? {
    if (encryptedPrefs == null) {
      initialize(context)
    }

    return encryptedPrefs?.getString(KEY_ENROLLMENT_SECRET, null)
  }

  /**
   * Checks if the enrollment secret has been configured.
   *
   * @param context Application context
   * @return true if secret is set, false otherwise
   */
  fun hasEnrollmentSecret(context: Context): Boolean {
    if (encryptedPrefs == null) {
      initialize(context)
    }

    return encryptedPrefs?.contains(KEY_ENROLLMENT_SECRET) == true
  }

  /**
   * Clears the enrollment secret (useful for re-enrollment or rotation).
   *
   * @param context Application context
   */
  fun clearEnrollmentSecret(context: Context) {
    if (encryptedPrefs == null) {
      initialize(context)
    }

    encryptedPrefs?.edit()
      ?.remove(KEY_ENROLLMENT_SECRET)
      ?.apply()
  }
}

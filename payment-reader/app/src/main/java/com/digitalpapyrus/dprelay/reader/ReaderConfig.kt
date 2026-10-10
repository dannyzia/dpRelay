package com.digitalpapyrus.dprelay.reader

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Reader settings (STAGE F8 onboarding): server URL + PAYMENT_READER_SECRET.
 *
 * The secret lives in EncryptedSharedPreferences — ADR-016 policy: secrets
 * are never compiled into BuildConfig and never sit in plain prefs. The URL
 * is not secret but is kept beside it so both come from one place.
 */
class ReaderConfig(context: Context) {

    private val secure: SharedPreferences = createSecurePrefs(context)

    /** Configured server URL ("" before onboarding). */
    fun serverUrl(): String = secure.getString(KEY_URL, "") ?: ""

    /** PAYMENT_READER_SECRET ("" before onboarding). Never logged. */
    fun readerSecret(): String = secure.getString(KEY_SECRET, "") ?: ""

    /** True once both values are present — the upload path requires both. */
    fun isConfigured(): Boolean = serverUrl().isNotEmpty() && readerSecret().isNotEmpty()

    /** Persists onboarding input. URL is trimmed; the secret is stored verbatim. */
    fun save(serverUrl: String, readerSecret: String) {
        secure
            .edit()
            .putString(KEY_URL, serverUrl.trim())
            .putString(KEY_SECRET, readerSecret)
            .apply()
    }

    companion object {

        /**
         * Plain prefs file for the upload QUEUE (parsed fields + rawBody — no
         * secrets; app-private sandbox). Named here so the store and the
         * config share one definition.
         */
        const val QUEUE_PREFS = "payment_reader_queue"

        private const val SECURE_PREFS_FILE = "payment_reader_secure_prefs"
        private const val KEY_URL = "server_url"
        private const val KEY_SECRET = "payment_reader_secret"
        private const val TAG = "ReaderConfig"

        private fun createSecurePrefs(context: Context): SharedPreferences =
            try {
                buildSecurePrefs(context)
            } catch (e: Exception) {
                // Keystore key invalidated or corrupted keyset (the gateway
                // hits the same failure mode): wipe and recreate so the
                // operator re-enters the secret instead of the app bricking.
                Log.w(TAG, "secure prefs corrupted or key invalidated, recreating", e)
                context.deleteSharedPreferences(SECURE_PREFS_FILE)
                buildSecurePrefs(context)
            }

        private fun buildSecurePrefs(context: Context): SharedPreferences {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            return EncryptedSharedPreferences.create(
                context,
                SECURE_PREFS_FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }
    }
}

/**
 * Durable [QueueStore] backed by the app's plain SharedPreferences.
 *
 * Uses commit() (not apply()) on purpose: every write is a payment, and the
 * queue must be on disk before the receiver's process can be killed. Payloads
 * are a few hundred bytes — the synchronous write is noise.
 */
class PrefsQueueStore(context: Context) : QueueStore {

    private val prefs: SharedPreferences =
        context.getSharedPreferences(ReaderConfig.QUEUE_PREFS, Context.MODE_PRIVATE)

    override fun read(): String = prefs.getString(KEY_QUEUE, "") ?: ""

    override fun write(payload: String) {
        prefs.edit().putString(KEY_QUEUE, payload).commit()
    }

    companion object {
        private const val KEY_QUEUE = "pending_uploads"
    }
}

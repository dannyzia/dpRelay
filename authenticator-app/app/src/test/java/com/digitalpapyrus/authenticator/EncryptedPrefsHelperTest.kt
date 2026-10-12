package com.digitalpapyrus.authenticator

import android.content.Context
import android.content.SharedPreferences
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.mockito.kotlin.mock

/**
 * ISSUE-16 (AC3): the clear-and-reprompt path of the in-app credential reset.
 *
 * Runs against a map-backed fake SharedPreferences injected through
 * [EncryptedPrefsHelper.initializeForTest] — the android.jar stubs are
 * untestable without Robolectric, so the helper's store/get/clear contract
 * is exercised directly on the JVM. The `Context` argument is only consumed
 * when the helper has no prefs instance yet, which the seam prevents, so the
 * mocked context is never touched.
 */
class EncryptedPrefsHelperTest {

  companion object {
    // storeEnrollmentSecret enforces >= 32 chars; the rest are arbitrary.
    private const val GLOBAL_SECRET = "global-secret-0123456789abcdef0123456789"
    private const val APP_SECRET = "app-secret-from-dashboard"
    private const val DEVICE_KEY = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    private const val FRESH_KEY = "fresh-device-key-after-reenroll"
    private const val NUMBER = "+8801613249520"
  }

  /** Map-backed fake covering exactly what EncryptedPrefsHelper calls. */
  private class FakePrefs : SharedPreferences {
    val store = HashMap<String, Any?>()

    override fun getAll(): MutableMap<String, *> = HashMap(store)

    override fun getString(key: String?, defValue: String?): String? =
      store[key] as? String ?: defValue

    override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? {
      @Suppress("UNCHECKED_CAST")
      return store[key] as? MutableSet<String> ?: defValues
    }

    override fun getInt(key: String?, defValue: Int): Int = store[key] as? Int ?: defValue

    override fun getLong(key: String?, defValue: Long): Long = store[key] as? Long ?: defValue

    override fun getFloat(key: String?, defValue: Float): Float = store[key] as? Float ?: defValue

    override fun getBoolean(key: String?, defValue: Boolean): Boolean =
      store[key] as? Boolean ?: defValue

    override fun contains(key: String?): Boolean = store.containsKey(key)

    override fun edit(): SharedPreferences.Editor = FakeEditor()

    override fun registerOnSharedPreferenceChangeListener(
      listener: SharedPreferences.OnSharedPreferenceChangeListener?,
    ) = Unit

    override fun unregisterOnSharedPreferenceChangeListener(
      listener: SharedPreferences.OnSharedPreferenceChangeListener?,
    ) = Unit

    private inner class FakeEditor : SharedPreferences.Editor {
      private val pending = HashMap<String, Any?>()
      private val removals = LinkedHashSet<String>()
      private var clearFirst = false

      override fun putString(key: String?, value: String?): SharedPreferences.Editor {
        pending[key ?: return this] = value
        return this
      }

      override fun putStringSet(key: String?, values: MutableSet<String>?): SharedPreferences.Editor {
        pending[key ?: return this] = values
        return this
      }

      override fun putInt(key: String?, value: Int): SharedPreferences.Editor {
        pending[key ?: return this] = value
        return this
      }

      override fun putLong(key: String?, value: Long): SharedPreferences.Editor {
        pending[key ?: return this] = value
        return this
      }

      override fun putFloat(key: String?, value: Float): SharedPreferences.Editor {
        pending[key ?: return this] = value
        return this
      }

      override fun putBoolean(key: String?, value: Boolean): SharedPreferences.Editor {
        pending[key ?: return this] = value
        return this
      }

      override fun remove(key: String?): SharedPreferences.Editor {
        key?.let(removals::add)
        return this
      }

      override fun clear(): SharedPreferences.Editor {
        clearFirst = true
        return this
      }

      override fun commit(): Boolean {
        applyChanges()
        return true
      }

      override fun apply() = applyChanges()

      private fun applyChanges() {
        if (clearFirst) store.clear()
        removals.forEach { store.remove(it) }
        pending.forEach { (k, v) -> if (v == null) store.remove(k) else store[k] = v }
      }
    }
  }

  private val prefs = FakePrefs()
  private val context: Context = mock()

  @Before
  fun setUp() {
    EncryptedPrefsHelper.initializeForTest(prefs)
  }

  @After
  fun tearDown() {
    // The helper is a singleton object and the test JVM is shared across
    // test classes — leave a clean empty instance behind.
    EncryptedPrefsHelper.initializeForTest(FakePrefs())
  }

  @Test
  fun `clear-and-reprompt — reset wipes credentials, gate reopens the wizard, fresh enroll restores them`() {
    // Enrolled state exactly as the wizard's 201 handler persists it.
    EncryptedPrefsHelper.storeEnrollmentSecret(context, GLOBAL_SECRET)
    EncryptedPrefsHelper.storeAppEnrollmentSecret(context, APP_SECRET)
    EncryptedPrefsHelper.storeDeviceApiKey(context, DEVICE_KEY)
    EncryptedPrefsHelper.storeGatewayNumber(context, NUMBER)

    // The reset's confirm handler: clear credentials (the wizard then
    // reopens because the enrollment gate below fires — that gate decides
    // showOnboardingWizard() in onCreate and is the reprompt contract).
    EncryptedPrefsHelper.clearDeviceCredentials(context)

    // AC2: nothing credential-shaped survives the reset…
    assertFalse(EncryptedPrefsHelper.hasEnrollmentSecret(context))
    assertNull(EncryptedPrefsHelper.getEnrollmentSecret(context))
    assertNull(EncryptedPrefsHelper.getAppEnrollmentSecret(context))
    // …so the enrollment gate fires (reprompt half of the path).
    assertTrue(GatewayIdentity.needsEnrollment(EncryptedPrefsHelper.getDeviceApiKey(context)))
    // The gateway number is identity, not a credential: kept to prefill.
    assertEquals(NUMBER, EncryptedPrefsHelper.getGatewayNumber(context))

    // Re-enrollment round-trip (the wizard's 201 handler) restores a clean
    // credential set and closes the gate again.
    EncryptedPrefsHelper.storeDeviceApiKey(context, FRESH_KEY)
    EncryptedPrefsHelper.storeAppEnrollmentSecret(context, APP_SECRET)
    assertFalse(GatewayIdentity.needsEnrollment(EncryptedPrefsHelper.getDeviceApiKey(context)))
    assertNotNull(EncryptedPrefsHelper.getAppEnrollmentSecret(context))
  }

  @Test
  fun `reset also erases the legacy global secret so background re-enroll cannot fall back to it`() {
    // Only the legacy global secret is stored (pre-F7 device): bearer
    // selection would normally fall back to it…
    EncryptedPrefsHelper.storeEnrollmentSecret(context, GLOBAL_SECRET)
    assertEquals(
      GLOBAL_SECRET,
      GatewayIdentity.selectEnrollmentBearer(
        EncryptedPrefsHelper.getAppEnrollmentSecret(context),
        EncryptedPrefsHelper.getEnrollmentSecret(context),
      ),
    )

    // …but after a reset both selectors come back empty, so
    // V5ApiClient.enrollIfNeeded has nothing to authenticate with: the
    // self-heal loop waits for the operator's new secret instead of
    // silently re-enrolling with the old one.
    EncryptedPrefsHelper.clearDeviceCredentials(context)
    assertNull(
      GatewayIdentity.selectEnrollmentBearer(
        EncryptedPrefsHelper.getAppEnrollmentSecret(context),
        EncryptedPrefsHelper.getEnrollmentSecret(context),
      ),
    )
  }
}

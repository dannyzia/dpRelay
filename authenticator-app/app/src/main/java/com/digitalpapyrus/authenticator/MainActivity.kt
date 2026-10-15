package com.digitalpapyrus.authenticator

import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

/**
 * Main activity for the authenticator app.
 *
 * Responsibilities:
 * - Request SMS permissions
 * - Show battery optimization dialog
 * - Show auto-start dialog for Chinese ROMs
 * - Gate first run on a server-verified onboarding wizard (ISSUE-97, ADR-016)
 * - Start the foreground service
 */
class MainActivity : AppCompatActivity() {

  companion object {
    private const val REQUEST_SMS_PERMISSIONS = 1001
    private const val REQUEST_POST_NOTIFICATIONS = 1002
    private const val REQUEST_BATTERY_OPTIMIZATION = 1003
    private const val REQUEST_AUTO_START = 1004

    // STAGE F7: optional SIM prefill permission — its result is deliberately
    // ignored (denial just falls back to manual entry in Settings).
    private const val REQUEST_PHONE_STATE = 1005
    private const val PREFS_NAME = "authenticator_prefs"
    private const val PREF_AUTOSTART_PROMPTED = "autostart_prompted"
  }

  private lateinit var statusText: TextView
  private lateinit var autoStartButton: Button
  private lateinit var settingsButton: Button
  private lateinit var gatewayNumberText: TextView

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    setContentView(R.layout.activity_main)

    statusText = findViewById(R.id.statusText)
    gatewayNumberText = findViewById(R.id.gatewayNumberText)
    autoStartButton = findViewById(R.id.autoStartButton)
    settingsButton = findViewById(R.id.settingsButton)

    autoStartButton.setOnClickListener {
      openAutoStartSettings()
    }

    // STAGE F7 (ISSUE-87): gateway number + optional app enrollment secret.
    settingsButton.setOnClickListener {
      showSettingsDialog()
    }

    // ISSUE-16 (AC1): long-press on the status card opens the enrollment
    // secret reset — rotation and typo recovery without adb or reinstall.
    statusText.setOnLongClickListener {
      showResetEnrollmentDialog()
      true
    }
    gatewayNumberText.setOnLongClickListener {
      showResetEnrollmentDialog()
      true
    }

    // Initialize encrypted prefs
    EncryptedPrefsHelper.initialize(this)

    // ISSUE-97 (AC1): no device API key = first launch. The wizard GATES the
    // whole setup chain — no permission prompts, no background service —
    // until POST /v5/device/enroll has verified the gateway number (plan
    // slots, uniqueness, anti-churn) and answered 201 (AC6).
    if (GatewayIdentity.needsEnrollment(EncryptedPrefsHelper.getDeviceApiKey(this))) {
      showOnboardingWizard()
    } else {
      updateDashboardNumber()
      // Request permissions and start service
      requestSmsPermissions()
    }
  }

  /**
   * STAGE F7 (ISSUE-87): gateway settings — the phone's number and the
   * optional per-app enrollment secret.
   *
   * The SIM number (TelephonyManager.getLine1Number) is ATTEMPTED as a
   * convenience only: carriers frequently return empty (and the permission is
   * not guaranteed on API 29+), so MANUAL ENTRY is the mandatory fallback —
   * the field is always editable. Saving an already-enrolled device pushes
   * the number to POST /v5/device/phone-number; no re-enroll needed.
   */
  private fun showSettingsDialog() {
    val density = resources.displayMetrics.density
    fun dp(v: Int): Int = (v * density).toInt()

    val container = android.widget.LinearLayout(this).apply {
      orientation = android.widget.LinearLayout.VERTICAL
      setPadding(dp(24), dp(8), dp(24), 0)
    }

    val numberLabel = TextView(this).apply {
      text = getString(R.string.settings_number_label)
    }
    val numberInput = android.widget.EditText(this).apply {
      hint = getString(R.string.settings_number_hint)
      setText(EncryptedPrefsHelper.getGatewayNumber(context) ?: readSimNumber() ?: "")
      inputType = android.text.InputType.TYPE_CLASS_TEXT
    }
    val secretLabel = TextView(this).apply {
      text = getString(R.string.settings_app_secret_label)
    }
    val secretInput = android.widget.EditText(this).apply {
      hint = getString(R.string.settings_app_secret_hint)
      // Never prefill a secret onto the screen; empty = keep nothing new.
      inputType = android.text.InputType.TYPE_CLASS_TEXT or
        android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
    }
    container.addView(numberLabel)
    container.addView(numberInput)
    container.addView(secretLabel)
    container.addView(secretInput)

    AlertDialog.Builder(this)
      .setTitle(getString(R.string.settings_dialog_title))
      .setView(container)
      .setPositiveButton(getString(R.string.dialog_button_save)) { _, _ ->
        val number = numberInput.text.toString().trim()
        val appSecret = secretInput.text.toString().trim()
        if (number.isNotEmpty() && !GatewayIdentity.isValidE164(number)) {
          android.widget.Toast.makeText(
            this,
            getString(R.string.settings_invalid_number),
            android.widget.Toast.LENGTH_LONG,
          ).show()
          showSettingsDialog()
          return@setPositiveButton
        }
        saveSettings(number, appSecret)
      }
      .setNegativeButton(getString(R.string.dialog_button_skip)) { _, _ -> }
      .show()
  }

  /**
   * ISSUE-97 (AC7): verifies a changed number with the server BEFORE
   * persisting. A changed number on an enrolled device goes to
   * POST /v5/device/phone-number first; only a verified number (or an
   * unchanged/cleared one, which needs no verification) is written to
   * EncryptedSharedPreferences. The old F7 "save locally, push later"
   * behavior is deliberately reversed by this AC: an unverifiable number
   * must never reach the prefs.
   *
   * @param number Valid E.164 number or blank (clears the stored identity)
   * @param appSecret Per-app enrollment secret, or blank (global/fleet secret)
   */
  private fun saveSettings(number: String, appSecret: String) {
    val storedNumber = EncryptedPrefsHelper.getGatewayNumber(this) ?: ""
    val enrolled = EncryptedPrefsHelper.getDeviceApiKey(this) != null

    // Blank = clearing the local identity; unchanged = nothing to verify;
    // unenrolled = the wizard (not Settings) owns first verification.
    if (number.isEmpty() || number == storedNumber || !enrolled) {
      persistSettings(number, appSecret)
      return
    }

    lifecycleScope.launch {
      when (val outcome = V5ApiClient.postPhoneNumber(this@MainActivity, number)) {
        V5PhonePushOutcome.Verified -> persistSettings(number, appSecret)
        is V5PhonePushOutcome.Rejected -> {
          // Exact human error (AC5-style); NOTHING was persisted.
          android.widget.Toast.makeText(
            this@MainActivity,
            GatewayIdentity.serverFailureMessage(outcome.httpCode, outcome.code, outcome.serverError)
              ?: getString(R.string.settings_verify_failed),
            android.widget.Toast.LENGTH_LONG,
          ).show()
        }
        V5PhonePushOutcome.Unreachable -> {
          android.widget.Toast.makeText(
            this@MainActivity,
            getString(R.string.settings_verify_failed_network),
            android.widget.Toast.LENGTH_LONG,
          ).show()
        }
      }
    }
  }

  /** Writes the wizard/settings inputs to EncryptedSharedPreferences (AC6). */
  private fun persistSettings(number: String, appSecret: String) {
    EncryptedPrefsHelper.storeGatewayNumber(this, number)
    EncryptedPrefsHelper.storeAppEnrollmentSecret(this, appSecret)
    updateDashboardNumber()
  }

  /**
   * ISSUE-97 (AC6): surfaces the server-verified gateway number on the
   * dashboard; hidden until a number is stored.
   */
  private fun updateDashboardNumber() {
    val number = EncryptedPrefsHelper.getGatewayNumber(this)
    if (number.isNullOrEmpty()) {
      gatewayNumberText.visibility = android.view.View.GONE
    } else {
      gatewayNumberText.text = getString(R.string.dashboard_gateway_number, number)
      gatewayNumberText.visibility = android.view.View.VISIBLE
    }
  }

  // ISSUE-16 (AC1/AC2): in-app enrollment-secret reset (rotation and typo
  // recovery without adb or reinstall). Confirmation first: the confirm
  // handler clearAndRepromptEnrollment() wipes BOTH stored secrets — the
  // wizard's per-app one and the legacy global one the background self-heal
  // enrollment (V5ApiClient.enrollIfNeeded) would otherwise fall back to —
  // plus the v5 device API key, so the next enroll creates a fresh device
  // row, then reopens the wizard immediately. The gateway number is kept
  // and prefills the wizard.
  private fun showResetEnrollmentDialog() {
    AlertDialog.Builder(this)
      .setTitle(getString(R.string.reset_enrollment_title))
      .setMessage(getString(R.string.reset_enrollment_message))
      .setPositiveButton(getString(R.string.reset_enrollment_confirm)) { _, _ ->
        clearAndRepromptEnrollment()
      }
      .setNegativeButton(getString(R.string.dialog_button_cancel)) { _, _ -> }
      .show()
  }

  /** ISSUE-16 (AC2): clears the stored credentials, then reopens the wizard. */
  private fun clearAndRepromptEnrollment() {
    EncryptedPrefsHelper.clearDeviceCredentials(this)
    showOnboardingWizard()
  }

  /**
   * Best-effort SIM number for prefilling the settings field. Frequently
   * empty or carrier-restricted (SecurityException on API 29+ without
   * READ_PHONE_NUMBERS) — hence the mandatory manual-entry fallback.
   *
   * The explicit READ_PHONE_STATE gate is both the runtime check and the
   * lint contract: ungranted (the normal path on a phone that declined the
   * optional prompt) returns null immediately and Settings still works.
   */
  private fun readSimNumber(): String? {
    if (
      ContextCompat.checkSelfPermission(this, android.Manifest.permission.READ_PHONE_STATE) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      return null
    }
    return try {
      val telephony = getSystemService(Context.TELEPHONY_SERVICE) as android.telephony.TelephonyManager
      telephony.line1Number?.trim()?.takeIf { it.isNotEmpty() }
    } catch (e: Exception) {
      // Carrier-dependent and permission-gated — absence is normal, not a fault.
      null
    }
  }

  /**
   * STAGE F7: requests the optional READ_PHONE_STATE permission AFTER the
   * fatal SMS flow so a denial can never trigger the permission-denied exit —
   * the SIM prefill is a convenience; manual entry is the mandatory path.
   */
  private fun requestPhoneNumberPermission() {
    if (
      ContextCompat.checkSelfPermission(this, android.Manifest.permission.READ_PHONE_STATE) ==
      PackageManager.PERMISSION_GRANTED
    ) {
      return
    }
    requestPermissions(arrayOf(android.Manifest.permission.READ_PHONE_STATE), REQUEST_PHONE_STATE)
  }

  private fun requestSmsPermissions() {
    val permissions = mutableListOf(
      android.Manifest.permission.RECEIVE_SMS,
      android.Manifest.permission.READ_SMS,
      android.Manifest.permission.SEND_SMS,
    )

    // Add POST_NOTIFICATIONS for Android 13+
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      permissions.add(android.Manifest.permission.POST_NOTIFICATIONS)
    }

    // UX1: Check if all permissions are already granted
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      val allGranted = permissions.all { perm ->
        ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED
      }
      if (allGranted) {
        // All permissions already granted - skip dialog
        onPermissionsGranted()
        return
      }
      requestPermissions(permissions.toTypedArray(), REQUEST_SMS_PERMISSIONS)
    } else {
      onPermissionsGranted()
    }
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode == REQUEST_SMS_PERMISSIONS) {
      val allGranted = grantResults.all { it == android.content.pm.PackageManager.PERMISSION_GRANTED }
      if (allGranted) {
        onPermissionsGranted()
      } else {
        showPermissionDeniedDialog()
      }
    }
  }

  private fun onPermissionsGranted() {
    showBatteryOptimizationDialog()
  }

  private fun showBatteryOptimizationDialog() {
    // UX2: Check if already exempted from battery optimization
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
      if (powerManager.isIgnoringBatteryOptimizations(packageName)) {
        // Already exempted - skip dialog
        onBatteryOptimizationComplete()
        return
      }
    }

    // Not exempted - show dialog
    AlertDialog.Builder(this)
      .setTitle(getString(R.string.dialog_battery_optimization_title))
      .setMessage(getString(R.string.dialog_battery_optimization_message))
      .setPositiveButton(getString(R.string.dialog_button_open_settings)) { _, _ ->
        openBatteryOptimizationSettings()
      }
      .setCancelable(false)
      .show()
  }

  private fun openBatteryOptimizationSettings() {
    // ISSUE-118: non-standard ROMs may lack the exact-request activity or
    // refuse the package-URI intent — never strand the onboarding flow.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      try {
        val intent = Intent().apply {
          action = Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
          data = Uri.parse("package:$packageName")
        }
        startActivityForResult(intent, REQUEST_BATTERY_OPTIMIZATION)
      } catch (e: ActivityNotFoundException) {
        openGenericBatterySettings()
      } catch (e: SecurityException) {
        openGenericBatterySettings()
      }
    } else {
      onBatteryOptimizationComplete()
    }
  }

  private fun openGenericBatterySettings() {
    // Fallback ladder: generic optimization list (reusing the same request
    // code so the existing onActivityResult rung completes onboarding on
    // return), then straight through — every rung advances the flow even on
    // ROMs with no exemption UI at all.
    try {
      val fallback = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
      startActivityForResult(fallback, REQUEST_BATTERY_OPTIMIZATION)
    } catch (e: ActivityNotFoundException) {
      onBatteryOptimizationComplete()
    } catch (e: SecurityException) {
      onBatteryOptimizationComplete()
    }
  }

  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    when (requestCode) {
      REQUEST_BATTERY_OPTIMIZATION -> onBatteryOptimizationComplete()
      REQUEST_AUTO_START -> onAutoStartComplete()
    }
  }

  private fun onBatteryOptimizationComplete() {
    // Check if this is a Chinese ROM (Xiaomi, Oppo, Vivo, Huawei)
    val manufacturer = Build.MANUFACTURER.lowercase()
    if (manufacturer.contains("xiaomi") || manufacturer.contains("oppo") ||
      manufacturer.contains("vivo") || manufacturer.contains("huawei")
    ) {
      showAutoStartDialog()
    } else {
      startService()
    }
  }

  private fun showAutoStartDialog() {
    // UX3: Check if auto-start dialog was already shown
    val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val alreadyPrompted = prefs.getBoolean(PREF_AUTOSTART_PROMPTED, false)

    if (alreadyPrompted) {
      // Already prompted - skip dialog and start service
      startService()
      return
    }

    // First time - show dialog
    AlertDialog.Builder(this)
      .setTitle(getString(R.string.autostart_dialog_title))
      .setMessage(getString(R.string.autostart_dialog_message))
      .setPositiveButton(getString(R.string.dialog_button_open_app_settings)) { _, _ ->
        // Mark as prompted before opening settings
        markAutoStartPrompted()
        openAutoStartSettings()
      }
      .setNegativeButton(getString(R.string.dialog_button_skip)) { _, _ ->
        // Mark as prompted when user skips
        markAutoStartPrompted()
        startService()
      }
      .show()
  }

  private fun markAutoStartPrompted() {
    val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    prefs.edit().putBoolean(PREF_AUTOSTART_PROMPTED, true).apply()
  }

  private fun openAutoStartSettings() {
    val intent = Intent().apply {
      action = Settings.ACTION_APPLICATION_DETAILS_SETTINGS
      data = Uri.parse("package:$packageName")
    }
    startActivityForResult(intent, REQUEST_AUTO_START)
  }

  private fun onAutoStartComplete() {
    startService()
  }

  /**
   * ISSUE-97 (AC1): first-launch onboarding wizard — shown when no device
   * API key exists instead of silently starting the background service.
   *
   * Two mandatory fields (AC2): the gateway phone number (prefilled — SIM
   * number when readable, else the +880 carrier prefix) and the App
   * Enrollment Secret from the customer dashboard. The positive button's
   * default dismiss is replaced with an in-dialog listener, so the dialog
   * survives both an AC3 input error and an AC5 server rejection with the
   * user's inputs intact; nothing is persisted until a 201 (AC6).
   */
  private fun showOnboardingWizard() {
    val density = resources.displayMetrics.density
    fun dp(v: Int): Int = (v * density).toInt()

    val container = android.widget.LinearLayout(this).apply {
      orientation = android.widget.LinearLayout.VERTICAL
      setPadding(dp(24), dp(8), dp(24), 0)
    }

    val numberLabel = TextView(this).apply {
      text = getString(R.string.onboarding_number_label)
    }
    val numberInput = android.widget.EditText(this).apply {
      hint = getString(R.string.onboarding_number_hint)
      // AC2: prefilled with the carrier prefix; the SIM number is used when
      // the optional permission already granted it (usually not on launch 1).
      setText(readSimNumber()?.takeIf { GatewayIdentity.isValidE164(it) } ?: "+880")
      inputType = android.text.InputType.TYPE_CLASS_TEXT
    }
    val secretLabel = TextView(this).apply {
      text = getString(R.string.onboarding_secret_label)
    }
    val secretInput = android.widget.EditText(this).apply {
      hint = getString(R.string.onboarding_secret_hint)
      // Secrets are never prefilled onto the screen.
      inputType = android.text.InputType.TYPE_CLASS_TEXT or
        android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
    }
    val errorText = TextView(this).apply {
      setTextColor(android.graphics.Color.rgb(200, 40, 40))
      visibility = android.view.View.GONE
    }
    container.addView(numberLabel)
    container.addView(numberInput)
    container.addView(secretLabel)
    container.addView(secretInput)
    container.addView(
      errorText,
      android.widget.LinearLayout.LayoutParams(
        android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
        android.widget.LinearLayout.LayoutParams.WRAP_CONTENT,
      ),
    )

    val dialog = AlertDialog.Builder(this)
      .setTitle(getString(R.string.onboarding_title))
      .setMessage(getString(R.string.onboarding_message))
      .setView(container)
      .setPositiveButton(getString(R.string.onboarding_connect), null)
      .setCancelable(false)
      .create()

    dialog.setOnShowListener {
      val connectButton = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
      connectButton.setOnClickListener {
        val number = numberInput.text.toString().trim()
        val secret = secretInput.text.toString().trim()
        // AC3: client-side E.164 + mandatory-field gate BEFORE any network call.
        val inputError = GatewayIdentity.validateOnboarding(number, secret)
        if (inputError != null) {
          errorText.text = getString(
            when (inputError) {
              GatewayIdentity.OnboardingError.EMPTY_NUMBER -> R.string.onboarding_number_required
              GatewayIdentity.OnboardingError.INVALID_NUMBER -> R.string.onboarding_invalid_number
              GatewayIdentity.OnboardingError.EMPTY_SECRET -> R.string.onboarding_secret_required
            },
          )
          errorText.visibility = android.view.View.VISIBLE
          return@setOnClickListener
        }
        connectGateway(dialog, connectButton, errorText, number, secret)
      }
    }
    dialog.show()
  }

  /**
   * ISSUE-97 (AC4–AC6): runs POST /v5/device/enroll with the wizard inputs.
   * A 201 persists the credentials, shows the verified number and continues
   * the setup chain (which ends in the foreground service); any rejection
   * stays in the dialog showing the server's exact human error (AC5) and
   * never starts the service.
   *
   * @param dialog The still-open wizard
   * @param connectButton Its positive button, re-enabled on failure
   * @param errorText Inline error line inside the dialog
   * @param number Client-validated E.164 gateway number
   * @param secret App Enrollment Secret from the customer dashboard
   */
  private fun connectGateway(
    dialog: AlertDialog,
    connectButton: Button,
    errorText: TextView,
    number: String,
    secret: String,
  ) {
    errorText.visibility = android.view.View.GONE
    connectButton.isEnabled = false
    connectButton.text = getString(R.string.onboarding_connecting)

    lifecycleScope.launch {
      val outcome = V5ApiClient.enrollForOnboarding(this@MainActivity, number, secret)
      // Rotation/finish may have destroyed the dialog; onCreate re-runs and
      // re-shows the wizard (still unenrolled), so dropping this is safe.
      if (!dialog.isShowing) return@launch
      when (outcome) {
        is V5EnrollOutcome.Accepted -> {
          // AC6: persist → show verified number → continue into the chain
          // that starts the foreground service.
          EncryptedPrefsHelper.storeDeviceApiKey(this@MainActivity, outcome.apiKey)
          EncryptedPrefsHelper.storeGatewayNumber(this@MainActivity, number)
          EncryptedPrefsHelper.storeAppEnrollmentSecret(this@MainActivity, secret)
          updateDashboardNumber()
          dialog.dismiss()
          requestSmsPermissions()
        }
        is V5EnrollOutcome.Rejected -> {
          // AC5: exact human error inline; inputs kept; no service start.
          errorText.text = GatewayIdentity.serverFailureMessage(
            outcome.httpCode,
            outcome.code,
            outcome.serverError,
          ) ?: getString(R.string.onboarding_enroll_failed, outcome.code.ifEmpty { "HTTP ${outcome.httpCode}" })
          errorText.visibility = android.view.View.VISIBLE
          connectButton.isEnabled = true
          connectButton.text = getString(R.string.onboarding_connect)
        }
        V5EnrollOutcome.Unreachable -> {
          errorText.text = getString(R.string.onboarding_unreachable)
          errorText.visibility = android.view.View.VISIBLE
          connectButton.isEnabled = true
          connectButton.text = getString(R.string.onboarding_connect)
        }
      }
    }
  }

  private fun startService() {
    statusText.text = getString(R.string.status_text)

    // Non-fatal optional permission (its result is ignored by design).
    requestPhoneNumberPermission()

    val serviceIntent = Intent(this, AuthenticatorService::class.java).apply {
      action = AuthenticatorService.ACTION_START_SERVICE
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      startForegroundService(serviceIntent)
    } else {
      startService(serviceIntent)
    }

    // Schedule keep-alive mechanisms
    AlarmKeepAlive.scheduleKeepAlive(this)

    // Schedule WorkManager
    scheduleWorkManagerKeepAlive()
  }

  private fun scheduleWorkManagerKeepAlive() {
    val workRequest = androidx.work.PeriodicWorkRequestBuilder<ServiceKeepAliveWorker>(
      15,
      TimeUnit.MINUTES,
    ).build()

    androidx.work.WorkManager.getInstance(this)
      .enqueueUniquePeriodicWork(
        ServiceKeepAliveWorker.getWorkName(this),
        androidx.work.ExistingPeriodicWorkPolicy.KEEP,
        workRequest,
      )
  }

  private fun showPermissionDeniedDialog() {
    AlertDialog.Builder(this)
      .setTitle(getString(R.string.dialog_permission_rationale_title))
      .setMessage(getString(R.string.dialog_permission_rationale_message))
      .setPositiveButton(getString(R.string.dialog_button_grant)) { _, _ ->
        finish()
      }
      .setCancelable(false)
      .show()
  }
}

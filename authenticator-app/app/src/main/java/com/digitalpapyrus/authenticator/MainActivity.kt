package com.digitalpapyrus.authenticator

import android.app.AlertDialog
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
 * - Prompt for enrollment secret on first run (ADR-016)
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

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    setContentView(R.layout.activity_main)

    statusText = findViewById(R.id.statusText)
    autoStartButton = findViewById(R.id.autoStartButton)
    settingsButton = findViewById(R.id.settingsButton)

    autoStartButton.setOnClickListener {
      openAutoStartSettings()
    }

    // STAGE F7 (ISSUE-87): gateway number + optional app enrollment secret.
    settingsButton.setOnClickListener {
      showSettingsDialog()
    }

    // Initialize encrypted prefs
    EncryptedPrefsHelper.initialize(this)

    // Check for enrollment secret
    if (!EncryptedPrefsHelper.hasEnrollmentSecret(this)) {
      showEnrollmentSecretDialog()
    }

    // Request permissions and start service
    requestSmsPermissions()
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
   * Persists both fields and, when this device is already enrolled, pushes a
   * changed number to the server (F7 no-re-enroll path for the live fleet).
   *
   * @param number Valid E.164 number or blank (clears the stored identity)
   * @param appSecret Per-app enrollment secret, or blank (global/fleet secret)
   */
  private fun saveSettings(number: String, appSecret: String) {
    EncryptedPrefsHelper.storeGatewayNumber(this, number)
    EncryptedPrefsHelper.storeAppEnrollmentSecret(this, appSecret)

    if (EncryptedPrefsHelper.getDeviceApiKey(this) != null && number.isNotEmpty()) {
      lifecycleScope.launch {
        val pushed = V5ApiClient.postPhoneNumber(this@MainActivity)
        if (!pushed) {
          android.widget.Toast.makeText(
            this@MainActivity,
            "Saved locally — number will be pushed when the connection allows",
            android.widget.Toast.LENGTH_LONG,
          ).show()
        }
      }
    }
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
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      val intent = Intent().apply {
        action = Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
        data = Uri.parse("package:$packageName")
      }
      startActivityForResult(intent, REQUEST_BATTERY_OPTIMIZATION)
    } else {
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

  private fun showEnrollmentSecretDialog() {
    val input = android.widget.EditText(this).apply {
      inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
      hint = getString(R.string.enrollment_hint)
    }

    AlertDialog.Builder(this)
      .setTitle(getString(R.string.enrollment_dialog_title))
      .setMessage(getString(R.string.enrollment_dialog_message))
      .setView(input)
      .setPositiveButton(getString(R.string.dialog_button_save)) { _, _ ->
        val secret = input.text.toString()
        if (secret.length >= 32) {
          EncryptedPrefsHelper.storeEnrollmentSecret(this, secret)
          startService()
        } else {
          showEnrollmentSecretDialog()
        }
      }
      .setCancelable(false)
      .show()
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

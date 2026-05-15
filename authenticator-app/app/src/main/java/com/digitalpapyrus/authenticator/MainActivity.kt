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
        private const val PREFS_NAME = "authenticator_prefs"
        private const val PREF_AUTOSTART_PROMPTED = "autostart_prompted"
    }
    
    private lateinit var statusText: TextView
    private lateinit var autoStartButton: Button
    
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        setContentView(R.layout.activity_main)
        
        statusText = findViewById(R.id.statusText)
        autoStartButton = findViewById(R.id.autoStartButton)
        
        autoStartButton.setOnClickListener {
            openAutoStartSettings()
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
    
    private fun requestSmsPermissions() {
        val permissions = mutableListOf(
            android.Manifest.permission.RECEIVE_SMS,
            android.Manifest.permission.READ_SMS,
            android.Manifest.permission.SEND_SMS
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
        grantResults: IntArray
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
                data = Uri.parse("package:${packageName}")
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
            manufacturer.contains("vivo") || manufacturer.contains("huawei")) {
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
            data = Uri.parse("package:${packageName}")
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
            TimeUnit.MINUTES
        ).build()
        
        androidx.work.WorkManager.getInstance(this)
            .enqueueUniquePeriodicWork(
                ServiceKeepAliveWorker.getWorkName(this),
                androidx.work.ExistingPeriodicWorkPolicy.KEEP,
                workRequest
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

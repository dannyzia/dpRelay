package com.digitalpapyrus.dprelay.reader

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * One-screen onboarding (STAGE F8): server URL pre-filled with the
 * production default (or the stored override) + PAYMENT_READER_SECRET, both
 * persisted to EncryptedSharedPreferences. Nothing else is configurable —
 * the reader has exactly one job.
 */
class MainActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        val status = findViewById<TextView>(R.id.statusText)
        val urlInput = findViewById<EditText>(R.id.serverUrlInput)
        val secretInput = findViewById<EditText>(R.id.secretInput)
        val saveButton = findViewById<Button>(R.id.saveButton)
        val config = ReaderConfig(this)

        urlInput.setText(config.serverUrl().ifEmpty { BuildConfig.DEFAULT_SERVER_URL })
        status.setText(
            if (config.isConfigured()) R.string.status_configured else R.string.status_unconfigured,
        )

        saveButton.setOnClickListener {
            val url = urlInput.text.toString().trim()
            val secret = secretInput.text.toString()
            if (url.isEmpty() || secret.isEmpty()) {
                status.setText(R.string.error_empty_fields)
                return@setOnClickListener
            }
            config.save(url, secret)
            status.setText(R.string.saved)
            ensureSmsPermission()
            // Drain anything the receiver queued before onboarding finished.
            UploadWorker.schedule(this)
            // The URL is non-secret config; the secret is NEVER logged.
            Log.i(TAG, "reader configured: url=$url")
        }
    }

    /** RECEIVE_SMS is a dangerous permission — request it at onboarding. */
    private fun ensureSmsPermission() {
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.RECEIVE_SMS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.RECEIVE_SMS),
                SMS_PERMISSION_REQUEST,
            )
        }
    }

    companion object {
        private const val TAG = "PaymentReaderMain"
        private const val SMS_PERMISSION_REQUEST = 1001
    }
}

package com.digitalpapyrus.authenticator

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.ktx.auth
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.ktx.database
import com.google.firebase.ktx.Firebase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

/**
 * Foreground service that runs 24/7 on the dedicated authenticator phone.
 *
 * Responsibilities:
 * - Maintains persistent notification
 * - Authenticates with Firebase using custom token (role=authenticator)
 * - Enables RTDB offline persistence
 * - Handles Firebase auth token refresh
 * - Reports service state
 */
class AuthenticatorService : Service() {

  companion object {
    private const val TAG = "AuthenticatorService"
    private const val CHANNEL_ID = "authenticator_channel"
    private const val NOTIFICATION_ID = 1001

    const val ACTION_START_SERVICE = "com.digitalpapyrus.authenticator.action.START_SERVICE"
    const val ACTION_STOP_SERVICE = "com.digitalpapyrus.authenticator.action.STOP_SERVICE"
  }

  private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private lateinit var auth: FirebaseAuth
  private lateinit var database: FirebaseDatabase
  private var wakeLock: PowerManager.WakeLock? = null
  private var pendingSmsListener: PendingSmsListener? = null

  override fun onCreate() {
    super.onCreate()

    auth = Firebase.auth
    database = FirebaseDatabase.getInstance(
      "https://authenticator-15fb7-default-rtdb.asia-southeast1.firebasedatabase.app"
    ).apply {
      setPersistenceEnabled(true)
    }

    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START_SERVICE -> startAsForeground()
      ACTION_STOP_SERVICE -> stopService()
    }

    // Return START_STICKY to restart service if killed
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? {
    return null
  }

  override fun onDestroy() {
    super.onDestroy()
    stopPendingSmsListener()
    releaseWakeLock()
  }

  private fun startAsForeground() {
    val notification = createNotification()
    ServiceCompat.startForeground(
      this,
      NOTIFICATION_ID,
      notification,
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
      } else {
        0
      }
    )

    acquireWakeLock()
    authenticateWithFirebase()
    startV5PlaneIfEnabled()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        getString(R.string.notification_channel_name),
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = getString(R.string.notification_channel_description)
        setShowBadge(false)
      }

      val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      notificationManager.createNotificationChannel(channel)
    }
  }

  private fun createNotification(): Notification {
    val intent = Intent(this, MainActivity::class.java)
    val pendingIntent = PendingIntent.getActivity(
      this,
      0,
      intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(getString(R.string.notification_title))
      .setContentText(getString(R.string.notification_text_running))
      .setSmallIcon(android.R.drawable.ic_dialog_info)
      .setContentIntent(pendingIntent)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
  }

  private fun acquireWakeLock() {
    val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = powerManager.newWakeLock(
      PowerManager.PARTIAL_WAKE_LOCK,
      getString(R.string.wakelock_tag)
    ).apply {
      acquire(10 * 60 * 1000L) // 10 minutes
    }
  }

  private fun releaseWakeLock() {
    wakeLock?.let {
      if (it.isHeld) {
        it.release()
      }
    }
    wakeLock = null
  }

  private var authRetryCount = 0
  private val maxAuthRetries = 5
  private var authStateListenerRegistered = false

  // Health ping interval: 4 minutes (health endpoint uses 5-minute active window)
  private val HEALTH_PING_INTERVAL_MS = 4 * 60 * 1000L

  private fun authenticateWithFirebase() {
    serviceScope.launch {
      try {
        val enrollmentSecret = EncryptedPrefsHelper.getEnrollmentSecret(applicationContext)
          ?: throw IllegalStateException("Enrollment secret not configured")

        // Call registerAuthenticator to get custom token
        val customToken = DeviceRegistrationClient.registerDevice(
          applicationContext,
          enrollmentSecret
        )

        // Sign in with custom token
        auth.signInWithCustomToken(customToken).await()

        // Reset retry count on success
        authRetryCount = 0

        // Stop any existing listener before creating a new one.
        // This prevents accumulation if authenticateWithFirebase() is called
        // multiple times (e.g. after a transient auth drop).
        stopPendingSmsListener()

        // Write initial health ping and start periodic updates
        startHealthPingLoop()

        // Start listening for pending outbound SMS jobs
        startPendingSmsListener()

        // Register auth state listener exactly ONCE.
        // Previously this was added inside authenticateWithFirebase(), causing
        // a new listener on every re-auth call and exponential growth.
        if (!authStateListenerRegistered) {
          authStateListenerRegistered = true
          auth.addAuthStateListener { firebaseAuth ->
            if (firebaseAuth.currentUser == null) {
              // Re-authenticate if signed out
              authenticateWithFirebase()
            }
          }
        }
      } catch (e: Exception) {
        Log.e(
          TAG,
          "authenticateWithFirebase failed (attempt $authRetryCount): ${e.javaClass.simpleName}: ${e.message}",
          e
        )
        // Exponential backoff with jitter
        if (authRetryCount < maxAuthRetries) {
          val baseDelay = 2000L // 2 seconds
          val maxDelay = 60000L // 60 seconds max
          val backoff = (baseDelay * Math.pow(2.0, authRetryCount.toDouble())).toLong()
          val jitter = (Math.random() * 1000).toLong()
          val actualDelay = minOf(backoff + jitter, maxDelay)

          Log.i(TAG, "Retrying in ${actualDelay}ms (attempt ${authRetryCount + 1}/$maxAuthRetries)")
          authRetryCount++
          delay(actualDelay)
          authenticateWithFirebase()
        } else {
          Log.e(TAG, "Max retries reached, waiting 5 minutes before next attempt")
          authRetryCount = 0
          delay(300000) // 5 minutes
          authenticateWithFirebase()
        }
      }
    }
  }

  /**
   * Writes health/{androidId} to RTDB on login and every 4 minutes.
   *
   * Fields written: lastPing (ServerValue.TIMESTAMP), battery (0-100), device (Build.MODEL).
   * All three are required by the RTDB validation rules — omitting any one causes a silent
   * rejection. The Cloud Function health endpoint counts entries whose lastPing is within
   * the last 5 minutes, so we ping every 4 minutes to stay inside that window.
   *
   * v5 parallel run (M2): each tick ALSO posts a v5 heartbeat (feeds the v5
   * watchdog, R1 keep-alive) and pulls outstanding messages, so the phone
   * reports to both planes while they run side by side (PLAN §9).
   */
  private fun startHealthPingLoop() {
    serviceScope.launch {
      val androidId = Settings.Secure.getString(
        applicationContext.contentResolver,
        Settings.Secure.ANDROID_ID
      )
      val healthRef = database.getReference("health").child(androidId)

      while (true) {
        try {
          if (V5ApiClient.isEnabled()) {
            if (EncryptedPrefsHelper.getDeviceApiKey(applicationContext) == null) {
              // Retry enrollment from here — the service may start before
              // enrollment succeeded.
              V5ApiClient.enrollIfNeeded(applicationContext)
            }
            if (V5ApiClient.heartbeat(applicationContext)) {
              Log.i(TAG, "v5 heartbeat ok")
              // Post-heartbeat fetch: the no-FCM wake path (R1 semantics).
              OutstandingFetcher.fetchAndSend(applicationContext)
            } else {
              Log.w(TAG, "v5 heartbeat failed (legacy RTDB ping continues)")
            }
          }

          val pingData = mapOf(
            "lastPing" to com.google.firebase.database.ServerValue.TIMESTAMP,
            "battery" to getBatteryLevel(),
            "device" to Build.MODEL
          )
          healthRef.setValue(pingData).await()
        } catch (e: Exception) {
          Log.e(TAG, "Health ping failed", e)
        }
        delay(HEALTH_PING_INTERVAL_MS)
      }
    }
  }

  /**
   * Starts the PendingSmsListener after Firebase auth is established.
   * The listener watches /pending_sms for new outbound SMS jobs and sends them via SmsManager.
   */
  private fun startPendingSmsListener() {
    pendingSmsListener = PendingSmsListener(applicationContext).also {
      it.startListening()
    }
    Log.i(TAG, "PendingSmsListener started")
  }

  /** Guards against re-enrollment churn when the service restarts. */
  private var v5PlaneStarted = false

  /**
   * Starts the v5 device plane (M2 parallel run, PLAN §9) when compiled in:
   * enrolls against the v5 server (idempotent — only when no key is stored) and
   * kicks the first outstanding fetch. Subsequent fetches ride the heartbeat
   * loop and FCM wakes.
   */
  private fun startV5PlaneIfEnabled() {
    if (!V5ApiClient.isEnabled() || v5PlaneStarted) return
    v5PlaneStarted = true
    serviceScope.launch {
      val enrolled = V5ApiClient.enrollIfNeeded(applicationContext)
      if (!enrolled) {
        Log.w(TAG, "v5 enrollment failed — will retry from the heartbeat loop")
        v5PlaneStarted = false
        return@launch
      }
      // Register the current FCM token so the M3 server-side wake sender can
      // reach this device (storage-only on the server in M2).
      try {
        val token = com.google.firebase.messaging.FirebaseMessaging.getInstance().token.await()
        V5ApiClient.postFcmToken(applicationContext, token)
      } catch (e: Exception) {
        Log.w(TAG, "v5 fcm-token registration failed: ${e.javaClass.simpleName}")
      }
      OutstandingFetcher.fetchAndSend(applicationContext)
    }
  }

  /**
   * Stops the PendingSmsListener and releases its resources.
   */
  private fun stopPendingSmsListener() {
    pendingSmsListener?.stopListening()
    pendingSmsListener = null
    Log.i(TAG, "PendingSmsListener stopped")
  }

  /**
   * Returns the current battery level (0–100) using BatteryManager.
   * Returns -1 only if the system property is truly unavailable.
   */
  private fun getBatteryLevel(): Int {
    val batteryManager = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
    return batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
  }

  private fun stopService() {
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }
}

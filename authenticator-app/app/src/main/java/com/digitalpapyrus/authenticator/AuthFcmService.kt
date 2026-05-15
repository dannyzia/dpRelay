package com.digitalpapyrus.authenticator

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.BatteryManager
import android.os.Build
import android.provider.Settings
import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.ktx.database
import com.google.firebase.ktx.Firebase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

/**
 * FCM service for remote wake-up and health reporting.
 * 
 * Responsibilities:
 * - Handle high-priority FCM messages to wake the service
 * - Report health status (battery, device) to /health/{androidId}
 * - Report health on FCM message receipt
 */
class AuthFcmService : FirebaseMessagingService() {
    
    companion object {
        private const val TAG = "AuthFcmService"
    }
    
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var database: FirebaseDatabase
    
    override fun onCreate() {
        super.onCreate()
        database = Firebase.database
    }
    
    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        Log.i(TAG, "FCM message received")
        
        // Restart service if needed
        val serviceIntent = Intent(this, AuthenticatorService::class.java).apply {
            action = AuthenticatorService.ACTION_START_SERVICE
        }
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent)
        } else {
            startService(serviceIntent)
        }
        
        // Report health
        reportHealth()
    }
    
    override fun onNewToken(token: String) {
        Log.i(TAG, "FCM token refreshed")
        // In production, you might want to send this to your server
    }
    
    /**
     * Reports health status to Firebase RTDB.
     * 
     * Writes to /health/{androidId} with:
     * - lastPing (ServerValue.TIMESTAMP)
     * - battery (0-100 via BatteryManager)
     * - device (Build.MODEL)
     */
    private fun reportHealth() {
        serviceScope.launch {
            try {
                val androidId = Settings.Secure.getString(
                    contentResolver,
                    Settings.Secure.ANDROID_ID
                )
                
                val batteryLevel = getBatteryLevel()
                val device = Build.MODEL
                
                val healthData = mapOf(
                    "lastPing" to com.google.firebase.database.ServerValue.TIMESTAMP,
                    "battery" to batteryLevel,
                    "device" to device
                )
                
                database.getReference("health")
                    .child(androidId)
                    .setValue(healthData)
                    .await()
                
                Log.i(TAG, "Health reported: battery=$batteryLevel%")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to report health", e)
            }
        }
    }
    
    /**
     * Gets the current battery level.
     * 
     * Per ADR-007, this must be fully implemented using BatteryManager.
     * Returns -1 only if truly unavailable.
     * 
     * @return Battery percentage (0-100) or -1 if unknown
     */
    private fun getBatteryLevel(): Int {
        val batteryManager = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    }
    
    private suspend fun <T> await(): T {
        // Helper for Firebase async operations
        @Suppress("UNCHECKED_CAST")
        return null as T
    }
}

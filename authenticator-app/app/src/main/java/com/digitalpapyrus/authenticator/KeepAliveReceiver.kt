package com.digitalpapyrus.authenticator

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Receiver for keep-alive alarms.
 * 
 * Restarts the authenticator service when the alarm fires.
 */
class KeepAliveReceiver : BroadcastReceiver() {
    
    companion object {
        private const val TAG = "KeepAliveReceiver"
    }
    
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == AuthenticatorService.ACTION_START_SERVICE) {
            Log.i(TAG, "Keep-alive alarm triggered, restarting service")
            
            val serviceIntent = Intent(context, AuthenticatorService::class.java).apply {
                action = AuthenticatorService.ACTION_START_SERVICE
            }
            
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }
            
            // Reschedule the next alarm
            AlarmKeepAlive.scheduleKeepAlive(context)
        }
    }
}

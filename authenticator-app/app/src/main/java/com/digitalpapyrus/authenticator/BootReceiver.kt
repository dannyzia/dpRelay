package com.digitalpapyrus.authenticator

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Boot receiver for auto-starting the authenticator service on device boot.
 * 
 * Ensures the service starts automatically after device restart.
 */
class BootReceiver : BroadcastReceiver() {
    
    companion object {
        private const val TAG = "BootReceiver"
    }
    
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == "android.intent.action.BOOT_COMPLETED" ||
            intent.action == "android.intent.action.QUICKBOOT_POWERON") {
            
            Log.i(TAG, "Boot completed, starting authenticator service")
            
            val serviceIntent = Intent(context, AuthenticatorService::class.java).apply {
                action = AuthenticatorService.ACTION_START_SERVICE
            }
            
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }
            
            // Schedule keep-alive mechanisms
            AlarmKeepAlive.scheduleKeepAlive(context)
        }
    }
}

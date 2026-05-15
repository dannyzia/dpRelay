package com.digitalpapyrus.authenticator

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.AlarmManagerCompat

/**
 * Schedules exact alarms to keep the authenticator service alive.
 * 
 * Fires every 5 minutes to restart the service if it was killed by OEM
 * power management. Uses exact alarm permission (Android 12+).
 */
object AlarmKeepAlive {
    
    private const val ALARM_REQUEST_CODE = 1001
    private const val ALARM_INTERVAL_MS = 5 * 60 * 1000L // 5 minutes
    
    /**
     * Schedules a recurring exact alarm to restart the service.
     * 
     * @param context Application context
     */
    fun scheduleKeepAlive(context: Context) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val intent = Intent(context, KeepAliveReceiver::class.java).apply {
            action = AuthenticatorService.ACTION_START_SERVICE
        }
        
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        
        val pendingIntent = PendingIntent.getBroadcast(
            context,
            ALARM_REQUEST_CODE,
            intent,
            flags
        )
        
        val triggerAt = System.currentTimeMillis() + ALARM_INTERVAL_MS
        
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                AlarmManagerCompat.setExactAndAllowWhileIdle(
                    alarmManager,
                    AlarmManager.RTC_WAKEUP,
                    triggerAt,
                    pendingIntent
                )
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                alarmManager.setExactAndAllowWhileIdle(
                    AlarmManager.RTC_WAKEUP,
                    triggerAt,
                    pendingIntent
                )
            } else {
                alarmManager.setRepeating(
                    AlarmManager.RTC_WAKEUP,
                    triggerAt,
                    ALARM_INTERVAL_MS,
                    pendingIntent
                )
            }
        } catch (e: SecurityException) {
            // Exact alarm permission not granted - fallback to inexact alarm
            alarmManager.setRepeating(
                AlarmManager.RTC_WAKEUP,
                triggerAt,
                ALARM_INTERVAL_MS,
                pendingIntent
            )
        }
    }
    
    /**
     * Cancels the keep-alive alarm.
     * 
     * @param context Application context
     */
    fun cancelKeepAlive(context: Context) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val intent = Intent(context, KeepAliveReceiver::class.java)
        
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_NO_CREATE
        } else {
            PendingIntent.FLAG_NO_CREATE
        }
        
        val pendingIntent = PendingIntent.getBroadcast(
            context,
            ALARM_REQUEST_CODE,
            intent,
            flags
        )
        
        pendingIntent?.let {
            alarmManager.cancel(it)
        }
    }
}

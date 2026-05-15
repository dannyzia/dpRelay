package com.digitalpapyrus.authenticator

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * WorkManager worker for keep-alive (15-minute interval).
 * 
 * Acts as a fallback if the exact alarm is blocked by OEM restrictions.
 * WorkManager is more reliable across different Android versions.
 */
class ServiceKeepAliveWorker(
    context: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(context, workerParams) {
    
    companion object {
        private const val TAG = "ServiceKeepAliveWorker"
        private const val WORK_INTERVAL_MINUTES = 15L
        
        fun getWorkName(context: Context): String = context.getString(R.string.work_tag_keepalive)
    }
    
    override suspend fun doWork(): Result {
        return try {
            Log.i(TAG, "WorkManager keep-alive triggered")
            
            val serviceIntent = Intent(applicationContext, AuthenticatorService::class.java).apply {
                action = AuthenticatorService.ACTION_START_SERVICE
            }
            
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                applicationContext.startForegroundService(serviceIntent)
            } else {
                applicationContext.startService(serviceIntent)
            }
            
            Result.success()
        } catch (e: Exception) {
            Log.e(TAG, "WorkManager keep-alive failed", e)
            Result.retry()
        }
    }
}

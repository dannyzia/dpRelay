package com.digitalpapyrus.authenticator

import android.content.Context
import android.os.Build
import android.provider.Settings
import com.digitalpapyrus.authenticator.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.HttpsURLConnection

/**
 * Client for registering the authenticator device with the Cloud Function.
 * 
 * Calls POST /v4/registerAuthenticator with the enrollment secret to obtain
 * a Firebase custom token with role=authenticator claim.
 */
object DeviceRegistrationClient {
    
    private const val TAG = "DeviceRegistrationClient"
    
    /**
     * Registers the device and returns a Firebase custom token.
     * 
     * @param context Application context
     * @param enrollmentSecret The enrollment secret (from EncryptedSharedPreferences)
     * @return Firebase custom token
     * @throws Exception if registration fails
     */
    suspend fun registerDevice(context: Context, enrollmentSecret: String): String {
        return withContext(Dispatchers.IO) {
            val androidId = Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ANDROID_ID
            )
            val model = Build.MODEL
            
            val url = URL(BuildConfig.CF_REGISTER_AUTHENTICATOR_URL)
            val connection = url.openConnection() as HttpsURLConnection
            
            try {
                connection.requestMethod = "POST"
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setRequestProperty("Authorization", "Bearer $enrollmentSecret")
                connection.doOutput = true
                connection.connectTimeout = 30000
                connection.readTimeout = 30000
                
                val requestBody = JSONObject().apply {
                    put("androidId", androidId)
                    put("model", model)
                }
                
                connection.outputStream.use { os ->
                    os.write(requestBody.toString().toByteArray())
                }
                
                val responseCode = connection.responseCode
                if (responseCode != 200) {
                    throw Exception("Registration failed with HTTP $responseCode")
                }
                
                val response = BufferedReader(InputStreamReader(connection.inputStream)).use { reader ->
                    reader.readText()
                }
                
                val jsonResponse = JSONObject(response)
                jsonResponse.getString("firebaseCustomToken")
            } finally {
                connection.disconnect()
            }
        }
    }
}

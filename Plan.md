# Phone Number Authentication System (Dedicated Android Phone + Firebase)

> ⚠️ **DEPRECATED:** This document contains v1/v2 implementation guidance that is **outdated and insecure**.  
> For current v3.0 architecture with HMAC-SHA256 security, see `docs/Plan/01-PRD.md` and the complete planning suite in `docs/Plan/`.
> **Key differences in v3.0:** HMAC signatures replace plaintext secrets, POST body replaces URL parameters, SecureRandom replaces UUID.

**Version:** 1.0 (April 2026) — **SUPERSEDED by v3.0**  
**Author:** Grok (for Ziaur)  
**Purpose:** Historical reference only. A cheap, self-hosted phone-number verifier for your ecommerce app and medical app using **one dedicated old Android phone + SIM**.  
No server to maintain. No cost (Firebase free tier). Works offline from the user's perspective.

**This .md file is written so that even a lesser AI model (or junior developer) can build the entire system by copy-pasting every code block exactly.**

---

## 1. Overview

You have 3 apps:
1. **Authenticator App** → Installed ONLY on one dedicated cheap Android phone (the "auth phone"). This phone does NOTHING else.
2. **Ecommerce App** → User's phone.
3. **Medical App** → User's phone.

**Flow (exactly as you described):**
1. User in ecommerce/medical app enters their phone number.
2. The app generates a secret `sessionCode` (e.g. `AUTH-XYZ12345`).
3. The app asks for SMS permission and sends an SMS to your dedicated SIM number: `"AUTH:XYZ12345"`.
4. Authenticator app (on the dedicated phone) receives the SMS instantly.
5. It pushes the proof (`sender_number` + `sessionCode`) to Firebase Realtime Database.
6. Ecommerce/medical app calls a simple HTTPS endpoint (Cloud Function) with the `sessionCode`.
7. Cloud Function replies: `{"verified": true, "sender": "+88017xxxxxxxx"}`.
8. App shows "Phone verified ✓" and continues.

**Zero Firebase code** in your ecommerce or medical apps.

---

## 2. Architecture (Simple Text Diagram)
User Phone (Ecommerce/Medical App)
├── Enter phone number
├── Generate sessionCode
├── SEND_SMS permission → SMS to +88017XXXXXXXX
└── HTTP GET → https://checkauth-xxx.a.run.app?sessionCode=XXX
↓
Cloud Function (Firebase)
↓ (reads DB)
Dedicated Phone (Authenticator App)
├── RECEIVE_SMS + READ_SMS
├── Foreground Service (always running)
└── Push to Firebase Realtime DB → "sms_received"
text---

## 3. Prerequisites

- Google account (for Firebase)
- Android Studio (latest version – Flamingo or newer)
- One cheap Android phone (Android 10+) with a Bangladeshi SIM
- Charger + stable Wi-Fi (phone stays plugged in 24/7)

---

## 4. Step 1: Firebase Setup (5 minutes)

1. Go to [https://console.firebase.google.com](https://console.firebase.google.com)
2. Click **"Create a project"** → name it `PhoneAuthService`
3. Enable **Realtime Database** (NOT Firestore)
4. Enable **Authentication** → Anonymous sign-in
5. Go to **Realtime Database** → Rules → Replace with this:

```json
{
  "rules": {
    "sms_received": {
      ".read": "auth != null",
      ".write": "auth != null && auth.uid != null",
      "$pushId": {
        ".validate": "newData.hasChildren(['timestamp', 'sender', 'message', 'session_code']) && newData.child('timestamp').val() > now - 600000"
      }
    }
  }
}

Go to Functions → Enable Cloud Functions (2nd gen)


5. Step 2: Build the Authenticator App
Project Creation

Android Studio → New Project → Empty Activity
Name: PhoneAuthenticator
Package name: com.yourcompany.phoneauthenticator
Language: Kotlin
Minimum SDK: 24 (Android 7.0)

build.gradle (Module: app) – Add these dependencies
gradledependencies {
    implementation 'com.google.firebase:firebase-database:21.0.0'
    implementation 'com.google.firebase:firebase-auth:23.0.0'
    implementation 'androidx.core:core:1.13.0'
    implementation 'androidx.appcompat:appcompat:1.7.0'
}
Sync Gradle.
AndroidManifest.xml (full file)
XML<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.yourcompany.phoneauthenticator">

    <uses-permission android:name="android.permission.RECEIVE_SMS" />
    <uses-permission android:name="android.permission.READ_SMS" />
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="Phone Authenticator"
        android:theme="@style/Theme.PhoneAuthenticator">

        <!-- Foreground Service -->
        <service
            android:name=".AuthenticatorService"
            android:foregroundServiceType="remoteMessaging"
            android:exported="false" />

        <!-- SMS Receiver -->
        <receiver
            android:name=".SmsReceiver"
            android:exported="true"
            android:permission="android.permission.BROADCAST_SMS">
            <intent-filter>
                <action android:name="android.provider.Telephony.SMS_RECEIVED" />
            </intent-filter>
        </receiver>

        <!-- Boot receiver -->
        <receiver
            android:name=".BootReceiver"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
            </intent-filter>
        </receiver>

        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
Create these Kotlin files (exact code)
SmsReceiver.kt
Kotlinpackage com.yourcompany.phoneauthenticator

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.ServerValue

class SmsReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val smsMessages = Telephony.Sms.Intents.getMessagesFromIntent(intent)

        for (sms in smsMessages) {
            val sender = sms.originatingAddress ?: return
            val body = sms.messageBody ?: return

            val sessionCode = extractSessionCode(body)

            Log.d("Authenticator", "✅ SMS from $sender | Code: $sessionCode")

            pushToFirebase(sender, body, sessionCode)
        }
    }

    private fun extractSessionCode(body: String): String? {
        val regex = "(?i)(?:AUTH|VERIFY|CODE|OTP)[:\\s]*([A-Z0-9]{6,12})".toRegex()
        return regex.find(body)?.groupValues?.get(1)
    }

    private fun pushToFirebase(sender: String, body: String, sessionCode: String?) {
        val ref = FirebaseDatabase.getInstance().getReference("sms_received")

        val data = mapOf(
            "timestamp" to ServerValue.TIMESTAMP,
            "sender" to sender,
            "message" to body,
            "session_code" to (sessionCode ?: "none")
        )

        ref.push().setValue(data)
            .addOnSuccessListener { Log.d("Authenticator", "✅ Pushed to Firebase") }
            .addOnFailureListener { Log.e("Authenticator", "❌ Firebase error", it) }
    }
}
AuthenticatorService.kt
Kotlinpackage com.yourcompany.phoneauthenticator

import android.app.Notification
import android.app.Service
import android.content.Intent
import android.content.IntentFilter
import android.os.IBinder
import android.provider.Telephony
import androidx.core.app.ServiceCompat
import com.google.firebase.auth.FirebaseAuth

class AuthenticatorService : Service() {

    private lateinit var smsReceiver: SmsReceiver

    override fun onCreate() {
        super.onCreate()
        FirebaseAuth.getInstance().signInAnonymously()

        smsReceiver = SmsReceiver()
        val filter = IntentFilter(Telephony.Sms.Intents.SMS_RECEIVED_ACTION)
        registerReceiver(smsReceiver, filter)

        startForegroundNotification()
    }

    private fun startForegroundNotification() {
        val notification = Notification.Builder(this, "auth_channel")
            .setContentTitle("Phone Authenticator")
            .setContentText("Running 24/7 • Listening for SMS")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
            .build()

        ServiceCompat.startForeground(
            this,
            1,
            notification,
            Service.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        unregisterReceiver(smsReceiver)
        super.onDestroy()
    }
}
BootReceiver.kt
Kotlinpackage com.yourcompany.phoneauthenticator

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val serviceIntent = Intent(context, AuthenticatorService::class.java)
        ContextCompat.startForegroundService(context, serviceIntent)
    }
}
MainActivity.kt
Kotlinpackage com.yourcompany.phoneauthenticator

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)  // Create simple layout below

        requestPermissions()
        requestIgnoreBattery()

        val serviceIntent = Intent(this, AuthenticatorService::class.java)
        ContextCompat.startForegroundService(this, serviceIntent)
    }

    private fun requestPermissions() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECEIVE_SMS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(
                Manifest.permission.RECEIVE_SMS,
                Manifest.permission.READ_SMS
            ), 101)
        }
    }

    private fun requestIgnoreBattery() {
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
        intent.data = Uri.parse("package:$packageName")
        startActivity(intent)
    }
}
activity_main.xml (simple layout)
XML<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:gravity="center"
    android:orientation="vertical">

    <TextView
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="✅ Phone Authenticator\nRUNNING 24/7"
        android:textSize="24sp"
        android:textStyle="bold"
        android:gravity="center" />

    <TextView
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="Do NOT close this app.\nThis phone only listens for SMS."
        android:textSize="16sp"
        android:paddingTop="20dp" />
</LinearLayout>
Notification Channel (add in Application class or MainActivity)
Create MyApplication.kt:
Kotlinpackage com.yourcompany.phoneauthenticator

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build

class MyApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                "auth_channel",
                "Phone Authenticator",
                NotificationManager.IMPORTANCE_LOW
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }
}
Update AndroidManifest.xml <application android:name=".MyApplication">

6. Step 3: Deploy Cloud Function (HTTPS Endpoint)
In Firebase console → Functions → Create function:
File: index.js
JavaScriptconst { onRequest } = require("firebase-functions/v2/https");
const { getDatabase } = require("firebase-admin/database");
const admin = require("firebase-admin");

admin.initializeApp();

exports.checkAuth = onRequest(async (req, res) => {
  const sessionCode = req.query.sessionCode || req.body.sessionCode;
  if (!sessionCode) {
    return res.status(400).json({ verified: false, error: "missing sessionCode" });
  }

  const db = getDatabase();
  const ref = db.ref("sms_received");

  const snapshot = await ref.orderByChild("session_code")
    .equalTo(sessionCode)
    .limitToLast(5)
    .once("value");

  let verified = false;
  let sender = null;
  let timestamp = null;

  snapshot.forEach((child) => {
    const data = child.val();
    if (data.timestamp > Date.now() - 10 * 60 * 1000) {
      verified = true;
      sender = data.sender;
      timestamp = data.timestamp;
    }
  });

  res.json({
    verified: verified,
    sender: sender,
    timestamp: timestamp,
    sessionCode: sessionCode
  });
});
package.json (auto-generated, make sure it has "engines": { "node": "20" })
Click Deploy.
Copy the URL (e.g. https://checkauth-abc123.a.run.app).

7. Step 4: Settings Needed in Ecommerce / Medical App
Required Permissions (AndroidManifest.xml)
XML<uses-permission android:name="android.permission.SEND_SMS" />
<uses-permission android:name="android.permission.INTERNET" />
Runtime Permission Request (in your Activity)
Kotlinif (ContextCompat.checkSelfPermission(this, Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
    ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.SEND_SMS), 102)
}
Exact Code to Trigger Authentication (Kotlin example)
Kotlin// Inside your button click
val userPhone = editTextPhone.text.toString().trim()  // e.g. +88017xxxxxxxx
val sessionCode = "AUTH-" + UUID.randomUUID().toString().take(8).uppercase()

// 1. Send SMS to dedicated phone
val smsManager = SmsManager.getDefault()
smsManager.sendTextMessage(
    "+88017XXXXXXXX",   // ← YOUR DEDICATED SIM NUMBER
    null,
    "AUTH:$sessionCode",
    null,
    null
)

// 2. Call Cloud Function (no Firebase SDK needed)
val functionUrl = "https://checkauth-abc123.a.run.app?sessionCode=$sessionCode"

Thread {
    try {
        val connection = URL(functionUrl).openConnection() as HttpURLConnection
        connection.connectTimeout = 10000
        val responseCode = connection.responseCode

        if (responseCode == 200) {
            val response = connection.inputStream.bufferedReader().readText()
            val json = JSONObject(response)

            if (json.getBoolean("verified") && json.getString("sender") == userPhone) {
                runOnUiThread {
                    Toast.makeText(this, "✅ Phone number verified!", Toast.LENGTH_LONG).show()
                    // Proceed with login / checkout / medical flow
                }
            } else {
                runOnUiThread { Toast.makeText(this, "❌ Verification failed", Toast.LENGTH_LONG).show() }
            }
        }
    } catch (e: Exception) {
        runOnUiThread { Toast.makeText(this, "Network error", Toast.LENGTH_LONG).show() }
    }
}.start()
Optional: Poll every 2 seconds for 30 seconds for a better UX.

8. Final Deployment on Dedicated Phone

Build → Generate APK
Install on the dedicated phone
Open once → grant SMS permissions → allow battery optimization ignore
Plug in charger + Wi-Fi
Reboot phone → it will auto-start


9. Security & Maintenance

Change Firebase rules to production mode after testing.
Add a secret key in SMS and Cloud Function if you want extra protection.
Monitor Firebase usage (free tier is generous).
Keep the dedicated phone on charger 24/7.

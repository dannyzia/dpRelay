# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Keep Firebase classes
-keep class com.google.firebase.** { *; }
-keep interface com.google.firebase.** { *; }

# Keep EncryptedSharedPreferences
-keep class androidx.security.crypto.** { *; }

# Keep AuthCrypto
-keep class com.digitalpapyrus.authenticator.AuthCrypto { *; }

# Keep EncryptedPrefsHelper
-keep class com.digitalpapyrus.authenticator.EncryptedPrefsHelper { *; }

# ISSUE-118: R8 is now enabled on release (minifyEnabled + shrinkResources).
# The rules below keep runtime-reflective classes R8 cannot see statically.

# Kotlin metadata powers CoroutineDispatcher service loading and reflective
# calls — stripping it breaks Dispatchers.Main and debuggers on release.
-keep class kotlin.Metadata { *; }
-keepnames class kotlinx.coroutines.internal.MainDispatcherFactory {}
-keepnames class kotlinx.coroutines.CoroutineExceptionHandler {}
-keepnames class kotlinx.coroutines.android.AndroidExceptionPreloader {}
-keepnames class kotlinx.coroutines.android.AndroidDispatcherFactory {}

# WorkManager instantiates workers by name via reflection; the two-arg
# constructor is the reflective entry point and must survive shrinking.
-keep class * extends androidx.work.Worker
-keep class * extends androidx.work.ListenableWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}

# App data models parsed from org.json payloads (V5ApiClient) and the
# E.164 identity rules unit-tested on the JVM (GatewayIdentity).
-keep class com.digitalpapyrus.authenticator.GatewayIdentity { *; }
-keep class com.digitalpapyrus.authenticator.ServiceKeepAliveWorker { *; }

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

# Authenticator — Project Structure

```
/home/zia/Documents/My Projects/Authenticator/
├── authenticator-app/                    # Android Kotlin app
│   ├── app/src/main/java/com/digitalpapyrus/authenticator/
│   │   ├── AuthCrypto.kt                 # HMAC, SecureRandom, constant-time compare
│   │   ├── AuthenticatorService.kt       # Foreground service (REMOTE_MESSAGING type)
│   │   ├── AuthFcmService.kt             # FCM high-priority wake + health pings
│   │   ├── AlarmKeepAlive.kt             # Exact alarm keep-alive (5min)
│   │   ├── KeepAliveReceiver.kt          # Alarm broadcast receiver
│   │   ├── ServiceKeepAliveWorker.kt     # WorkManager keep-alive (15min)
│   │   ├── BootReceiver.kt               # Restart on boot / package replace
│   │   ├── SmsReceiver.kt                # SMS filter (AUTH: prefix) + normalizeToE164()
│   │   ├── EncryptedPrefsHelper.kt       # EncryptedSharedPreferences for enrollment secret
│   │   ├── DeviceRegistrationClient.kt   # registerAuthenticator API client
│   │   ├── PhoneAuthHelper.kt            # Client-side verification helper (POST + polling)
│   │   └── MainActivity.kt              # Setup UI, permissions, enrollment prompt
│   ├── app/src/test/java/com/digitalpapyrus/authenticator/
│   │   ├── AuthCryptoTest.kt             # 100% coverage crypto tests
│   │   └── SmsReceiverTest.kt            # normalizeToE164() tests
│   ├── build.gradle                      # App build config
│   ├── ktlint.gradle                     # ktlint config
│   └── settings.gradle
├── functions/                            # Firebase Cloud Functions (Node.js 20)
│   ├── index.js                          # All CF handlers
│   ├── index.test.js                     # Jest tests
│   ├── database.rules.json               # RTDB security rules
│   ├── package.json
│   ├── jest.config.js
│   └── .eslintrc.json
├── docs/Modification Plan 1/             # SSOT for active planning docs (AI must read/write here)
│   └── 14-DEV-CHECKLIST.yaml             # CANONICAL checklist — single source of truth
├── docs/Plan/                            # Older baseline copies — NOT authoritative for AI edits
├── scripts/                              # pre-commit.sh
├── .github/workflows/                    # CI/CD: pr-checks, staging-deploy, production-deploy
├── firebase.json
├── .env.example
├── database.rules.json                   # Root-level copy
├── README.md
├── IMPLEMENTATION_SUMMARY.md
└── AUDIT_FIXES_SUMMARY.md
```

## Package Name
`com.digitalpapyrus.authenticator`

## Firebase Project
`authenticator-15fb7` (production)

## Key Constants (CF)
CLOCK_SKEW_MS, VERIFICATION_TTL_MS, RATE_LIMIT_START_VERIFICATION, RATE_LIMIT_CHECK_AUTH
Secrets via defineSecret(): VERIFICATION_SIGNING_SECRET, AUTHENTICATOR_ENROLLMENT_SECRET, HEALTH_ADMIN_SECRET, ACTIVE_DEDICATED_NUMBER

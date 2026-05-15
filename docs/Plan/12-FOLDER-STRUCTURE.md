<!--
AI: This is the source of truth for where files live. Always create new files in the locations defined here.
Read first: 03-TECH-STACK.md (for framework conventions), 13-CONVENTIONS.md (for naming rules)
You must: Place every new file in the correct directory as defined here. Update this doc when you add a new directory.
You must not: Create files at the project root unless listed here. Create new top-level directories without updating this doc.
Human reviews this: NO — AI determines structure based on tech stack, human verifies output.
-->

# Folder Structure
**Project:** Authenticator

## Authenticator App
```
authenticator-app/
├── app/
│   ├── src/main/
│   │   ├── java/com/yourcompany/phoneauthenticator/
│   │   │   ├── MyApplication.kt           ← Application class (notification channel)
│   │   │   ├── MainActivity.kt            ← Permissions + battery + auto-start UI
│   │   │   ├── AuthenticatorService.kt    ← Foreground service + Firebase custom auth + wakelock
│   │   │   ├── SmsReceiver.kt             ← SMS challenge parsing + RTDB receipt write
│   │   │   ├── AuthCrypto.kt              ← Constant-time helpers + token utilities
│   │   │   ├── AuthFcmService.kt          ← FCM backup wake-up + health reporting
│   │   │   ├── DeviceRegistrationClient.kt ← `registerAuthenticator` bootstrap client
│   │   │   ├── AlarmKeepAlive.kt          ← Exact alarm scheduler (5 min)
│   │   │   ├── KeepAliveReceiver.kt       ← Alarm receiver + service restart
│   │   │   ├── ServiceKeepAliveWorker.kt  ← WorkManager keep-alive (15 min)
│   │   │   └── BootReceiver.kt            ← Auto-start on boot
│   │   ├── res/layout/
│   │   │   └── activity_main.xml          ← Main screen layout
│   │   └── AndroidManifest.xml            ← Permissions, services, receivers
│   ├── build.gradle                       ← Dependencies + BuildConfig fields
│   └── google-services.json               ← Firebase config (from console, git-ignored)
├── build.gradle                           ← Project-level build config
├── settings.gradle                        ← Module includes
└── gradle.properties                      ← Gradle settings
```

## Cloud Functions
```
functions/
├── index.js                               ← startVerification + checkAuth + registerAuthenticator + health + cleanupOldRequests
├── config.js                              ← Centralized configuration + secrets
├── package.json                           ← Dependencies
├── firebase.json                          ← Firebase project config
└── .gitignore                             ← Don't commit .env or secrets
```

## Client App (Ecommerce/Medical)
```
your-app/
└── app/src/main/java/com/yourcompany/yourapp/
    └── auth/
        └── PhoneAuthHelper.kt             ← startVerification + SMS send + poll helper
```

## Documentation
```
docs/
├── Plan/                                  ← This directory (project planning)
│   ├── 01-PRD.md through 19-GLOSSARY.md
├── 00-Overview.md                         ← System overview + threat model
├── 01-Architecture.md                     ← Architecture diagram + data flow
├── 02-Prerequisites.md                    ← What you need
├── 03-Firebase-Setup.md                   ← Firebase project + rules
├── 04-Authenticator-App.md                ← Complete authenticator app code
├── 05-Cloud-Functions.md                  ← Cloud Functions code
├── 06-Client-App.md                       ← Client app integration code
├── 07-Deployment.md                       ← Deployment steps
├── 08-Security-Maintenance.md             ← Security + Terraform + BigQuery
├── 09-Troubleshooting.md                  ← Problems + solutions
├── 10-Migration-Path.md                   ← v1/v2 → v3 upgrade
├── 11-File-Structure.md                   ← File tree
└── 12-Config-Reference.md                 ← All secrets + config
```

## Placement rules
| File type | Goes in | Example |
|-----------|---------|--------|
| Kotlin source | `app/src/main/java/{package}/` | `AuthenticatorService.kt` |
| Layout XML | `app/src/main/res/layout/` | `activity_main.xml` |
| Build config | `app/build.gradle` | BuildConfig fields |
| Firebase config | `app/google-services.json` | Downloaded from console |
| Cloud Function logic | `functions/index.js` | `exports.checkAuth` |
| Function config | `functions/config.js` | `defineSecret()` calls |
| HMAC utilities | Shared across apps | `AuthCrypto.kt` must be identical |
| Unit tests | `app/src/test/java/{package}/` | `AuthCryptoTest.kt` |
| Integration tests | `app/src/androidTest/java/{package}/` | `VerificationFlowTest.kt` |

## CI/CD & DevOps
```
.github/
├── workflows/
│   ├── pr-checks.yml        # Lint, test on PR
│   ├── staging-deploy.yml   # Auto-deploy to dev
│   └── production-deploy.yml # Manual prod deploy

scripts/
├── validate-env.sh          # Environment variable validation
├── setup-emulator.sh        # Local emulator setup
└── health-check.sh          # Production health verification

config/
├── codestyle.xml            # Android Studio code style
├── ktlint-config.xml        # ktlint configuration
└── eslint-config.js         # ESLint configuration
```

## Documentation
```
docs/
├── Plan/
│   ├── 01-PRD.md through 19-GLOSSARY.md    # Core planning
│   ├── 20-TEST-PLAN.md      # Testing strategy (NEW)
│   ├── 21-CI-CD.md          # Pipeline configuration (NEW)
│   └── 22-THREAT-MODEL.md   # Security analysis (NEW)
├── 00-Overview.md           # System overview + threat model
├── 01-Architecture.md       # Architecture diagram + data flow
└── ... (other docs)
```

> **Note:** Implementation directories (`authenticator-app/`, `functions/`) are created during development. These are not in version control until initial implementation begins. See `10-DEV-SETUP.md` for setup instructions.

## What must never happen
- Business logic in Activity or layout files — put it in services/utilities
- Firebase SDK calls directly from client apps (only PhoneAuthHelper uses HTTP)
- `google-services.json` committed to public repos
- Public client app containing `VERIFICATION_SIGNING_SECRET`
- Test files mixed into `src/main/` directories
- Secrets in CI configuration files (use GitHub Secrets)

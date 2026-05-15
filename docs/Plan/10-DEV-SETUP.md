<!--
AI: This is the complete local development setup procedure. Follow it in order. Do not skip steps.
Read first: 03-TECH-STACK.md (for tool versions), 11-ENV-VARS.md (for what goes in .env)
You must: Verify the setup works using the checklist at the end. Do not assume success.
You must not: Skip the environment variable step. Hard-code any values that belong in .env.
Human reviews this: NO — this is an executable setup guide for AI and developers.
-->

# Local Dev Setup
**Project:** Authenticator

## Prerequisites
| Tool | Minimum version | Install command / link |
|------|----------------|------------------------|
| Android Studio | Flamingo or newer | https://developer.android.com/studio |
| Node.js | 20.x | https://nodejs.org |
| Firebase CLI | latest | `npm install -g firebase-tools` |
| JDK | 17 | Included with Android Studio |

## Steps

### 1. Clone and install
```bash
git clone <repo-url>
cd Authenticator
```

### 2. Configure environment

#### Authenticator App
Open `app/build.gradle` and set:
- `AUTHENTICATOR_ENROLLMENT_SECRET` — your 32+ char authenticator bootstrap secret
- `CF_URL` — your Cloud Functions base URL

Place `google-services.json` from Firebase Console in `app/` folder.

#### Cloud Functions
```bash
cd functions
npm install
firebase functions:secrets:set VERIFICATION_SIGNING_SECRET
firebase functions:secrets:set AUTHENTICATOR_ENROLLMENT_SECRET
firebase functions:secrets:set HEALTH_ADMIN_SECRET
firebase functions:secrets:set ACTIVE_DEDICATED_NUMBER
```

### 3. Set up Firebase project
Follow `docs/03-Firebase-Setup.md`:
1. Create Firebase project `PhoneAuthService`
2. Enable Realtime Database
3. Prepare Firebase custom auth token issuance via Cloud Functions admin SDK
4. Enable Cloud Functions (Blaze plan)
5. Set security rules from `03-Firebase-Setup.md`
6. Register Android app, download `google-services.json`

### 4. Deploy Cloud Functions
```bash
cd functions
npm install
firebase deploy --only functions
# Note the base Cloud Functions URL from output
```

### 5. Build authenticator app
```bash
# In Android Studio: Build → Generate Signed Bundle / APK
# Or command line:
./gradlew assembleDebug
```

### 6. Start dev server (Cloud Functions emulator, optional)
```bash
firebase emulators:start --only functions
```

## Verify it works
- [ ] Cloud Functions deployed: `firebase functions:list` shows `startVerification`, `checkAuth`, `registerAuthenticator`, `health`, `cleanupOldRequests`
- [ ] Health check returns OK: `curl -H "Authorization: Bearer {SECRET}" https://{url}/health`
- [ ] Authenticator APK installs and shows "RUNNING 24/7" notification
- [ ] `registerAuthenticator` returns a Firebase custom token for the dedicated device
- [ ] Test SMS `AUTH:TESTCODE:1712345978901:invalidchallenge` is rejected by `checkAuth`
- [ ] Full verification flow works end-to-end from a client app

## Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `google-services.json` not found | File not placed in `app/` folder | Download from Firebase Console → Project Settings → Android app |
| Functions deploy fails | Blaze plan not enabled | Upgrade Firebase project to Blaze plan |
| Functions deploy fails | Required secrets not set | Run the `firebase functions:secrets:set ...` commands for all four v4 secrets |
| `registerAuthenticator` returns 403 | Wrong authenticator enrollment secret | Verify `AUTHENTICATOR_ENROLLMENT_SECRET` matches the Firebase secret |
| `checkAuth` returns 403 | Poll token invalid or expired | Restart verification from `startVerification` |
| `checkAuth` returns 403 | Challenge token mismatch | Verify the SMS body came from `startVerification` and was not altered |
| Health endpoint 403 | Wrong `Authorization` header | Verify `Bearer {HEALTH_ADMIN_SECRET}` format |
| Health endpoint 403 | Secret rotated but not updated | Update secret in health check curl command |
| Health endpoint "degraded" | Authenticator phone offline | Check phone power, Wi-Fi, notification showing |
| Health endpoint "degraded" | FCM token invalid | Reinstall authenticator app to refresh token |
| Service dies after 5 min | Battery optimization enabled | Disable battery optimization for the app |
| Service dies on OEM phone | Aggressive power management | Enable auto-start in OEM settings (Xiaomi, Oppo, Vivo) |
| SMS not received | RECEIVE_SMS permission denied | Reinstall app and grant SMS permission |
| SMS not received | SMS app intercepting | Set default SMS app to system app temporarily |
| SMS not written to RTDB | Custom auth failed | Check `registerAuthenticator` flow, retry auth |
| SMS not written to RTDB | RTDB rules rejecting | Verify rules allow write only with `auth.token.role == 'authenticator'` |
| CF returns 429 immediately | Rate limit exceeded | Wait 60 seconds, then retry |
| CF returns 500 | Verification record inconsistent | Check `/verification_requests/{sessionCode}` contents and recent deploys |
| CF returns 400 | Clock skew | Check device NTP sync, retry after time correction |
| ktlint fails | Formatting issues | Run `./gradlew ktlintFormat` to auto-fix |
| Android Lint fails | Lint warnings | Fix or suppress with `@SuppressLint` annotation |
| ESLint fails | JS style issues | Run `cd functions && npm run lint:fix` |
| Build fails | JDK version mismatch | Verify JDK 17 is installed and selected in Android Studio |
| Build fails | Gradle daemon issues | Run `./gradlew --stop` then rebuild |

## IDE Configuration

### Android Studio
1. **Install ktlint plugin:**
   - File → Settings → Plugins → Marketplace → "ktlint"
   - Restart Android Studio

2. **Configure code style:**
   - File → Settings → Editor → Code Style → Kotlin
   - Import project style from `config/codestyle.xml` (if provided)

3. **Set JDK:**
   - File → Settings → Build, Execution, Deployment → Build Tools → Gradle
   - Set Gradle JDK to 17

### VS Code (for Cloud Functions)
1. **Extensions:**
   - ESLint
   - Prettier
   - Firebase extension (optional)

2. **Settings:**
   ```json
   {
     "editor.formatOnSave": true,
     "editor.defaultFormatter": "esbenp.prettier-vscode"
   }
   ```

## Firebase Emulator Suite Setup

For local development without deploying:

```bash
# 1. Start emulators
firebase emulators:start --only functions,database,auth

# 2. In another terminal, verify emulators running
curl http://localhost:5001/PhoneAuthService/us-central1/checkAuth

# 3. Use emulator in Android app (debug builds only)
# Add to app/build.gradle (debug):
buildConfigField "String", "CF_URL", '"http://10.0.2.2:5001/PhoneAuthService/us-central1/checkAuth"'

# 4. Run tests against emulator
./gradlew connectedAndroidTest
```

**Note:** The Android emulator uses `10.0.2.2` to access host localhost.

## Pre-commit Hooks Setup

Configure Git hooks to run checks before each commit:

```bash
# Create pre-commit hook
cat > .git/hooks/pre-commit << 'EOF'
#!/bin/bash
echo "Running pre-commit checks..."

# ktlint
./gradlew ktlintCheck || exit 1

# Android Lint (only modified files)
./gradlew lintDebug || exit 1

# Function tests
cd functions && npm test || exit 1

echo "✅ All checks passed!"
EOF

chmod +x .git/hooks/pre-commit
```

**Optional:** Use [Husky](https://typicode.github.io/husky/) for cross-platform hooks.

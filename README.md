# Phone Authenticator v4

A production-grade SMS-based phone number verification system using Firebase Cloud Functions and a dedicated Android authenticator device.

## Architecture

- **Client App**: Initiates verification requests via Cloud Functions
- **Cloud Functions**: Server-issued challenges, HMAC verification, rate limiting
- **Authenticator App**: Dedicated Android phone that receives SMS and writes receipts to Firebase RTDB
- **Firebase RTDB**: Stores verification requests and receipts with security rules

## Security Features

- **Server-issued challenges**: No client-held shared secrets (ADR-012)
- **Constant-time HMAC comparison**: Prevents timing attacks
- **Runtime enrollment secret**: Never compiled into APK (ADR-016, TD-09)
- **E.164 normalization**: Handles Bangladesh carrier formats (ADR-015, TD-10)
- **Atomic deletes**: Prevents replay attacks
- **Rate limiting**: Per-IP limits on verification and check requests
- **Firebase custom auth**: role=authenticator for device writes

## Project Structure

```
Authenticator/
├── authenticator-app/          # Android authenticator app
│   ├── app/
│   │   ├── src/main/           # Kotlin source code
│   │   │   └── java/com/yourcompany/phoneauthenticator/
│   │   │       ├── AuthCrypto.kt
│   │   │       ├── EncryptedPrefsHelper.kt
│   │   │       ├── AuthenticatorService.kt
│   │   │       ├── SmsReceiver.kt
│   │   │       └── ...
│   │   └── src/test/           # Unit tests
│   └── build.gradle
├── functions/                  # Cloud Functions
│   ├── index.js                # Main functions
│   ├── index.test.js           # Unit tests
│   ├── database.rules.json     # RTDB security rules
│   └── package.json
├── docs/Plan/                  # Planning documents
└── firebase.json              # Firebase configuration
```

## Setup

### Prerequisites

- Android Studio (for authenticator app)
- Node.js 20.x (for Cloud Functions)
- Firebase CLI
- Firebase project with:
  - Realtime Database enabled
  - Authentication enabled
  - Cloud Functions enabled

### Authenticator App Setup

1. Open `authenticator-app/` in Android Studio
2. Add `google-services.json` to `app/src/`
3. Build and install on dedicated Android phone
4. Enter enrollment secret on first run (runtime-only, never compiled)

### Cloud Functions Setup

1. Navigate to `functions/`
2. Install dependencies: `npm install`
3. Set secrets via Firebase CLI:
   ```bash
   firebase functions:secrets:set VERIFICATION_SIGNING_SECRET
   firebase functions:secrets:set AUTHENTICATOR_ENROLLMENT_SECRET
   firebase functions:secrets:set HEALTH_ADMIN_SECRET
   firebase functions:secrets:set ACTIVE_DEDICATED_NUMBER
   ```
4. Deploy: `firebase deploy --only functions,database`

### Database Rules

Deploy the security rules:
```bash
firebase deploy --only database
```

## API Endpoints

### POST /v4/startVerification

Initiates a phone number verification.

**Request:**
```json
{
  "phoneNumber": "+8801712345678",
  "clientTimestamp": 1234567890
}
```

**Response:**
```json
{
  "sessionCode": "A3F1B9C2E4",
  "expiresAt": 1234567890,
  "pollToken": "base64_encoded_token"
}
```

### POST /v4/checkAuth

Checks if verification is complete.

**Request:**
```json
{
  "sessionCode": "A3F1B9C2E4",
  "pollToken": "base64_encoded_token"
}
```

**Response:**
```json
{
  "status": "verified",
  "sender": "+8801712345678"
}
```

### POST /v4/registerAuthenticator

Registers an authenticator device.

**Headers:**
```
Authorization: Bearer <AUTHENTICATOR_ENROLLMENT_SECRET>
```

**Request:**
```json
{
  "androidId": "abc123",
  "model": "Pixel 6"
}
```

**Response:**
```json
{
  "firebaseCustomToken": "custom_token_here"
}
```

### GET /health

Health check endpoint.

**Headers:**
```
Authorization: Bearer <HEALTH_ADMIN_SECRET>
```

**Response:**
```json
{
  "status": "healthy",
  "timestamp": 1234567890
}
```

## Testing

### Android Tests

```bash
cd authenticator-app
./gradlew test
```

### Cloud Functions Tests

```bash
cd functions
npm test
```

### Linting

```bash
# Android
cd authenticator-app
./gradlew ktlintCheck

# Cloud Functions
cd functions
npm run lint
```

## Critical Security Notes

- **TD-09 (BLOCKER)**: AUTHENTICATOR_ENROLLMENT_SECRET must NEVER be in BuildConfig. It is runtime-only via EncryptedSharedPreferences.
- **TD-10 (BLOCKER)**: SmsReceiver MUST normalize phone numbers to E.164 format. This is tested in `SmsReceiverTest.kt`.
- **No debug logs**: Production code uses only Log.i, Log.w, Log.e - never Log.d or Log.v.
- **POST-only**: All verification endpoints are POST-only, never GET.

## Deployment

See `docs/Plan/15-RUNBOOK-DEPLOY.md` for the complete deployment runbook.

## Known Issues

See `docs/Plan/18-KNOWN-ISSUES.md` for known issues and tech debt.

## License

Proprietary - All rights reserved.

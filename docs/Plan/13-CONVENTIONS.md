<!--
AI: These conventions apply to every file in this project without exception.
Read first: 03-TECH-STACK.md (for language, formatter, linter)
You must: Follow every naming rule here. Run formatter and linter before considering any change complete.
You must not: Use naming patterns not listed here. Bypass linting. Leave warnings unresolved.
Human reviews this: YES — team must agree on conventions before implementation starts.
-->

# Coding Conventions
**Project:** Authenticator

## Tooling
| Tool | Value | Run command |
|------|-------|-------------|
| Language | Kotlin (Android) / JavaScript (Node.js) | — |
| Formatter | ktlint (Android) / Prettier (JS) | `./gradlew ktlintCheck` / `npx prettier --check .` |
| Linter | Android Lint / ESLint | `./gradlew lint` / `npx eslint .` |
| Type checker | Kotlin compiler | `./gradlew compileDebugKotlin` |

**Enforce on commit:** All must pass before a commit is accepted.

## Naming conventions
| Thing | Convention | Example |
|-------|------------|---------|
| Kotlin files | PascalCase matching class name | `AuthCrypto.kt`, `SmsReceiver.kt` |
| Kotlin classes | PascalCase | `AuthenticatorService` |
| Kotlin functions | camelCase | `generateSignature()`, `pushToFirebase()` |
| Kotlin constants | SCREAMING_SNAKE_CASE in companion object | `AUTHENTICATOR_ENROLLMENT_SECRET`, `CLOCK_SKEW_MS` |
| Kotlin variables | camelCase | `sessionCode`, `wakeLock` |
| JavaScript files | camelCase | `config.js`, `index.js` |
| JavaScript functions | camelCase | `checkRateLimit()`, `verifyPollToken()` |
| JavaScript constants | SCREAMING_SNAKE_CASE | `RATE_LIMIT_MAX`, `SMS_TTL_MS` |
| Firebase RTDB paths | snake_case | `verification_requests`, `health` |
| BuildConfig fields | SCREAMING_SNAKE_CASE | `AUTHENTICATOR_ENROLLMENT_SECRET`, `CF_URL` |
| Android resources | snake_case | `activity_main.xml`, `auth_channel` |

## Language-specific rules

### General (all languages)
- No commented-out code in committed files — delete it or open an issue.
- No debug print/log statements in committed code — use `Log.d`/`Log.e` (Android) or `console.log`/`console.warn` (CF).
- Functions do one thing. If a function needs a comment to explain what it does, split it.

### Kotlin (Android)
- No `any` type — use proper types or generics
- Use `companion object` for constants, not top-level `const`
- Use `?.let` / `?:` for null handling — avoid `!!` force unwrap
- Keep Android lifecycle methods minimal — delegate to helper functions
- Use `ContextCompat` and `ServiceCompat` for backward compatibility

### JavaScript (Cloud Functions)
- Use `const` for all declarations — no `var`
- Use `crypto.timingSafeEqual()` for all HMAC comparisons — never `===` for secrets
- Use `async/await` — no raw `.then()` chains
- Validate input at the top of the handler — fail fast with appropriate HTTP code

### Error handling

#### Kotlin (Android)
- Use `try/catch` around all I/O operations (SMS sending, Firebase writes, network calls)
- Never catch and swallow exceptions silently — at minimum log with `Log.e(TAG, "message", exception)`
- For expected failures (SMS send fails, auth fails), use specific exception types:
  ```kotlin
  // Good: Specific handling
  try {
      smsManager.sendTextMessage(...)
  } catch (e: SecurityException) {
      Log.w(TAG, "SMS permission denied", e)
      showRetryGuidance()
  } catch (e: NullPointerException) {
      Log.w(TAG, "SIM not ready", e)
      showRetryGuidance()
  }

  // Bad: Silent catch
  try {
      smsManager.sendTextMessage(...)
  } catch (e: Exception) {
      // Swallowed — user sees nothing
  }
  ```
- Use `Result<T>` or sealed classes for operation results, not null:
  ```kotlin
  sealed class VerificationResult {
      data class Verified(val sender: String) : VerificationResult()
      data class Pending(val remainingAttempts: Int) : VerificationResult()
      data class Failed(val reason: String) : VerificationResult()
  }
  ```

#### JavaScript (Cloud Functions)
- All async operations must be wrapped in try/catch
- Return structured error responses, never throw:
  ```javascript
  // Good
  try {
      const snapshot = await db.ref(path).once('value');
  } catch (error) {
      logger.error('DB read failed', { path, error: error.message });
      return res.status(500).json({ verified: false, error: 'internal_error' });
  }

  // Bad: Unhandled promise rejection
  const snapshot = await db.ref(path).once('value'); // May crash CF
  ```

### Threading & concurrency

#### Kotlin (Android)
- **Main thread:** UI updates only. `SmsReceiver.onReceive()` runs on main thread — delegate all work to helper functions immediately.
- **`GlobalScope` prohibited** — use `lifecycleScope` (Activity) or `CoroutineScope(Dispatchers.IO)` (Service).
- **Firebase operations** run on their own internal threads; use `addOnSuccessListener`/`addOnFailureListener` callbacks, NOT `await()` on main thread.
- **Wakelock:** Acquire before async work, release in `finally` block:
  ```kotlin
  wakeLock.acquire(5_000)
  try {
      // async work
  } finally {
      if (wakeLock.isHeld) wakeLock.release()
  }
  ```

#### JavaScript (Cloud Functions)
- Use `async/await` for all async operations — never `.then()` chains.
- One `await` per logical step; do not parallelize independent DB reads unless performance requires it.
- Cloud Functions auto-scale; no thread pool management needed.

### Firebase RTDB
- Use session code as key for O(1) lookup — never `push()` with random keys
- Always use `ServerValue.TIMESTAMP` for server-side timestamps
- Schema enforced via Firebase Rules — see `05-DATA-MODEL.md`

### Security
- Never log the `VERIFICATION_SIGNING_SECRET`, `AUTHENTICATOR_ENROLLMENT_SECRET`, or `HEALTH_ADMIN_SECRET` values — only log their lengths for debugging
- Never store SMS body text in the database — only `receivedAt`, `sender`, `challengeToken`, `device`
- Use constant-time comparison for all HMAC operations (both Kotlin and JS)

## Import Ordering

### Kotlin (Android)
Order imports as follows:
1. Android / Platform imports (`android.*`, `androidx.*`)
2. Third-party library imports (`com.google.*`, `com.firebase.*`)
3. Project imports (`com.yourcompany.*`)
4. Within each group: alphabetically

```kotlin
// Correct
import android.content.Context
import android.os.BatteryManager
import androidx.core.app.ServiceCompat
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.database.FirebaseDatabase
import com.yourcompany.phoneauthenticator.AuthCrypto
import com.yourcompany.phoneauthenticator.AuthenticatorService
```

### JavaScript (Cloud Functions)
Order requires as follows:
1. Node.js built-in modules (`crypto`, `http`)
2. Third-party packages (`firebase-*`)
3. Local modules (`./config`, `./utils`)
4. Within each group: alphabetically

```javascript
// Correct
const crypto = require('crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { getDatabase } = require('firebase-admin/database');
const config = require('./config');
const { verifyHmac } = require('./crypto');
```

## Production Hardening

### Android (Release Builds)
- `minifyEnabled true` (ProGuard/R8)
- `shrinkResources true`
- No debug flags in release (`debuggable false`)
- Signing config properly configured (not in version control)

### Cloud Functions
- Node.js 20 with `'use strict'`
- No `console.log` — use Firebase logger only
- No stack traces in error responses (log only)
- Timeout set appropriately (default 60s, reduce if possible)
- Memory allocation appropriate for workload (default 256MB)

## Git conventions
| Thing | Convention | Example |
|-------|------------|---------|
| Commit messages | Conventional Commits | `feat(auth): add HMAC signature validation`, `fix(service): resolve wakelock leak` |
| Branch names | `type/short-description` | `feat/hmac-signing`, `fix/oem-service-kill` |
| PR titles | Same as commit format | `feat: add HMAC-SHA256 signature chain` |
| Protected branches | `main`, `develop` | No force-push. No direct commits. PR required. |

## Pre-commit Checklist
Before committing, run:
```bash
./gradlew ktlintCheck      # Format check
cd functions && npm run lint   # ESLint
./gradlew lint             # Android Lint
./gradlew test             # Unit tests
cd functions && npm test   # Function tests
```

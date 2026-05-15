# Authenticator — Code Style & Conventions

## Naming
| Thing | Convention | Example |
|-------|-----------|---------|
| Kotlin files | PascalCase matching class | `AuthCrypto.kt` |
| Kotlin classes | PascalCase | `AuthenticatorService` |
| Kotlin functions | camelCase | `generateSignature()` |
| Kotlin constants | SCREAMING_SNAKE_CASE in companion object | `CLOCK_SKEW_MS` |
| Kotlin variables | camelCase | `sessionCode` |
| JS files | camelCase | `index.js` |
| JS functions | camelCase | `checkRateLimit()` |
| JS constants | SCREAMING_SNAKE_CASE | `RATE_LIMIT_MAX` |
| Firebase RTDB paths | snake_case | `verification_requests` |
| Android resources | snake_case | `activity_main.xml` |

## Kotlin Rules
- No `!!` force-unwrap; use `?.let` / `?:`
- `companion object` for constants
- `try/catch` around all I/O; never swallow silently
- Use `ContextCompat`/`ServiceCompat` for compat
- Use `lifecycleScope` or `CoroutineScope(Dispatchers.IO)` — no `GlobalScope`
- No `Log.d`/`Log.v` in production — only `Log.i/w/e`

## JavaScript Rules
- `const` only — no `var`
- `async/await` only — no `.then()` chains
- `crypto.timingSafeEqual()` for all secret comparisons
- `logger.info/warn/error` — no `console.log`
- Validate input at top of handler — fail fast

## Import Order
### Kotlin: android.* → androidx.* → com.google.* → com.yourcompany.*
### JS: Node built-ins → firebase-* → local modules

## Git Conventions
- Conventional Commits: `feat(auth): add HMAC validation`
- Types: feat, fix, docs, style, refactor, test, chore, perf
- Branches: `feat/short-desc`, `fix/short-desc`, `hotfix/short-desc`
- Protected branches: `main`, `develop` — PR required

## Indentation
- Kotlin: 4 spaces
- JS: 2 spaces

# Hallucination Detection Checklist

**Purpose:** Detect fake completions, placeholder logic, hidden assumptions, untested code paths, and non-existent API usage before committing code.

## Code Completeness
- [ ] All `TODO()`, `FIXME`, `// TODO`, `// FIXME` markers have issue references
- [ ] No `throw NotImplementedError()` or `TODO("...")` stubs in committed code
- [ ] No placeholder implementations like `return null`, `return emptyList()`, `return mock()` in production code
- [ ] All function bodies are fully implemented — no skeleton logic
- [ ] No `// ... rest of the code` or `// similar for other cases` truncations

## API & Library Usage
- [ ] Firebase Admin SDK calls match actual API signatures (verify against Firebase docs)
- [ ] Firebase Functions v2 API used correctly (not conflating v1 and v2 patterns)
- [ ] `crypto.timingSafeEqual()` or `AuthCrypto.constantTimeEquals()` actually exists (not made up)
- [ ] Kotlin standard library calls verified against actual Kotlin docs
- [ ] React/Node.js imports resolve to packages declared in `package.json`
- [ ] No imaginary Firebase RTDB methods (e.g., `admin.database().ref().push().set()` chain verified)
- [ ] No imaginary Android SDK classes or methods

## Assumptions & Hidden Logic
- [ ] Bangladesh phone number format assumptions are explicit and documented
- [ ] `+880` normalization handles both `01X...` and `+8801X...` inputs
- [ ] SMS parsing logic accounts for carrier-specific formatting differences
- [ ] Timeout/TTL values are documented constants, not magic numbers
- [ ] Failure scenarios are not silently assumed away

## Untested Code Paths
- [ ] Every branch condition has a corresponding test case
- [ ] Error handling paths are tested (not just the happy path)
- [ ] Edge cases: duplicate SMS receipt, delayed delivery, malformed challenge tokens
- [ ] Concurrent write scenarios considered and tested
- [ ] Network failure paths handled in AuthenticatorService (Firebase auth retry, wakelock release)

## Verification Steps
- [ ] Code compiles without warnings (`./gradlew assembleDebug`)
- [ ] Linting passes (`./gradlew ktlintCheck`)
- [ ] Unit tests cover all new code paths
- [ ] Integration tests run against actual Firebase emulator (not mocked)
- [ ] Smoke test: run `firebase emulators:start` and verify function responses

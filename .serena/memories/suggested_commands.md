# Authenticator — Suggested Commands

## Android (from `authenticator-app/` directory)
```bash
# Build
./gradlew assembleDebug

# Unit tests
./gradlew test

# Coverage report
./gradlew jacocoTestReport

# ktlint format check
./gradlew ktlintCheck

# Android Lint
./gradlew lint

# Kotlin compile check
./gradlew compileDebugKotlin
```

## Cloud Functions (from `functions/` directory)
```bash
# Install dependencies
npm install

# Run tests
npm test

# ESLint
npm run lint

# Prettier check
npx prettier --check .
```

## Firebase Deployment (from project root)
```bash
# Deploy functions and database rules
firebase deploy --only functions,database

# Deploy only database rules
firebase deploy --only database

# Set secrets (must be done before first deploy)
firebase functions:secrets:set VERIFICATION_SIGNING_SECRET
firebase functions:secrets:set AUTHENTICATOR_ENROLLMENT_SECRET
firebase functions:secrets:set HEALTH_ADMIN_SECRET
firebase functions:secrets:set ACTIVE_DEDICATED_NUMBER

# Firebase emulators (local dev)
firebase emulators:start
```

## Pre-commit Checks (full suite)
```bash
cd authenticator-app && ./gradlew ktlintCheck && ./gradlew lint && ./gradlew test
cd ../functions && npm run lint && npm test
```

## Security Scan
```bash
git log --all --full-history -- '*.kt' '*.js' | grep -i "secret\|password"
```

## Health Check
```bash
curl -H "Authorization: Bearer $SECRET" $CF_URL/health
```

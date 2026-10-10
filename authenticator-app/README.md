# Gateway (authenticator-app)

The production Android **gateway** phone app: it receives verification/OTP
SMS, heartbeats to the dP Relay v5 server, and writes authenticator receipts
to the Firebase plane. It is a privileged device — it keeps runtime secrets
in EncryptedSharedPreferences (ADR-016: never `BuildConfig`) and signs its
writes with the device-plane credentials.

## Build / test

```bash
cd authenticator-app
./gradlew ktlintCheck           # ktlint (CI: ktlint)
./gradlew lintDebug             # Android lint (CI: android-lint)
./gradlew testDebugUnitTest     # JVM unit tests (CI: android-unit-tests)
./gradlew assembleDebug         # installable debug APK — needs NO env vars
```

Requires JDK 17 (`JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64`) and an
Android SDK.

### Release signing (STAGE F10, ISSUE-93) — fail-closed, keyring-backed

Release builds are signed with the **same private dP Relay release keystore
the payment reader uses** (PKCS12, RSA 4096, `CN=dP Relay`, alias
`dprelay-release`). The keystore file and its password live **only in the OS
keyring** (ADR-016: never the repo, never chat, never `BuildConfig`).

`assembleRelease` needs four env vars and **fails closed** if any is missing:
it never falls back to debug-signed or unsigned output. That matters here —
the debug keystore this used to point at has public credentials
(`android` / `androiddebugkey`), so anyone could produce an upgrade the phone
would accept as legitimate.

| Env var | Source (keyring, `service dprelay`) |
| --- | --- |
| `GATEWAY_RELEASE_STORE_FILE` | `account release-keystore-b64` (base64 PKCS12), decoded to a 0600 temp file |
| `GATEWAY_RELEASE_STORE_PASSWORD` | `account release-keystore-password` |
| `GATEWAY_RELEASE_KEY_ALIAS` | `account release-keystore-alias` (`dprelay-release`) |
| `GATEWAY_RELEASE_KEY_PASSWORD` | same value as the store password |

Building a signed release APK from the keyring (no secret ever touches a
tracked file):

```bash
cd authenticator-app
export KS="$(mktemp --suffix=.p12)"
chmod 600 "$KS"
secret-tool lookup service dprelay account release-keystore-b64 | base64 -d > "$KS"
export GATEWAY_RELEASE_STORE_FILE="$KS"
export GATEWAY_RELEASE_STORE_PASSWORD="$(secret-tool lookup service dprelay account release-keystore-password)"
export GATEWAY_RELEASE_KEY_ALIAS="$(secret-tool lookup service dprelay account release-keystore-alias)"
export GATEWAY_RELEASE_KEY_PASSWORD="$GATEWAY_RELEASE_STORE_PASSWORD"

./gradlew assembleRelease
apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
rm -f "$KS"
```

The keystore **alias is shared with the payment reader** (`dprelay-release`
on one keystore) — no separate `gateway` alias exists. Both apps therefore
carry the same certificate SHA-1, which is what gets registered on the
Firebase Android key.

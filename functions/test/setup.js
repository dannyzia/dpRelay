/**
 * Jest Global Setup — runs before each test suite.
 *
 * Initializes the Firebase Admin SDK pointed at the local emulator.
 * Set emulator environment variables if not already set (allows running
 * `npm test` without `firebase emulators:exec` for unit tests).
 *
 * NOTE: index.test.js uses jest.mock("firebase-admin") which overrides
 * the module for that test suite. This guard detects the mock and skips
 * real initialization, letting the mock handle everything.
 */

beforeAll(() => {
  // Set emulator hosts if not already set by `firebase emulators:exec`
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
  }
  if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
    process.env.FIREBASE_DATABASE_EMULATOR_HOST = "localhost:9000";
  }
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
  }

  // Skip real admin init when firebase-admin is mocked (e.g. index.test.js)
  // A mocked module won't have the .apps property from the real SDK.
  const admin = require("firebase-admin");
  if (typeof admin.apps === "undefined") {
    return;
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      projectId: "authenticator-15fb7",
      databaseURL:
        "https://authenticator-15fb7-default-rtdb.asia-southeast1.firebasedatabase.app",
    });
  }
});

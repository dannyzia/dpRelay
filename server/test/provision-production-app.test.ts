/**
 * Guards the production-app provisioning script's decision surface: which
 * appId it will register, and what actually lands in the keyring.
 *
 * The network half is a live production call and is not unit-tested, but both
 * things tested here have burned or nearly burned real credentials:
 *   - appIds are immutable once registered (UNIQUE, no delete route), so the
 *     argument that picks one must be validated before any request;
 *   - the provisioning route does NOT echo the caller-supplied appSecret, so a
 *     script that stores the raw response silently discards the one credential
 *     that cannot be recovered. buildCredentialsRecord exists to make that
 *     impossible, and this file pins it.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require_ = createRequire(import.meta.url);

type Provision = {
  APP_ID_PATTERN: RegExp;
  chooseAppId: (argv: string[]) => string;
  buildCredentialsRecord: (
    response: { appId?: string; name?: string; webhookUrl?: string | null; webhookSecret?: string },
    appSecret: string,
    registeredAt: string,
  ) => Record<string, unknown>;
};

const provision = require_(join(repoRoot, "server/scripts/provision-production-app.cjs")) as Provision;

const FAKE_APP_SECRET = "FAKE-app-secret-not-a-credential-0001";
const FAKE_WEBHOOK_SECRET = "FAKE-webhook-secret-not-a-credential-0002";

describe("chooseAppId", () => {
  it("defaults to dprelay-prod so the original invocation is unchanged", () => {
    expect(provision.chooseAppId([])).toBe("dprelay-prod");
    expect(provision.chooseAppId([""])).toBe("dprelay-prod");
  });

  it("accepts an explicit replacement appId", () => {
    expect(provision.chooseAppId(["dprelay-prod-3"])).toBe("dprelay-prod-3");
    expect(provision.chooseAppId(["app-1_X"])).toBe("app-1_X");
  });

  it("refuses a malformed appId before any request is made", () => {
    expect(() => provision.chooseAppId(["x"])).toThrow(/invalid appId/);
    expect(() => provision.chooseAppId(["bad id"])).toThrow(/invalid appId/);
    expect(() => provision.chooseAppId(["a".repeat(65)])).toThrow(/invalid appId/);
  });

  it("refuses a value outside the same pattern the server enforces", () => {
    for (const candidate of ["x", "bad id", "a".repeat(65), "äpp"]) {
      expect(provision.APP_ID_PATTERN.test(candidate), candidate).toBe(false);
      expect(() => provision.chooseAppId([candidate])).toThrow();
    }
  });
});

describe("buildCredentialsRecord", () => {
  const response = {
    appId: "dprelay-prod-3",
    name: "dP Relay Production",
    webhookUrl: null,
    webhookSecret: FAKE_WEBHOOK_SECRET,
  };

  it("includes the caller-supplied appSecret the server never returns", () => {
    // The regression: storing the raw register response drops appSecret, and
    // the credential is unrecoverable afterwards.
    const record = provision.buildCredentialsRecord(response, FAKE_APP_SECRET, "2026-10-04");
    expect(record.appSecret).toBe(FAKE_APP_SECRET);
  });

  it("keeps the stored shape stable for the keyring account", () => {
    const record = provision.buildCredentialsRecord(response, FAKE_APP_SECRET, "2026-10-04");
    expect(Object.keys(record).sort()).toEqual(
      ["appId", "appSecret", "name", "note", "registeredAt", "webhookSecret", "webhookUrl"].sort(),
    );
    expect(record.appId).toBe("dprelay-prod-3");
    expect(record.webhookSecret).toBe(FAKE_WEBHOOK_SECRET);
    expect(record.registeredAt).toBe("2026-10-04");
    expect(String(record.note)).toMatch(/appSecret is caller-supplied/);
  });

  it("normalizes a missing webhookUrl to null instead of undefined", () => {
    const record = provision.buildCredentialsRecord(
      { appId: "app", name: "n", webhookSecret: "w" },
      FAKE_APP_SECRET,
      "2026-10-04",
    );
    expect(record.webhookUrl).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(record, "webhookUrl")).toBe(true);
  });

  it("does not leak the register envelope's ok flag into the stored record", () => {
    const record = provision.buildCredentialsRecord(
      { ...response, ok: true } as typeof response & { ok: boolean },
      FAKE_APP_SECRET,
      "2026-10-04",
    );
    expect(record).not.toHaveProperty("ok");
  });

  it("round-trips through JSON with the appSecret intact", () => {
    const record = provision.buildCredentialsRecord(response, FAKE_APP_SECRET, "2026-10-04");
    const parsed = JSON.parse(JSON.stringify(record)) as { appSecret: string };
    expect(parsed.appSecret).toBe(FAKE_APP_SECRET);
  });
});

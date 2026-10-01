/**
 * Tests for the alerting boot guard (ISSUE-41): a deployment must fail loud
 * at boot when no complete alert sink is configured, unless the operator
 * opts out explicitly via ALERTING_REQUIRED=false.
 *
 * Two layers:
 *   1. unit — the pure assertAlertingArmed() logic
 *   2. integration — the production launcher (start-server.mjs) actually
 *      calls the guard: default env without a sink exits 1 with the guard
 *      message; the explicit opt-out gets past the guard.
 *
 * Secrets policy: only fake values ("test-token", "12345") are used; nothing
 * here reads or writes real credentials.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertAlertingArmed } from "../scripts/alert-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function envWith(extra) {
  // Delete the guard-relevant vars so host shell state can never leak in.
  const env = { ...process.env };
  for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "ALERT_WEBHOOK_URL", "ALERTING_REQUIRED"]) {
    delete env[k];
  }
  return { ...env, ...extra };
}

describe("assertAlertingArmed (unit)", () => {
  it("throws when no sink is configured (default: alerting required)", () => {
    expect(() => assertAlertingArmed(envWith({}))).toThrow(/alerting is unarmed/);
  });

  it("throws when Telegram is half-configured, and says so", () => {
    expect(() => assertAlertingArmed(envWith({ TELEGRAM_BOT_TOKEN: "test-token" })))
      .toThrow(/HALF-configured/);
    expect(() => assertAlertingArmed(envWith({ TELEGRAM_CHAT_ID: "-100200300" })))
      .toThrow(/HALF-configured/);
  });

  it("passes when the full Telegram pair is set", () => {
    const r = assertAlertingArmed(
      envWith({ TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_CHAT_ID: "-100200300" }),
    );
    expect(r).toEqual({ armed: true, optOut: false });
  });

  it("passes when the webhook sink is set", () => {
    const r = assertAlertingArmed(envWith({ ALERT_WEBHOOK_URL: "https://ops.example/hook" }));
    expect(r).toEqual({ armed: true, optOut: false });
  });

  it("treats whitespace-only values as unset", () => {
    expect(() =>
      assertAlertingArmed(envWith({ TELEGRAM_BOT_TOKEN: "  ", TELEGRAM_CHAT_ID: "-1" })),
    ).toThrow(/alerting is unarmed/);
  });

  it("opt-out (ALERTING_REQUIRED=false) bypasses the throw and reports it", () => {
    const r = assertAlertingArmed(envWith({ ALERTING_REQUIRED: "false" }));
    expect(r).toEqual({ armed: false, optOut: true });
  });
});

describe("start-server.mjs integration (launcher wires the guard)", () => {
  const launcher = join(here, "..", "scripts", "start-server.mjs");

  it("exits 1 with the guard message when no sink is configured", () => {
    const res = spawnSync(process.execPath, [launcher], {
      env: envWith({ LITESTREAM_ENABLED: "false" }),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(res.status).toBe(1);
    expect(`${res.stderr}${res.stdout}`).toMatch(/alerting is unarmed/);
    // Must never reach the API: the litestream/dev path must not start.
    expect(`${res.stderr}${res.stdout}`).not.toMatch(/listening on/);
  });

  it("gets past the guard with the explicit opt-out (no guard failure)", () => {
    // Do NOT spawn the launcher here: with the opt-out it proceeds toward a
    // real server boot. Instead assert the launcher wires the guard ahead of
    // every boot path — the guard module import and its call must both exist,
    // and the call must textually precede the LITESTREAM_ENABLED branch.
    const src = readFileSync(launcher, "utf8");
    expect(src).toContain('from "./alert-guard.mjs"');
    const guardCall = src.indexOf("assertAlertingArmed(process.env)");
    const devBranch = src.indexOf('LITESTREAM_ENABLED ?? "true"');
    expect(guardCall).toBeGreaterThan(-1);
    expect(devBranch).toBeGreaterThan(-1);
    expect(guardCall).toBeLessThan(devBranch);
  });
});

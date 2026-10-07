/**
 * rotate-fcm-key.cjs validation tests.
 *
 * Two distinct defects in the `apply` path are pinned here.
 *
 * 1. IDENTITY. The script has always documented that `apply` validates the
 *    candidate key "LOCALLY (parses, project matches, OAuth token mints, FCM
 *    endpoint accepts the auth header)". Only three of those four were
 *    implemented. "Project matches" was not, and it is the one that matters
 *    most: the FCM probe is aimed at the CANDIDATE's own `project_id`, so a key
 *    from a completely different Firebase project mints fine, authenticates
 *    fine, passes, and would then be written to Render — pointing production FCM
 *    at a project this service does not own, where every send fails silently.
 *
 * 2. SERIALISATION. `validateKey` built its OAuth token request as a
 *    URLSearchParams string and passed it to `request`'s `payload` option,
 *    which JSON-encodes whatever it is given. The bytes on the wire were
 *    therefore a quoted, escaped string while the header still claimed
 *    application/x-www-form-urlencoded. Parsed as form data, `grant_type` read
 *    as null and `assertion` kept a trailing quote, so Google answered 400 and
 *    EVERY key — valid or not — was reported "OAuth token mint rejected". The
 *    `apply` mode could never succeed. That failure is invisible to a static
 *    read and to the identity checks, so these tests pin the actual bytes by
 *    running the real validateKey against a stub transport.
 *
 * The script lives under gitignored staging/ and is an owner-local operational
 * tool, so it does not exist on a CI runner. These therefore SKIP when it is
 * absent rather than failing — the alternative would be a permanently red suite
 * for a file the runner cannot have.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = join(repoRoot, "staging", "rotate-fcm-key.cjs");
const scriptExists = existsSync(scriptPath);

type Identity = { projectId?: string; keyId?: string; clientEmail?: string };
type Assert = (candidate: Identity, liveJson: string | null) => void;

type Mode = "code" | "template" | "line" | "block" | "sq" | "dq";

/**
 * Extracts the source of a top-level `function name(...) { ... }`.
 *
 * This is a real scanner, not a brace counter, and both simpler versions were
 * wrong in ways that looked like "the extraction is broken" rather than "the
 * scanner is wrong":
 *
 *   - counting every `{` from the signature closes the function on the first
 *     `}` of a destructured parameter list (`{ method = "GET", ... }`), or on a
 *     `}` inside a template literal;
 *   - treating `${ ... }` as an ordinary brace pair loses track of whether the
 *     closing `}` returns to a template or to the function body.
 *
 * So: skip the parameter list by paren matching first, then count braces for
 * the body only, with a mode stack for strings, both comment forms, and
 * template literals.
 */
function srcOf(source: string, name: string): string {
  // The optional `async ` is part of what gets extracted. Matching on a bare
  // `function ${name}(` finds the keyword and slices from there, which turns an
  // `async function` into a non-async one — and the extracted source then fails
  // to parse on its own `await`, which reads as a broken extractor rather than
  // a dropped prefix.
  const decl = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  expect(decl, `${name} not found in rotate-fcm-key.cjs`).not.toBeNull();
  const start = decl!.index;

  const modes: Mode[] = ["code"];
  let parens = 0;
  let depth = 0;
  let paramsClosed = false;

  for (let i = start; i < source.length; i++) {
    const c = source[i];
    const two = source.slice(i, i + 2);
    const mode = modes[modes.length - 1];

    if (mode === "line") {
      if (c === "\n") modes.pop();
      continue;
    }
    if (mode === "block") {
      if (two === "*/") {
        modes.pop();
        i++;
      }
      continue;
    }
    if (mode === "sq" || mode === "dq") {
      if (c === "\\") i++;
      else if ((mode === "sq" && c === "'") || (mode === "dq" && c === '"')) modes.pop();
      continue;
    }
    if (mode === "template") {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === "`") {
        modes.pop();
        continue;
      }
      if (two === "${") {
        modes.push("code");
        depth++;
        i++;
      }
      continue;
    }

    // code
    if (two === "//") {
      modes.push("line");
      i++;
      continue;
    }
    if (two === "/*") {
      modes.push("block");
      i++;
      continue;
    }
    if (c === "'") {
      modes.push("sq");
      continue;
    }
    if (c === '"') {
      modes.push("dq");
      continue;
    }
    if (c === "`") {
      modes.push("template");
      continue;
    }
    if (c === "(") {
      parens++;
      continue;
    }
    if (c === ")") {
      parens--;
      if (parens === 0) paramsClosed = true;
      continue;
    }
    // Braces before the parameter list closes belong to a destructured default,
    // not to the body.
    if (!paramsClosed) continue;
    if (c === "{") {
      depth++;
      continue;
    }
    if (c === "}") {
      if (modes.length > 1) {
        modes.pop();
        depth--;
        continue;
      }
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`could not find the end of function ${name} — unbalanced braces or quotes`);
}

function load(): { keyIdentity: (s: string) => Identity; assertRotatable: Assert } {
  const source = readFileSync(scriptPath, "utf8");
  // A bare `new Function(src)()` declares the function but returns undefined, so
  // the return has to be appended explicitly.
  const keyIdentity = new Function(`${srcOf(source, "keyIdentity")}; return keyIdentity;`)() as (
    s: string,
  ) => Identity;
  // assertRotatable closes over keyIdentity, so bind it into scope.
  const assertRotatable = new Function(
    "keyIdentity",
    `${srcOf(source, "assertRotatable")}; return assertRotatable;`,
  )(keyIdentity) as Assert;
  return { keyIdentity, assertRotatable };
}

const LIVE_PROJECT = "authenticator-15fb7";
const LIVE_KEY_ID = "live-key-id-1";
const liveKey = (project = LIVE_PROJECT, id = LIVE_KEY_ID): string =>
  JSON.stringify({
    project_id: project,
    private_key_id: id,
    client_email: `svc@${project}.iam.gserviceaccount.com`,
  });

describe.skipIf(!scriptExists)("rotate-fcm-key.cjs rejects a key that is not a rotation", () => {
  it("rejects a key from a different Firebase project", () => {
    const { keyIdentity, assertRotatable } = load();
    const candidate = keyIdentity(liveKey("some-other-project", "other-id"));
    expect(() => assertRotatable(candidate, liveKey())).toThrow(/wrong project/i);
  });

  it("rejects the key already on Render, which is not a rotation", () => {
    const { keyIdentity, assertRotatable } = load();
    const candidate = keyIdentity(liveKey(LIVE_PROJECT, LIVE_KEY_ID));
    expect(() => assertRotatable(candidate, liveKey())).toThrow(/not a rotation/i);
  });

  it("rejects a file missing the identity fields the checks depend on", () => {
    const { assertRotatable } = load();
    // Without this, a key file with no private_key_id would pass the "same key"
    // check vacuously and sail through to the network steps.
    expect(() => assertRotatable({ projectId: "p", clientEmail: "e" }, liveKey())).toThrow(
      /missing project_id/,
    );
  });

  it("accepts a genuine rotation of the same project", () => {
    const { keyIdentity, assertRotatable } = load();
    const candidate = keyIdentity(liveKey(LIVE_PROJECT, "a-brand-new-key-id"));
    expect(() => assertRotatable(candidate, liveKey())).not.toThrow();
  });

  it("allows the apply when Render holds no FCM key, rather than skipping silently", () => {
    const { keyIdentity, assertRotatable } = load();
    const candidate = keyIdentity(liveKey("any-project", "any-id"));
    expect(() => assertRotatable(candidate, null)).not.toThrow();
  });

  it("runs the identity checks before validateKey, so a bad key costs no network call", () => {
    const source = readFileSync(scriptPath, "utf8");
    const applyBody = source.slice(source.indexOf('} else if (mode === "apply")'));
    const assertAt = applyBody.indexOf("assertRotatable(");
    const validateAt = applyBody.indexOf("validateKey(");
    expect(assertAt).toBeGreaterThan(-1);
    expect(validateAt).toBeGreaterThan(-1);
    // Ordering is the behaviour: OAuth mint and the FCM probe are both network
    // calls, and a wrong-project key must be rejected without either.
    expect(assertAt).toBeLessThan(validateAt);
  });
});

type Captured = { url: string; opts: Record<string, unknown> };

describe.skipIf(!scriptExists)("rotate-fcm-key.cjs sends the OAuth token request form-encoded", () => {
  /**
   * Runs the real validateKey with `request` and `mintJwt` bound to stubs, so
   * the exact options object each call receives can be inspected.
   *
   * Both are closed over by validateKey, so they are injected into scope — the
   * same technique load() uses for assertRotatable's keyIdentity.
   */
  async function captureCalls(opts: { tokenStatus?: number; fcmStatus?: number } = {}): Promise<Captured[]> {
    const source = readFileSync(scriptPath, "utf8");
    const calls: Captured[] = [];
    const requestStub = async (url: string, o: Record<string, unknown>) => {
      calls.push({ url, opts: o });
      const status = String(url).includes("oauth2.googleapis.com") ? (opts.tokenStatus ?? 200) : (opts.fcmStatus ?? 400);
      return {
        status,
        parsed: String(url).includes("oauth2.googleapis.com")
          ? status === 200
            ? { access_token: "stub-access-token" }
            : { error: "invalid_request" }
          : { error: "stub" },
        headers: {},
      };
    };
    const validateKey = new Function(
      "request",
      "mintJwt",
      "keyIdentity",
      "console",
      `${srcOf(source, "validateKey")}; return validateKey;`,
    )(
      requestStub,
      async () => "stub-jwt",
      // validateKey closes over three things, not two. Omitting keyIdentity
      // makes every call fail with "keyIdentity is not defined" before it ever
      // reaches the transport, which is a stubbing mistake masquerading as a
      // serialisation failure.
      (j: string) => {
        const p = JSON.parse(j);
        return { projectId: p.project_id, keyId: p.private_key_id, clientEmail: p.client_email };
      },
      { log() {} },
    ) as (j: string) => Promise<unknown>;
    await validateKey(
      JSON.stringify({
        project_id: LIVE_PROJECT,
        private_key_id: "candidate-id",
        client_email: `svc@${LIVE_PROJECT}.iam.gserviceaccount.com`,
        private_key: "unused-because-mintJwt-is-stubbed",
      }),
    );
    return calls;
  }

  const tokenCall = async (opts?: { tokenStatus?: number }): Promise<Record<string, unknown>> => {
    const calls = await captureCalls(opts);
    const found = calls.find((c) => c.url.includes("oauth2.googleapis.com"));
    expect(found, "validateKey never called the OAuth token endpoint").toBeDefined();
    return found!.opts;
  };

  it("passes the form body via `body`, not `payload`", async () => {
    // The whole regression in one assertion: handing this to `payload` is what
    // made request() JSON-encode an already-form-encoded string.
    const opts = await tokenCall();
    expect(opts.body).toBeTypeOf("string");
    expect(opts.payload).toBeUndefined();
  });

  it("sends a body a form parser can actually read", async () => {
    // The real damage of the bug: JSON-wrapped, the encoded string parsed back
    // with grant_type null and a stray quote on assertion.
    const opts = await tokenCall();
    const parsed = new URLSearchParams(opts.body as string);
    expect(parsed.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(parsed.get("assertion")).toBe("stub-jwt");
    expect(opts.body as string).not.toMatch(/^"|"$/);
  });

  it("declares the form content type on the token request", async () => {
    const opts = await tokenCall();
    expect((opts.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  it("still JSON-encodes the FCM probe, which really is JSON", async () => {
    // The fix must not have broken the other call in the same function.
    const calls = await captureCalls();
    const fcm = calls.find((c) => c.url.includes("fcm.googleapis.com"));
    expect(fcm).toBeDefined();
    expect(fcm!.opts.payload).toEqual({ message: {} });
    expect(fcm!.opts.body).toBeUndefined();
  });

  it("accepts a valid key end to end instead of rejecting every key", async () => {
    // Before the fix this threw "OAuth token mint rejected" for every input.
    await expect(captureCalls()).resolves.toHaveLength(2);
  });

  it("still rejects when Google says the mint failed, naming the status", async () => {
    await expect(captureCalls({ tokenStatus: 400 })).rejects.toThrow(
      /OAuth token mint rejected \(HTTP 400\)/,
    );
  });

  it("refuses to send payload and body together", () => {
    // Otherwise a future caller can silently reintroduce the ambiguity. The
    // guard runs before the Promise is constructed, so it THROWS rather than
    // rejecting — asserting `.rejects` here would fail against correct code.
    const source = readFileSync(scriptPath, "utf8");
    const request = new Function("https", `${srcOf(source, "request")}; return request;`)({
      request() {
        throw new Error("must not reach the transport");
      },
    }) as (u: string, o: Record<string, unknown>) => Promise<unknown>;
    expect(() => request("https://example.test", { payload: { a: 1 }, body: "a=1" })).toThrow(
      /not both/,
    );
  });
});
type Wire = { url: string; options: Record<string, unknown>; written: string };

/**
 * Pins what `request` actually puts on the wire.
 *
 * The tests above only inspect the options object validateKey HANDS to request.
 * That leaves request's own body-building completely uncovered — two mutations
 * proved it: reverting it to `JSON.stringify(payload)` (dropping the `body`
 * channel so the token POST carries no body at all), and defaulting a raw
 * body's Content-Type to application/json, which no test noticed because the
 * one caller that exists sets the header explicitly and therefore overrides the
 * default anyway. Both are latent, and both would fire on the next caller.
 */
describe.skipIf(!scriptExists)("rotate-fcm-key.cjs request() builds the wire format", () => {
  /** A stand-in for node:https that records the call instead of making it. */
  function httpsStub(wire: Wire[]) {
    return {
      request(url: string, options: Record<string, unknown>, cb: (res: unknown) => void) {
        const rec: Wire = { url, options, written: "" };
        wire.push(rec);
        const req = {
          on() {
            return req;
          },
          write(chunk: string) {
            rec.written += chunk;
          },
          end() {
            setImmediate(() =>
              cb({
                statusCode: 200,
                headers: {},
                on(event: string, handler: (c?: string) => void) {
                  if (event === "data") handler('{"access_token":"x"}');
                  if (event === "end") handler();
                  return this;
                },
              }),
            );
          },
        };
        return req;
      },
    };
  }

  /** The real `request`, bound to a stub that records into `wire`. */
  function loadRequest(wire: Wire[] = []): (u: string, o: Record<string, unknown>) => Promise<unknown> {
    const source = readFileSync(scriptPath, "utf8");
    // `request` closes over REQUEST_TIMEOUT_MS for its per-request ceiling, and
    // this harness evaluates the extracted source on its own, so module scope
    // has to be supplied explicitly. The value is passed rather than read from
    // the file so the stub cannot drift from the constant it is standing in for.
    const timeoutMs = Number(/const REQUEST_TIMEOUT_MS = ([\d_]+);/.exec(source)?.[1].replace(/_/g, ""));
    expect(Number.isFinite(timeoutMs), "REQUEST_TIMEOUT_MS not found in rotate-fcm-key.cjs").toBe(true);
    return new Function("https", "REQUEST_TIMEOUT_MS", `${srcOf(source, "request")}; return request;`)(
      httpsStub(wire),
      timeoutMs,
    ) as (u: string, o: Record<string, unknown>) => Promise<unknown>;
  }

  it("sends a raw body byte-for-byte, with no JSON wrapper", async () => {
    const wire: Wire[] = [];
    const request = loadRequest(wire);
    const form = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=abc.def.ghi";
    await request("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: form,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(wire).toHaveLength(1);
    expect(wire[0].written).toBe(form);
    expect(new URLSearchParams(wire[0].written).get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    expect(wire[0].options.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(form),
    });
  });

  it("does NOT label a raw body as JSON when the caller sets no Content-Type", async () => {
    // The caller's header is why this stayed hidden: the one existing caller
    // always sets it, so the bad default never showed. A future caller would.
    const wire: Wire[] = [];
    const request = loadRequest(wire);
    await request("https://example.test/x", { method: "POST", body: "raw=1" });
    expect((wire[0].options.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect(wire[0].written).toBe("raw=1");
  });

  it("JSON-encodes a payload object and defaults its Content-Type", async () => {
    const wire: Wire[] = [];
    const request = loadRequest(wire);
    await request("https://fcm.googleapis.com/v1/projects/p/messages:send", {
      method: "POST",
      payload: { message: {} },
    });
    expect(wire[0].written).toBe('{"message":{}}');
    expect((wire[0].options.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("sends no body and no Content-Length on a bare GET", async () => {
    const wire: Wire[] = [];
    const request = loadRequest(wire);
    await request("https://api.render.com/v1/services", {});
    expect(wire[0].written).toBe("");
    const headers = wire[0].options.headers as Record<string, unknown>;
    expect(headers["Content-Length"]).toBeUndefined();
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("still resolves a parsed body on the way back", async () => {
    const request = loadRequest();
    const res = (await request("https://example.test", {})) as { status: number; parsed: unknown };
    expect(res.status).toBe(200);
    expect(res.parsed).toEqual({ access_token: "x" });
  });
});

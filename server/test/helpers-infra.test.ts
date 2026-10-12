/**
 * Unit tests for the shared test helpers (hub ISSUE-101): helpers/net.ts
 * (startSink / closedPort) and helpers/mailbox.ts (startMailbox).
 *
 * These helpers decide the semantics every dispatch/alert test relies on —
 * status sequencing, stray-request scoping (ISSUE-92), deterministic port
 * release, SMTP capture, and the disk quota — so they get direct coverage
 * instead of being trusted implicitly by the suites that use them.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import http from "node:http";
import nodemailer from "nodemailer";
import { closedPort, startSink } from "./helpers/net.js";
import { startMailbox, type Mailbox } from "./helpers/mailbox.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

/** Minimal SMTP client matching what mailer.ts drives (plaintext, AUTH PLAIN). */
function smtpClient(port: number): ReturnType<typeof nodemailer.createTransport> {
  return nodemailer.createTransport({
    host: "127.0.0.1",
    port,
    secure: false,
    auth: { user: "mailer-user", pass: "mailer-pass" },
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 5_000,
  });
}

describe("helpers/net.ts — startSink", () => {
  it("answers with each status in sequence and repeats the last one", async () => {
    const sink = await startSink({ statusSequence: [500, 503] });
    cleanups.push(sink.close);

    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(sink.url, { method: "POST", body: `b${i}` });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([500, 503, 503]);
    expect(sink.requests.map((r) => r.rawBody)).toEqual(["b0", "b1", "b2"]);
    expect(sink.requests[0].method).toBe("POST");
  });

  it("captures headers and appends the configured path to the URL", async () => {
    const sink = await startSink({ path: "/otp-status" });
    cleanups.push(sink.close);
    expect(sink.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/otp-status$/);

    await fetch(sink.url, { method: "POST", headers: { "x-dp-signature": "sig-123" }, body: "payload" });
    expect(sink.requests[0].path).toBe("/otp-status");
    expect(sink.requests[0].headers["x-dp-signature"]).toBe("sig-123");
    expect(sink.requests[0].rawBody).toBe("payload");
  });

  it("does not record or answer a request the record filter rejects (ISSUE-92)", async () => {
    const sink = await startSink({ record: ({ path }) => path.startsWith("/mine") });
    cleanups.push(sink.close);

    // A stray (another worker's recycled-port traffic) must see a transport
    // error, not a response — and must never appear in `requests`.
    const stray = await fetch(`${sink.url}/theirs`, {
      method: "POST",
      body: "stray",
      signal: AbortSignal.timeout(2_000),
    }).then(
      () => "answered",
      () => "transport-error",
    );
    expect(stray).toBe("transport-error");
    expect(sink.requests).toEqual([]);

    // Positive control: the owned path still records and answers.
    const owned = await fetch(`${sink.url}/mine`, { method: "POST", body: "own" });
    expect(owned.status).toBe(200);
    expect(sink.requests).toHaveLength(1);
    expect(sink.requests[0].path).toBe("/mine");
  });

  it("releases its port immediately on close, despite keep-alive", async () => {
    const sink = await startSink({});
    const { port } = sink;
    // Keep the connection alive so an unforced close would hold the port.
    await fetch(sink.url, { headers: { connection: "keep-alive" } });
    await sink.close();

    // The port is free: a new listener can bind it, and connections are refused.
    const rebinder = http.createServer();
    await new Promise<void>((resolve) => rebinder.listen(port, "127.0.0.1", resolve));
    await new Promise((resolve) => rebinder.close(resolve));
    const refused = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(2_000),
    }).then(
      () => false,
      () => true,
    );
    expect(refused).toBe(true);
  });

  it("custom respond replaces the status responder", async () => {
    const sink = await startSink({
      respond: (req, res) => {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ saw: req.rawBody }));
      },
    });
    cleanups.push(sink.close);

    const res = await fetch(sink.url, { method: "PUT", body: "hello" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ saw: "hello" });
  });
});

describe("helpers/net.ts — closedPort", () => {
  it("returns a loopback port that actively refuses connections", async () => {
    const port = await closedPort();
    const refused = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) }).then(
      () => false,
      (err: unknown) => err instanceof Error,
    );
    expect(refused).toBe(true);
  });

  it("returns distinct ports on successive calls", async () => {
    // Not a hard guarantee of the kernel, but two bind(0)+close cycles in
    // immediate succession do not collide in practice; if this ever fails it
    // signals the helper's contract changed.
    const [a, b] = await Promise.all([closedPort(), closedPort()]);
    expect(a).not.toBe(b);
  });
});

describe("helpers/mailbox.ts — startMailbox", () => {
  it("captures envelope, wire credentials, and the full MIME source", async () => {
    const mailbox = await startMailbox();
    cleanups.push(mailbox.close);

    const client = smtpClient(mailbox.port);
    await client.sendMail({
      from: "sender@example.test",
      to: "rcpt1@example.test, rcpt2@example.test",
      subject: "Hello mailbox",
      text: "the body",
    });
    client.close();

    expect(mailbox.messages).toHaveLength(1);
    const mail = mailbox.messages[0];
    expect(mail.from).toBe("sender@example.test");
    expect(mail.to).toEqual(["rcpt1@example.test", "rcpt2@example.test"]);
    expect(mail.authUser).toBe("mailer-user");
    expect(mail.authPass).toBe("mailer-pass");
    expect(mail.subject).toBe("Hello mailbox");
    expect(mail.raw).toContain("the body");
    expect(mail.raw).toMatch(/^From: /m);
    expect(mail.raw).toMatch(/^Subject: /m);
  });

  it("spools each message to disk under the tmp root", async () => {
    const mailbox = await startMailbox();
    cleanups.push(mailbox.close);

    const client = smtpClient(mailbox.port);
    await client.sendMail({ from: "a@b.test", to: "c@d.test", subject: "disk", text: "on disk" });
    client.close();

    const mail = mailbox.messages[0];
    expect(mail.file).not.toBeNull();
    expect(mail.file!.startsWith(mailbox.spoolDir)).toBe(true);
    expect(readFileSync(mail.file!, "utf8")).toBe(mail.raw);
  });

  it("rejects messages over the disk quota with 552 and records the rejection", async () => {
    // Tiny quota: the first (small) message fits, the second (large) does not.
    const mailbox = await startMailbox({ quotaBytes: 2_000 });
    cleanups.push(sinkClose(mailbox));

    const client = smtpClient(mailbox.port);
    await client.sendMail({ from: "a@b.test", to: "c@d.test", subject: "small", text: "tiny" });

    const bigText = "x".repeat(5_000);
    const rejected = await client
      .sendMail({ from: "a@b.test", to: "c@d.test", subject: "big", text: bigText })
      .then(() => "accepted")
      // Nodemailer surfaces the 552 as a ServerError with responseCode 552.
      .catch((err: { responseCode?: number }) => `rejected-${err.responseCode ?? "unknown"}`);
    client.close();

    expect(rejected).toBe("rejected-552");
    expect(mailbox.messages).toHaveLength(1);
    expect(mailbox.messages[0].subject).toBe("small");
    expect(mailbox.rejectedForQuota).toBe(1);
  });

  it("close() destroys live connections and releases the port", async () => {
    const mailbox = await startMailbox();
    // Open a connection and abandon it mid-session (an abruptly-killed client).
    const raw = await import("node:net");
    const zombie = raw.createConnection(mailbox.port, "127.0.0.1");
    // The close below destroys this socket mid-session; absorb the ensuing
    // ECONNRESET so it surfaces as neither an unhandled error nor a test
    // failure — the point of the test is that the SERVER survives it.
    zombie.on("error", () => undefined);
    await new Promise((resolve) => zombie.once("data", resolve));
    zombie.write("EHLO linger\r\n");

    await mailbox.close();
    const refused = await fetch(`http://127.0.0.1:${mailbox.port}/`, { signal: AbortSignal.timeout(2_000) }).then(
      () => false,
      () => true,
    );
    expect(refused).toBe(true);
    zombie.destroy();
  });
});

/** Alias so the quota test reads cleanly while registering cleanup. */
function sinkClose(mailbox: Mailbox): () => Promise<void> {
  return mailbox.close;
}

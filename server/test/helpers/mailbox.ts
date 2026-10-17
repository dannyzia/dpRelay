/**
 * Ephemeral in-process SMTP mailbox for auth-email integration tests
 * (hub ISSUE-101).
 *
 * Why this exists: `test/auth-email.test.ts` captures `sendMail` with a
 * module mock, which proves the route logic but never exercises the real
 * transport path — `mail_config` loading, password decryption, nodemailer's
 * SMTP session, and the actual MIME that lands in a mailbox. This helper is a
 * minimal RFC 5321 server good enough for nodemailer's default pipeline
 * (verified against the vendored nodemailer: EHLO → AUTH PLAIN → MAIL FROM →
 * RCPT TO → DATA → QUIT over plaintext; nodemailer only attempts STARTTLS
 * when the server ADVERTISES it, so we deliberately never do).
 *
 * Fidelity choices, all deliberate:
 * - AUTH always succeeds with 235: credentials are seeded by the test, and
 *   the point of the suite is the flow, not the ACL. The username/password
 *   seen on the wire are still recorded so a test can assert the decrypted
 *   secret that arrived matches what `mail_config` was seeded with.
 * - Each accepted message is spooled as a raw `.eml` file under a per-test
 *   tmp root (tracked for removal by ./tmp-dirs.js) up to a configurable byte
 *   quota; exceeding the quota rejects the DATA with 552 and records nothing,
 *   so a runaway send cannot fill the disk the way the untracked tmp dirs did
 *   in ISSUE-50.
 * - Teardown is deterministic: `close()` destroys every open socket, closes
 *   the listener, and resolves only after the port is released — no
 *   keep-alive timeout can leak a bind into another test (ISSUE-92).
 */
import net from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { testTmpDir } from "./tmp-dirs.js";

/** One accepted message: envelope, wire credentials, and full MIME source. */
export interface CapturedMail {
  /** Envelope sender (MAIL FROM), angle-brackets stripped. */
  from: string;
  /** Envelope recipients (RCPT TO), angle-brackets stripped. */
  to: string[];
  /** AUTH PLAIN credentials seen on the wire (empty when unauthenticated). */
  authUser: string;
  authPass: string;
  /** Full raw MIME source as delivered in the DATA transaction. */
  raw: string;
  /** Subject header, RFC 2047 words left encoded (assert on `raw` for exactness). */
  subject: string;
  /** Spooled file path, or null when the quota rejected the message. */
  file: string | null;
}

export interface Mailbox {
  port: number;
  /** Every accepted message, oldest first. Live array — assert on it directly. */
  messages: CapturedMail[];
  /** Messages rejected for exceeding the disk quota. */
  rejectedForQuota: number;
  /** Directory the .eml spool files are written into. */
  spoolDir: string;
  /** Closes the listener, destroys all sockets, resolves when the port is released. */
  close: () => Promise<void>;
}

export interface MailboxOptions {
  /** Per-test spool root. Default: a fresh tracked tmp dir (auto-removed). */
  tmpRoot?: string;
  /** Max TOTAL spooled bytes before further messages are rejected with 552. */
  quotaBytes?: number;
}

/** Splits an SMTP path argument into its address, dropping source routes/brackets. */
function parsePath(arg: string): string {
  const match = /<([^>]*)>/.exec(arg);
  return match ? match[1] : arg.trim();
}

/** First occurrence of a header in a MIME source, unfolded; "" when absent. */
function header(raw: string, name: string): string {
  const match = new RegExp(`^${name}:\\s*([\\s\\S]*?)\\r?\\n(?!\\s)`, "im").exec(raw);
  return (match ? match[1] : "").replace(/\r?\n\s+/g, " ").trim();
}

/**
 * Starts an in-process SMTP mailbox on 127.0.0.1 with an ephemeral port.
 *
 * @param options spool root and disk quota — see {@link MailboxOptions}.
 * @returns the live mailbox; the caller owns it and must `close()` it.
 */
export async function startMailbox(options: MailboxOptions = {}): Promise<Mailbox> {
  const spoolDir = options.tmpRoot ?? testTmpDir("dprelay-mailbox-");
  const quotaBytes = options.quotaBytes ?? 1024 * 1024;
  const messages: CapturedMail[] = [];
  let rejectedForQuota = 0;
  let spooledBytes = 0;
  let spoolSeq = 0;

  const sockets = new Set<net.Socket>();

  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));

    let inData = false;
    let buf = "";
    // Per-transaction state (reset by RSET / new MAIL FROM).
    let from = "";
    let to: string[] = [];
    let authUser = "";
    let authPass = "";
    let data = "";
    // Multi-step AUTH LOGIN exchange: the next two bare lines are the
    // base64 username and password, not commands.
    let authStage: "none" | "login-user" | "login-pass" = "none";

    const reply = (line: string): void => {
      sock.write(`${line}\r\n`);
    };

    sock.write("220 localhost test-mailbox\r\n");

    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          // Dot-unescaping happens at the end of the transaction; here we only
          // hunt for the terminating CRLF.CRLF sequence.
          const end = buf.indexOf("\r\n.\r\n");
          if (end === -1) return;
          data += buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;

          const raw = data
            .split("\r\n")
            .map((line) => (line.startsWith("..") ? line.slice(1) : line))
            .join("\r\n");
          data = "";

          const bytes = Buffer.byteLength(raw, "utf8");
          if (spooledBytes + bytes > quotaBytes) {
            // Out of disk budget: reject like a real server with a full
            // spool (552), and record the rejection instead of the message.
            rejectedForQuota += 1;
            reply("552 5.3.4 Message size exceeds fixed maximum message size");
            continue;
          }
          spooledBytes += bytes;
          spoolSeq += 1;
          const file = join(spoolDir, `msg-${spoolSeq}.eml`);
          writeFileSync(file, raw, "utf8");
          messages.push({
            from,
            to: [...to],
            authUser,
            authPass,
            raw,
            subject: header(raw, "Subject"),
            file,
          });
          from = "";
          to = [];
          reply("250 2.0.0 Ok: queued");
          continue;
        }

        const idx = buf.indexOf("\r\n");
        if (idx === -1) return;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const up = line.toUpperCase();

        // Continuation lines of a multi-step AUTH LOGIN: consume before any
        // command parsing so a credential can never be read as a verb.
        if (authStage === "login-user") {
          authUser = Buffer.from(line.trim(), "base64").toString("utf8");
          authStage = "login-pass";
          reply("334 UGFzc3dvcmQ6");
          continue;
        }
        if (authStage === "login-pass") {
          authPass = Buffer.from(line.trim(), "base64").toString("utf8");
          authStage = "none";
          reply("235 2.7.0 Accepted");
          continue;
        }

        if (up.startsWith("EHLO")) {
          // Deliberately NO STARTTLS advertisement: nodemailer upgrades when
          // offered, and we have no certificate — plaintext is the point.
          reply("250-localhost");
          reply("250-8BITMIME");
          reply("250-AUTH PLAIN LOGIN");
          reply("250 SIZE 10485760");
        } else if (up.startsWith("HELO")) {
          reply("250 localhost");
        } else if (up.startsWith("AUTH PLAIN")) {
          // Nodemailer sends the initial response inline (AUTH PLAIN <b64>).
          const b64 = line.split(/\s+/)[2] ?? "";
          if (b64 === "") {
            reply("334 "); // challenge for the bare-line form (unused by nodemailer)
            authStage = "login-user";
            continue;
          }
          const decoded = Buffer.from(b64, "base64").toString("utf8").split("\0");
          authUser = decoded[1] ?? "";
          authPass = decoded[2] ?? "";
          reply("235 2.7.0 Accepted");
        } else if (up.startsWith("AUTH LOGIN")) {
          authStage = "login-user";
          reply("334 VXNlcm5hbWU6");
        } else if (up.startsWith("MAIL FROM")) {
          from = parsePath(line.slice("MAIL FROM:".length));
          to = [];
          reply("250 2.1.0 Ok");
        } else if (up.startsWith("RCPT TO")) {
          to.push(parsePath(line.slice("RCPT TO:".length)));
          reply("250 2.1.5 Ok");
        } else if (up === "DATA") {
          inData = true;
          data = "";
          reply("354 End data with <CR><LF>.<CR><LF>");
        } else if (up.startsWith("RSET")) {
          from = "";
          to = [];
          data = "";
          inData = false;
          reply("250 2.0.0 Ok");
        } else if (up.startsWith("NOOP")) {
          reply("250 2.0.0 Ok");
        } else if (up.startsWith("QUIT")) {
          reply("221 2.0.0 Bye");
          sock.end();
        } else {
          reply("502 5.5.2 Command not implemented");
        }
      }
    });

    sock.on("error", () => {
      // A client reset mid-session (test teardown) is expected, not a failure.
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    messages,
    get rejectedForQuota() {
      return rejectedForQuota;
    },
    spoolDir,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

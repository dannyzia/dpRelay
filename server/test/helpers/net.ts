/**
 * Shared loopback-network helpers for the server test suite (hub ISSUE-101).
 *
 * Why this exists: four test files each grew their own copy of the same two
 * primitives — an ephemeral-port HTTP mock that records requests and answers
 * with a scripted status, and a "find a port nothing is listening on" probe
 * for deterministic connection-refused targets. The copies drifted (one
 * recorded every stray request and became the cross-worker flake recorded in
 * ISSUE-92, another never force-dropped keep-alive sockets), so the semantics
 * that made ISSUE-92 flaky are now decided ONCE, here:
 *
 * - Recording is opt-in per path (`record`): a request that is not recorded is
 *   NOT answered either — its socket is destroyed. Vitest runs workers in
 *   parallel and ephemeral ports are recycled, so a lingering retry from
 *   another worker can land on this mock; answering it (even 404) would fail
 *   THAT worker's closed-port assertions, and recording it would poison this
 *   worker's `requests == []` assertions.
 * - `close()` force-drops every connection (`closeAllConnections`) so the
 *   listener and its port are released the instant teardown runs, instead of
 *   waiting out Node's keep-alive timeout — a bind held past teardown is what
 *   enables the next collision.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

/** One recorded request: method, path, all headers, and the raw body. */
export interface SinkRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  rawBody: string;
}

export interface Sink {
  /** Base URL, including the configured `path` (e.g. `http://127.0.0.1:34567/otp-status`). */
  url: string;
  port: number;
  /** Requests that passed the `record` filter, oldest first. Live array — assert on it directly. */
  requests: SinkRequest[];
  /** Closes the listener AND destroys all open sockets; resolves when the port is released. */
  close: () => Promise<void>;
}

export interface SinkOptions {
  /**
   * Statuses answered in order; the last value repeats for all further
   * requests. Read per-request, so a test may mutate the array mid-flight to
   * bring a "dead" receiver back to life. Default `[200]`.
   */
  statusSequence?: number[];
  /** Path appended to the base URL (the URL returned in `url`). Default `""`. */
  path?: string;
  /**
   * Decides whether a request is recorded AND answered. Default: record all.
   * Non-recorded requests get their socket destroyed (see file header).
   */
  record?: (req: { method: string; path: string }) => boolean;
  /**
   * Full custom responder, called AFTER the body is fully read and recorded.
   * When present it replaces the statusSequence responder entirely.
   */
  respond?: (req: SinkRequest, res: http.ServerResponse) => void;
}

/**
 * Starts an ephemeral-loopback HTTP sink on 127.0.0.1.
 *
 * @param options see {@link SinkOptions}; defaults record everything and answer 200.
 * @returns the live sink; the caller owns it and must `close()` it (register it
 *          in the test's cleanup list).
 */
export async function startSink(options: SinkOptions = {}): Promise<Sink> {
  const statusSequence = options.statusSequence ?? [200];
  const record = options.record ?? (() => true);
  const requests: SinkRequest[] = [];
  let call = 0;

  const server = http.createServer((req, res) => {
    const path = req.url ?? "";
    if (!record({ method: req.method ?? "", path })) {
      // Not ours: no record, no response — destroy so the *other* worker still
      // sees the transport error its own closed-port test expects (ISSUE-92).
      req.socket.destroy();
      return;
    }
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      const captured: SinkRequest = {
        method: req.method ?? "",
        path,
        headers: req.headers,
        rawBody: data,
      };
      requests.push(captured);
      if (options.respond) {
        options.respond(captured, res);
        return;
      }
      const status = statusSequence[Math.min(call, statusSequence.length - 1)];
      call += 1;
      res.writeHead(status).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}${options.path ?? ""}`,
    port,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // Force-drop keep-alive sockets now instead of waiting out the
        // server's keepAliveTimeout: teardown must release the port
        // immediately (ISSUE-92).
        server.closeAllConnections();
      }),
  };
}

/**
 * Returns a loopback port with NO listener — a deterministic connection-
 * refused target for transport-failure tests.
 *
 * The kernel hands the port out on close without an established reuse policy,
 * so a later bind by another process is possible in principle; within one
 * vitest worker the follow-up bind happens immediately and has been reliable.
 * Never reserve-then-hold: the caller needs the port to be free to connect to.
 */
export async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

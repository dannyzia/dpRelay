/**
 * Dashboard session resolution (extracted STAGE F9, ISSUE-88).
 *
 * The cookie guard previously lived as private helpers inside routes/auth.ts,
 * but STAGE F9 gives the billing purchase route a SESSION-authenticated
 * variant (wallet buys), so two route modules now need identical resolution —
 * one copy in a service, no drift. Auth.ts keeps its cookie-setting helpers
 * and the M1 JWT routes untouched.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db.js";
import { sha256Hex } from "./crypto.js";

/** Dashboard session cookie. HttpOnly + Secure + SameSite=Lax set on every write. */
export const SESSION_COOKIE = "dp_session";

/** A live session: the row id (logout/deletion target) + the resolved user. */
export interface SessionUser {
  sessionId: string;
  user: { id: string; email: string };
}

/**
 * Extracts the session cookie value from the raw Cookie header. A single
 * cookie is all we need, so this stays dependency-free (no @fastify/cookie).
 */
export function readSessionCookie(request: FastifyRequest): string | null {
  const header = request.headers.cookie;
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
    }
  }
  return null;
}

/**
 * Resolves the cookie to a live session. Expired rows and sessions of
 * disabled users are deleted lazily (logout already deletes eagerly), so a
 * dead token is never honored twice.
 */
export function resolveSession(db: Db, request: FastifyRequest): SessionUser | null {
  const raw = readSessionCookie(request);
  if (raw === null) return null;
  const row = db
    .prepare(
      "SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.email, u.disabled " +
        "FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
    )
    .get(sha256Hex(raw)) as
    | { session_id: string; expires_at: number; user_id: string; email: string; disabled: number }
    | undefined;
  if (!row) return null;
  if (row.expires_at <= Math.floor(Date.now() / 1000) || row.disabled !== 0) {
    db.prepare("DELETE FROM user_sessions WHERE id = ?").run(row.session_id);
    return null;
  }
  return { sessionId: row.session_id, user: { id: row.user_id, email: row.email } };
}

/**
 * Session guard for session-authenticated routes: sends the 401 envelope
 * itself (the route then returns `reply` untouched) or yields the live
 * session.
 */
export function requireSession(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply,
): SessionUser | null {
  const session = resolveSession(db, request);
  if (session === null) {
    reply.code(401).send({ ok: false, error: "Sign in required", code: "auth_required" });
  }
  return session;
}

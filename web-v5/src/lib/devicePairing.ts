/**
 * BYOD device pairing payload helpers (Apps screen pairing panel).
 * Pure functions — no DOM, no API — so they unit-test in node.
 */

import { QrCode } from "./qrcodegen";

/** Display base for the API server: configured base, else the dashboard origin. */
export function resolveServerBase(apiBase: string, origin: string): string {
  return apiBase === "" ? origin : apiBase;
}

/**
 * The URI the gateway app consumes:
 * dprelay-enroll:v1?server=<enc>&secret=<enc> (URL-encoded, since secrets
 * contain base64 characters like + and / that break URLs).
 */
export function buildEnrollmentUri(serverBase: string, secret: string): string {
  const enc = encodeURIComponent;
  return `dprelay-enroll:v1?server=${enc(serverBase)}&secret=${enc(secret)}`;
}

/** Deterministic QR code as a self-contained SVG string. */
export function qrSvg(text: string): string {
  const qr = QrCode.encodeText(text, QrCode.Ecc.MEDIUM);
  const border = 2;
  const n = qr.size + border * 2;
  const parts: string[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const solid = qr.getModule(x - border, y - border);
      parts.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${solid ? "#111827" : "#ffffff"}"/>`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" ` +
    `shape-rendering="crispEdges" width="160" height="160">` +
    parts.join("") +
    `</svg>`
  );
}

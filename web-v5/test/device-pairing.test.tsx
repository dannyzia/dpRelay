import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import {
  buildEnrollmentUri,
  qrSvg,
  resolveServerBase,
} from "../src/lib/devicePairing";
import { BYOD_GUIDE_URL, DevicePairingView } from "../src/screens/DevicePairing";

const html = (el: JSX.Element): string => renderToString(el).replace(/<!-- -->/g, "");

describe("device pairing lib", () => {
  it("builds the enrollment URI with URL-encoded server and secret", () => {
    const uri = buildEnrollmentUri("https://api.example.com", "abc+/=");
    expect(uri).toContain("dprelay-enroll:v1?server=");
    expect(uri).toContain("https%3A%2F%2Fapi.example.com");
    expect(uri).toContain("abc%2B%2F%3D");
  });

  it("falls back to the dashboard origin when no API base is configured", () => {
    expect(resolveServerBase("", "https://dash.example.com")).toBe("https://dash.example.com");
    expect(resolveServerBase("https://api.example.com", "https://dash.example.com")).toBe(
      "https://api.example.com",
    );
  });

  it("renders a deterministic self-contained QR SVG", () => {
    const a = qrSvg("dprelay-enroll:v1?server=x&secret=y");
    const b = qrSvg("dprelay-enroll:v1?server=x&secret=y");
    expect(a).toBe(b);
    expect(a).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(a).toContain('shape-rendering="crispEdges"');
    expect(a).toContain('<rect');
    expect(a).toContain('fill="#111827"');
  });
});

describe("DevicePairingView", () => {
  const SECRET = "dev-enroll-value";

  it("renders the QR, payload, and copy button for a fresh secret", () => {
    const out = html(<DevicePairingView secret={SECRET} />);

    expect(out).toContain('data-testid="pairing"');
    expect(out).toContain("Link your Android gateway");
    expect(out).toContain("pairing-payload");
    expect(out).toContain("dprelay-enroll:v1?server=");
    expect(out).toContain("Copy enrollment payload");
    expect(out).toContain('class="qr-box"');
  });

  it("shows the shown-once fallback when the secret is empty", () => {
    const out = html(<DevicePairingView secret="" />);
    expect(out).toContain('data-testid="pairing-empty"');
    expect(out).toContain("shown once");
    expect(out).not.toContain("qr-box");
    // ISSUE-112: the guide still renders without a secret — recovery is
    // documented, and the hashed secret is never pretended to exist.
    expect(out).toContain("rotate the enrollment secret");
  });

  it("always carries the 4-step setup guide and the gateway APK reference", () => {
    for (const secret of [SECRET, ""]) {
      const out = html(<DevicePairingView secret={secret} />);
      const steps = out.match(/<li[\s\S]*?<\/li>/g) ?? [];
      expect(steps, `secret=${secret === "" ? "<empty>" : "set"}`).toHaveLength(4);
      expect(out).toContain('data-testid="pairing-steps"');
      expect(out).toContain('data-testid="gateway-apk"');
      expect(out).toContain(`href="${BYOD_GUIDE_URL}"`);
      expect(out).toContain("official download link");
    }
  });
});

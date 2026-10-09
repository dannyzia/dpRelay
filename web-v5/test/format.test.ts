import { describe, expect, it } from "vitest";
import { formatBdt, formatEpochUtc, formatPrice, formatSms, formatStatus } from "../src/format";

describe("formatEpochUtc", () => {
  it("renders epoch seconds as a fixed UTC stamp", () => {
    // Production trial expiry observed by the ISSUE-77 probe: 2026-11-07T19:33:56Z
    expect(formatEpochUtc(1794080036)).toBe("2026-11-07 19:33 UTC");
  });

  it("renders null expiry as an em dash", () => {
    expect(formatEpochUtc(null)).toBe("—");
  });
});

describe("formatBdt", () => {
  it("drops decimals for whole taka", () => {
    expect(formatBdt(50)).toBe("৳50");
    expect(formatBdt(0)).toBe("৳0");
  });

  it("keeps two decimals for fractional prices", () => {
    expect(formatBdt(0.2)).toBe("৳0.20");
    expect(formatBdt(12.5)).toBe("৳12.50");
  });
});

describe("formatPrice (ISSUE-89)", () => {
  it("renders BDT prices exactly like formatBdt", () => {
    expect(formatPrice(200, "BDT")).toBe("৳200");
    expect(formatPrice(0.2, "BDT")).toBe("৳0.20");
    // Empty currency (legacy rows) falls back to taka, never to a bare number.
    expect(formatPrice(50, "")).toBe("৳50");
  });

  it("renders non-BDT prices as amount + code, never with the taka symbol", () => {
    expect(formatPrice(20, "USD")).toBe("20 USD");
    expect(formatPrice(15, "EUR")).toBe("15 EUR");
    expect(formatPrice(99, "GBP")).not.toContain("৳");
  });
});

describe("formatSms", () => {
  it("appends the unit", () => {
    expect(formatSms(20)).toBe("20 SMS");
  });
});

describe("formatStatus", () => {
  it("capitalizes the server status", () => {
    expect(formatStatus("pending")).toBe("Pending");
    expect(formatStatus("approved")).toBe("Approved");
    expect(formatStatus("rejected")).toBe("Rejected");
  });
});

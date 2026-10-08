import { describe, expect, it } from "vitest";
import { formatBdt, formatEpochUtc, formatSms, formatStatus } from "../src/format";

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

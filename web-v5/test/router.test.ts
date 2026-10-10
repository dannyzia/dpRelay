import { describe, expect, it } from "vitest";
import { hrefFor, parseHash } from "../src/lib/router";

describe("parseHash", () => {
  it("parses a plain hash route into segments", () => {
    expect(parseHash("#/operator/billing")).toEqual(["operator", "billing"]);
  });

  it("parses the root hash to an empty route", () => {
    expect(parseHash("#")).toEqual([]);
    expect(parseHash("")).toEqual([]);
    expect(parseHash("#/")).toEqual([]);
  });

  it("drops empty segments from trailing slashes", () => {
    expect(parseHash("#/credits/")).toEqual(["credits"]);
  });
});

describe("hrefFor", () => {
  it("builds a hash href from segments", () => {
    expect(hrefFor(["operator"])).toBe("#/operator");
    expect(hrefFor(["operator", "billing"])).toBe("#/operator/billing");
    expect(hrefFor([])).toBe("#");
  });

  it("round-trips with parseHash", () => {
    expect(parseHash(hrefFor(["history"]))).toEqual(["history"]);
  });
});

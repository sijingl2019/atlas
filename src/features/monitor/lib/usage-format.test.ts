import { describe, expect, it } from "vitest";

import { fmtCost } from "./usage-format";

// A money amount is two facts: the currency it is in, which belongs to the data,
// and how a number reads, which belongs to the reader. Issue 333 was the two
// mixed up — locale digits behind a pasted `$`, so `$15,00` in tr-TR and
// `$1.234,50` where a de-DE reader expects `1.234,50 $`.
//
// Node fixes its default locale at startup, so a test cannot switch it. What
// holds in every locale: the output is exactly what `Intl` gives for that
// currency in the reader's locale, the currency is the one asked for, and
// the en-US layout is pinned wherever the suite happens to run in en-US.
const reader = (currency: string, opts: Intl.NumberFormatOptions = {}) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency, ...opts });

const inEnUS = new Intl.NumberFormat().resolvedOptions().locale === "en-US";

describe("fmtCost", () => {
  it("lays the amount out in the reader's locale, symbol placed by Intl", () => {
    for (const n of [15, -15, 0, 1234.5, 1234567.891]) {
      expect(fmtCost(n)).toBe(reader("USD").format(n));
    }
  });

  it("formats in the currency it is given, with that currency's own digits", () => {
    expect(fmtCost(2.5, "EUR")).toBe(reader("EUR").format(2.5));
    expect(fmtCost(2.5, "EUR")).toContain("€");
    // JPY has no minor unit, so no fraction digits — not USD's two.
    expect(fmtCost(1234.5, "JPY")).toBe(reader("JPY").format(1234.5));
  });

  it("takes an explicit number of fraction digits for sub-cent amounts", () => {
    expect(fmtCost(0.00123, "USD", 4)).toBe(
      reader("USD", { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(0.00123),
    );
  });

  it("shows a code Intl rejects after the number instead of throwing", () => {
    // The code came from an agent; the amount is still worth showing.
    expect(() => fmtCost(1.5, "NOT-A-CODE")).not.toThrow();
    expect(fmtCost(1.5, "NOT-A-CODE")).toMatch(/ NOT-A-CODE$/);
  });

  it.runIf(inEnUS)("reads as it always has in en-US, with the sign before the symbol", () => {
    expect(fmtCost(15)).toBe("$15.00");
    expect(fmtCost(-15)).toBe("-$15.00");
    expect(fmtCost(0)).toBe("$0.00");
    expect(fmtCost(0.005)).toBe("$0.01");
    expect(fmtCost(0.0001)).toBe("$0.00");
    expect(fmtCost(1234.5)).toBe("$1,234.50");
    expect(fmtCost(1234567.891)).toBe("$1,234,567.89");
    expect(fmtCost(2.5, "EUR")).toBe("€2.50");
    expect(fmtCost(3, "USD", 0)).toBe("$3");
  });
});

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

// A money amount has two independent parts: the currency it is in (a fact about
// the data) and how a number reads (a fact about the reader). `Intl` takes both
// and owns the symbol, its placement and the separators — `$1,234.50` in en-US,
// `1.234,50 $` in de-DE, `1.234,50 €` for EUR. Never paste a symbol onto
// locale-formatted digits: that is what printed `$15,00` (issue 333).
const formatters = new Map<string, Intl.NumberFormat>();

function currencyFormat(currency: string, fractionDigits?: number): Intl.NumberFormat {
  const key = `${currency}:${fractionDigits ?? ""}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    formatters.set(key, f);
  }
  return f;
}

/**
 * A money amount in the reader's locale: `fmtCost(15)` → "$15.00" in en-US.
 * `currency` is an ISO 4217 code; `fractionDigits` overrides the currency's
 * own (2 for USD, 0 for JPY). A code `Intl` rejects is shown after the number
 * rather than thrown — it came from an agent, and the amount is still true.
 */
export function fmtCost(n: number, currency = "USD", fractionDigits?: number): string {
  try {
    return currencyFormat(currency, fractionDigits).format(n);
  } catch {
    const digits = fractionDigits ?? 2;
    const num = n.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    return `${num} ${currency}`;
  }
}

export function fmtDate(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A 0..1 fraction as a percentage: `fmtPct(0.823)` → "82%". */
export function fmtPct(frac: number, digits = 0): string {
  return `${(frac * 100).toFixed(digits)}%`;
}

/** An integer with locale grouping: `fmtNum(12345)` → "12,345". */
export function fmtNum(n: number): string {
  return Math.round(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

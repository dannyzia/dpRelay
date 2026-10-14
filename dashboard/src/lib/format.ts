/**
 * Pure currency display helpers for the dashboard SPA.
 *
 * The server stores every price in `price_bdt`/`amount_bdt` but labels it with
 * a `currency` column (F5/ISSUE-89: BDT | USD | EUR, default BDT), so rendering
 * a bare `৳` prefix mislabels foreign-currency packages as taka. Every money
 * string the UI prints goes through `formatPrice` so the symbol always matches
 * the row's own currency.
 *
 * These are display-only: they never parse user input and never touch the API,
 * which keeps them deterministic and trivially unit-testable.
 */

/**
 * Formats a taka amount with the `৳` symbol: integers stay bare
 * (`৳500`), fractional amounts get two decimals (`৳0.20`).
 *
 * @param amount amount in BDT
 * @returns the formatted taka string
 */
export function formatBdt(amount: number): string {
  return Number.isInteger(amount) ? `৳${amount}` : `৳${amount.toFixed(2)}`;
}

/**
 * Formats an amount for display in its own currency.
 *
 * BDT (the default when the field is absent) renders `৳`-prefixed; USD and EUR
 * render their symbol prefixes; any other ISO code falls back to
 * `"<amount> <CODE>"` so an unexpected server value is still shown honestly
 * rather than mislabelled as taka.
 *
 * @param amount the price/amount as returned by the API
 * @param currency optional ISO-style currency code (e.g. `"USD"`); defaults to BDT
 * @returns the formatted money string
 */
export function formatPrice(amount: number, currency?: string): string {
  const c = (currency ?? "BDT").trim().toUpperCase();
  if (c === "BDT" || c === "") return formatBdt(amount);
  if (c === "USD") return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
  if (c === "EUR") return Number.isInteger(amount) ? `€${amount}` : `€${amount.toFixed(2)}`;
  return Number.isInteger(amount) ? `${amount} ${c}` : `${amount.toFixed(2)} ${c}`;
}

/**
 * Pure display helpers — deterministic on purpose so tests can assert exact
 * output (no locale-dependent Intl formatting anywhere in the UI).
 */

/** Epoch SECONDS → `YYYY-MM-DD HH:MM UTC`. Null expiry renders as "—". */
export function formatEpochUtc(epochSec: number | null): string {
  if (epochSec === null) return "—";
  const iso = new Date(epochSec * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Whole-taka amounts render without decimals; fractional ones keep 2 (`৳0.20`). */
export function formatBdt(amount: number): string {
  return Number.isInteger(amount) ? `৳${amount}` : `৳${amount.toFixed(2)}`;
}

/** Count with the SMS unit. */
export function formatSms(n: number): string {
  return `${n} SMS`;
}

/** Transaction/chip status, server values are pending|approved|rejected. */
export function formatStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

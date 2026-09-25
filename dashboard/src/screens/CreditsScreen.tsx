import { useEffect, useState } from "react";
import { appFetch, API_BASE } from "../api.js";

interface CreditsRow {
  otpSmsRemaining: number;
  bulkSmsRemaining: number;
  otpExpiresAt: number | null;
  bulkExpiresAt: number | null;
  lastTransactionId: string | null;
  purchasedAt: number | null;
}

interface PackageRow {
  packageCode: string;
  name: string;
  smsQuota: number;
  priceBdt: number;
  validityDays: number;
  type: "otp" | "bulk" | "both";
  isActive: boolean;
}

interface RequestResult {
  transactionId: string;
  bkashNumber: string;
  packageCode: string;
  amountBdt: number;
}

/**
 * Credits overview: balances, the buy-credits flow (the bKash "Send Money"
 * destination comes from the server's credits/request response —
 * BKASH_PERSONAL_NUMBER configured server-side, never hardcoded here), and
 * the active package catalog.
 */
export function CreditsScreen() {
  const [credits, setCredits] = useState<CreditsRow | null>(null);
  const [packages, setPackages] = useState<PackageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [buyCode, setBuyCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    appFetch<{ ok: true } & Partial<CreditsRow> & Record<string, unknown>>("/v5/billing/credits")
      .then((body) => {
        // The credits route returns snake_case columns; normalize the fields
        // the UI shows. Missing row (no purchase yet) renders as zeroed.
        setCredits({
          otpSmsRemaining: Number(body["otp_sms_remaining"] ?? 0),
          bulkSmsRemaining: Number(body["bulk_sms_remaining"] ?? 0),
          otpExpiresAt: (body["otp_expires_at"] as number | null) ?? null,
          bulkExpiresAt: (body["bulk_expires_at"] as number | null) ?? null,
          lastTransactionId: (body["last_transaction_id"] as string | null) ?? null,
          purchasedAt: (body["purchased_at"] as number | null) ?? null,
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load credits"));
    fetch(`${API_BASE}/v5/billing/packages`)
      .then((r) => r.json())
      .then((body: { packages?: PackageRow[] }) => setPackages(body.packages ?? []))
      .catch(() => setPackages([]));
  }, []);

  async function requestPurchase(packageCode: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await appFetch<RequestResult & { ok: true }>("/v5/billing/credits/request", {
        method: "POST",
        body: JSON.stringify({ packageCode }),
      });
      setBuyCode(result.bkashNumber);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Credit request failed");
    } finally {
      setBusy(false);
    }
  }

  function fmtExpiry(unixSec: number | null): string {
    return unixSec === null ? "—" : new Date(unixSec * 1000).toLocaleDateString();
  }

  return (
    <section className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-100">Credits</h1>
      {error !== null && (
        <div role="alert" className="rounded-lg border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="text-sm font-medium text-slate-400">OTP credits</h2>
          <p className="mt-1 text-3xl font-semibold text-slate-100">{credits?.otpSmsRemaining ?? "…"}</p>
          <p className="mt-1 text-xs text-slate-500">Expires {fmtExpiry(credits?.otpExpiresAt ?? null)}</p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="text-sm font-medium text-slate-400">Bulk credits</h2>
          <p className="mt-1 text-3xl font-semibold text-slate-100">{credits?.bulkSmsRemaining ?? "…"}</p>
          <p className="mt-1 text-xs text-slate-500">Expires {fmtExpiry(credits?.bulkExpiresAt ?? null)}</p>
        </div>
      </div>

      {buyCode !== null && (
        <div className="rounded-xl border border-emerald-800 bg-emerald-950/50 p-5 text-emerald-200">
          <h2 className="font-medium">Send the payment, then wait for operator approval</h2>
          <p className="mt-1 text-sm">
            bKash <span className="font-mono font-semibold">{buyCode}</span> — a pending transaction was created;
            the operator approves it on the admin plane and credits land automatically.
          </p>
        </div>
      )}

      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <h2 className="font-medium text-slate-200">Buy credits</h2>
        {packages === null ? (
          <p className="mt-2 text-sm text-slate-400">Loading packages…</p>
        ) : packages.filter((p) => p.isActive).length === 0 ? (
          <p className="mt-2 text-sm text-slate-400">No active packages published.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-800">
            {packages
              .filter((p) => p.isActive)
              .map((p) => (
                <li key={p.packageCode} className="flex items-center justify-between gap-3 py-3">
                  <div>
                    <div className="font-medium text-slate-200">{p.name}</div>
                    <div className="text-xs text-slate-500">
                      {p.smsQuota} SMS · {p.validityDays} days · {p.type}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-semibold text-slate-100">৳{p.priceBdt}</span>
                    <button
                      onClick={() => requestPurchase(p.packageCode)}
                      disabled={busy}
                      className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      Buy
                    </button>
                  </div>
                </li>
              ))}
          </ul>
        )}
      </div>
    </section>
  );
}

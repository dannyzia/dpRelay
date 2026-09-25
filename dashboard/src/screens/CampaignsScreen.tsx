import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  campaignAction,
  createCampaign,
  getCampaign,
  listCampaigns,
  type Campaign,
  type CampaignDetail,
} from "../api.js";

type CampaignStatus = Campaign["status"];

const STATUS_FILTERS: Array<CampaignStatus | "all"> = ["all", "queued", "sending", "paused", "completed", "cancelled"];

const STATUS_STYLES: Record<CampaignStatus, string> = {
  queued: "bg-amber-950/60 text-amber-300 border-amber-800",
  sending: "bg-sky-950/60 text-sky-300 border-sky-800",
  paused: "bg-violet-950/60 text-violet-300 border-violet-800",
  completed: "bg-emerald-950/60 text-emerald-300 border-emerald-800",
  cancelled: "bg-slate-800 text-slate-400 border-slate-700",
};

const E164_RE = /^\+[1-9]\d{7,14}$/;

function fmtTime(unixSec: number | null): string {
  if (unixSec === null) return "—";
  return new Date(unixSec * 1000).toLocaleString();
}

function StatusBadge(props: { status: Campaign["status"] }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[props.status]}`}>
      {props.status}
    </span>
  );
}

function ProgressBar(props: { campaign: Campaign }) {
  const { totalRecipients, sentCount, failedCount } = props.campaign;
  const sentPct = totalRecipients > 0 ? (sentCount / totalRecipients) * 100 : 0;
  const failedPct = totalRecipients > 0 ? (failedCount / totalRecipients) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="h-2 w-40 overflow-hidden rounded-full bg-slate-800">
        <div className="h-full bg-emerald-600" style={{ width: `${sentPct}%` }} />
        <div className="h-full bg-red-600" style={{ width: `${failedPct}%` }} />
      </div>
      <span className="text-xs text-slate-400">
        {sentCount}/{totalRecipients} sent · {failedCount} failed · {Math.max(0, totalRecipients - sentCount - failedCount)} queued
      </span>
    </div>
  );
}

function CreateForm(props: { onCreated: (campaignId: string) => void }) {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [phonesText, setPhonesText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const phones = phonesText
      .split(/[\s,]+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const invalid = phones.filter((p) => !E164_RE.test(p));
    if (invalid.length > 0) {
      setError(`Not valid E.164 (+countrynumber…): ${invalid.slice(0, 3).join(", ")}`);
      return;
    }
    setBusy(true);
    try {
      const result = await createCampaign({ name: name.trim(), message, phones });
      setName("");
      setMessage("");
      setPhonesText("");
      props.onCreated(result.campaignId);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "bulk_not_enabled") setError("Bulk sending is not enabled on this deployment (BULK_ENABLED).");
        else if (err.code === "no_credits_row" || err.code === "insufficient_credits") setError("Not enough bulk credits for this campaign.");
        else setError(err.message);
      } else {
        setError("Something went wrong — try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <h2 className="font-medium text-slate-200">New campaign</h2>
      {error !== null && (
        <div role="alert" className="rounded-lg border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Campaign name"
        maxLength={100}
        required
        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 placeholder-slate-500 outline-none focus:border-sky-500"
      />
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Message (160 chars GSM / 70 chars UCS-2)"
        maxLength={1600}
        required
        rows={3}
        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 placeholder-slate-500 outline-none focus:border-sky-500"
      />
      <textarea
        value={phonesText}
        onChange={(e) => setPhonesText(e.target.value)}
        placeholder={"Phone numbers, one per line (E.164)\n+8801XXXXXXXXX"}
        rows={4}
        required
        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-sky-500"
      />
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
      >
        {busy ? "Creating…" : "Create campaign"}
      </button>
    </form>
  );
}

function Detail(props: { campaignId: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const reload = useCallback(() => {
    getCampaign(props.campaignId)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load campaign"));
  }, [props.campaignId]);

  useEffect(reload, [reload]);

  async function act(action: "pause" | "resume" | "cancel") {
    if (detail === null) return;
    if (action === "cancel" && !window.confirm("Cancel this campaign? Unprocessed recipients are refunded.")) return;
    setActing(true);
    setError(null);
    try {
      await campaignAction(detail.campaignId, action);
      reload();
      props.onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActing(false);
    }
  }

  if (error !== null) return <div className="rounded-xl border border-red-800 bg-red-950/60 p-4 text-sm text-red-300">{error}</div>;
  if (detail === null) return <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-400">Loading…</div>;

  const actionable = detail.status === "queued" || detail.status === "sending" || detail.status === "paused";
  return (
    <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-medium text-slate-200">{detail.name}</h2>
        <StatusBadge status={detail.status} />
      </div>
      <p className="whitespace-pre-wrap rounded-lg bg-slate-950/60 p-3 text-sm text-slate-300">{detail.message}</p>
      <dl className="grid grid-cols-2 gap-2 text-sm text-slate-400">
        <div>Created: {fmtTime(detail.createdAt)}</div>
        <div>Started: {fmtTime(detail.startedAt)}</div>
        <div>Completed: {fmtTime(detail.completedAt)}</div>
        <div>Source: {detail.sourceType}</div>
      </dl>
      <ProgressBar campaign={detail} />
      {actionable && (
        <div className="flex gap-2">
          {detail.status !== "paused" && (
            <button onClick={() => act("pause")} disabled={acting} className="rounded-lg bg-violet-700 px-3 py-1.5 text-sm text-white hover:bg-violet-600 disabled:opacity-50">
              Pause
            </button>
          )}
          {detail.status === "paused" && (
            <button onClick={() => act("resume")} disabled={acting} className="rounded-lg bg-sky-700 px-3 py-1.5 text-sm text-white hover:bg-sky-600 disabled:opacity-50">
              Resume
            </button>
          )}
          <button onClick={() => act("cancel")} disabled={acting} className="rounded-lg bg-red-800 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50">
            Cancel &amp; refund
          </button>
        </div>
      )}
    </div>
  );
}

export function CampaignsScreen() {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Campaign["status"] | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => {
    listCampaigns(filter === "all" ? undefined : filter)
      .then((r) => {
        setCampaigns(r.campaigns);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load campaigns"));
  }, [filter]);

  useEffect(reload, [reload, reloadKey]);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-slate-100">Campaigns</h1>
        <div className="flex gap-1">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                filter === s ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-400 hover:text-slate-200"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {error !== null && (
        <div role="alert" className="rounded-lg border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className="space-y-3">
          <CreateForm
            onCreated={(campaignId) => {
              setSelectedId(campaignId);
              setReloadKey((k) => k + 1);
            }}
          />
          {campaigns === null ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-400">Loading…</div>
          ) : campaigns.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-400">No campaigns{filter !== "all" ? ` with status “${filter}”` : ""}.</div>
          ) : (
            <ul className="space-y-2">
              {campaigns.map((c) => (
                <li key={c.campaignId}>
                  <button
                    onClick={() => setSelectedId(c.campaignId)}
                    className={`w-full rounded-xl border p-4 text-left transition ${
                      selectedId === c.campaignId
                        ? "border-sky-600 bg-slate-900"
                        : "border-slate-800 bg-slate-900/60 hover:border-slate-600"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-200">{c.name}</span>
                      <StatusBadge status={c.status} />
                    </div>
                    <div className="mt-2">
                      <ProgressBar campaign={c} />
                    </div>
                    <div className="mt-2 text-xs text-slate-500">Created {fmtTime(c.createdAt)}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          {selectedId !== null ? (
            <Detail campaignId={selectedId} onChanged={() => setReloadKey((k) => k + 1)} />
          ) : (
            <div className="rounded-xl border border-dashed border-slate-800 p-4 text-sm text-slate-500">
              Select a campaign to see message, progress and actions.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

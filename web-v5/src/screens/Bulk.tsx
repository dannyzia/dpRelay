/**
 * Bulk campaign upload (F5c / ISSUE-85) — two-step by design: pick a file
 * (or PASTE numbers, ISSUE-112), PREVIEW it (count, first five numbers,
 * line-numbered rejects), then type a campaign name + message. Submit only
 * enables after a preview of the CURRENT source, and the preview's checksum
 * travels with the create call so the server refuses to spend credits if the
 * list changed in between.
 *
 * .xlsx/.xls workbooks are converted to CSV IN THE BROWSER (SheetJS — the one
 * flagged web-v5 dependency): the server accepts CSV only, so a workbook
 * never leaves the browser except as plain recipient text.
 *
 * ISSUE-112 adds the template-variable chips ({{name}} / {{phone}}) above the
 * message, and the post-create broadcast status panel (polled
 * GET /v5/bulk/campaigns/:id) that visualises queued → sending → completed.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import * as XLSX from "xlsx";
import {
  ApiError,
  createBulkCampaign,
  describeError,
  getCampaignStatus,
  previewBulkCsv,
  type BulkCreateResult,
  type BulkCampaignStatus,
  type BulkPreview,
} from "../api";
import { ErrorBanner } from "../components/ErrorBanner";

/** Template tokens offered as clickable chips above the message box (ISSUE-112). */
export const TEMPLATE_VARIABLES = ["{{name}}", "{{phone}}"] as const;

/** Source label shown when the recipient list came from the paste box. */
export const PASTED_SOURCE_LABEL = "Pasted recipients";

/**
 * ⚠️ FLAG: broadcast status poll interval, hardcoded (web-v5 has no runtime
 * config mechanism) — 5s keeps the progress bar live without hammering the
 * status endpoint; single definition so it is one edit to change.
 */
const STATUS_POLL_MS = 5000;

/**
 * Insert a template token into `text` at `caret`, adding the single spacing
 * character needed so two tokens/words never fuse. Pure so it unit-tests in
 * the node environment (no DOM events in this repo's component tests).
 *
 * @param text current message text.
 * @param token the token to insert (e.g. `{{name}}`).
 * @param caret caret offset in `text` (clamped to the string bounds).
 * @returns the new text plus the caret offset to restore after insertion.
 */
export function insertToken(
  text: string,
  token: string,
  caret: number,
): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const padBefore = before.length > 0 && !/[\s\n]$/.test(before) ? " " : "";
  const padAfter = after.length > 0 && !/^[\s\n]/.test(after) ? " " : "";
  return {
    text: `${before}${padBefore}${token}${padAfter}${after}`,
    caret: before.length + padBefore.length + token.length,
  };
}

/** Chip styling per broadcast status — reuses the shipped `.chip` states. */
function statusChipClass(status: string): string {
  if (status === "completed") return "chip approved";
  if (status === "cancelled") return "chip rejected";
  if (status === "sending" || status === "queued" || status === "paused") return "chip pending";
  return "chip";
}

/**
 * Broadcast status visualisation for a just-created campaign: status chip,
 * sent/failed/queued counters and a determinate progress bar. Pure view,
 * exported for render tests.
 *
 * @param props.status live counters, `null` while the first poll is in flight.
 * @param props.error last poll failure, surfaced as an alert.
 * @param props.onRefresh manual re-poll (auto-polling also runs in the container).
 */
export function CampaignStatusView(props: {
  status: BulkCampaignStatus | null;
  error: string | null;
  onRefresh?: () => void;
}): JSX.Element {
  const status = props.status;
  const total = status?.totalRecipients ?? 0;
  const processed = status === null ? 0 : status.sentCount + status.failedCount;
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  return (
    <div className="card nested" data-testid="campaign-status">
      <h2>Broadcast status</h2>
      {props.error !== null && (
        <p className="error" role="alert">
          {props.error}
        </p>
      )}
      {status === null ? (
        <p className="muted">Loading broadcast status…</p>
      ) : (
        <>
          <p>
            <span className={statusChipClass(status.status)} data-testid="campaign-status-chip">
              {status.status}
            </span>{" "}
            <strong data-testid="campaign-percent">{percent}%</strong> —{" "}
            <strong>{status.sentCount}</strong> sent · <strong>{status.failedCount}</strong> failed ·{" "}
            <strong>{status.queuedCount}</strong> queued of {total} recipients
          </p>
          <div
            className="progress"
            role="progressbar"
            aria-label="Broadcast progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            data-testid="campaign-progress-bar"
          >
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
        </>
      )}
      {props.onRefresh !== undefined && (
        <button type="button" className="button-link" onClick={props.onRefresh}>
          Refresh status
        </button>
      )}
    </div>
  );
}

/**
 * Reads a chosen file as CSV text. Native .csv passes through unchanged;
 * .xlsx/.xls are parsed client-side and re-serialised to CSV (F5c: server
 * takes CSV only).
 *
 * @throws {ApiError} `unreadable_file` when the workbook cannot be parsed
 */
export async function fileToCsvText(file: File): Promise<string> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".csv") || file.type === "text/csv") {
    return file.text();
  }
  try {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const sheetName = workbook.SheetNames[0];
    const sheet = sheetName !== undefined ? workbook.Sheets[sheetName] : undefined;
    if (sheet === undefined) {
      throw new ApiError(400, "unreadable_file", "The workbook has no readable sheet");
    }
    return XLSX.utils.sheet_to_csv(sheet);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, "unreadable_file", `Could not read ${file.name} — export it as CSV and retry`);
  }
}

export interface BulkViewProps {
  fileName: string | null;
  previewing: boolean;
  preview: BulkPreview | null;
  previewError: string | null;
  name: string;
  message: string;
  submitting: boolean;
  submitError: string | null;
  created: BulkCreateResult | null;
  onFileChosen: (file: File) => void;
  onName: (value: string) => void;
  onMessage: (value: string) => void;
  onSubmit: () => void;
  /** ISSUE-112: raw pasted recipients (one E.164 per line) awaiting preview. */
  pasted?: string;
  onPasted?: (value: string) => void;
  /** Runs the same server-side preview over the pasted list (step 1 of two). */
  onPreviewPasted?: () => void;
  /** ISSUE-112: inserts a template token into the message at the caret. */
  onInsertVariable?: (token: string) => void;
  /** ISSUE-112: ref to the message textarea so tokens land at the caret. */
  messageRef?: RefObject<HTMLTextAreaElement>;
  /** ISSUE-112: live broadcast counters for the campaign just created. */
  campaignStatus?: BulkCampaignStatus | null;
  campaignStatusError?: string | null;
  onRefreshStatus?: () => void;
}

/**
 * Pure upload view — exported for render tests (this repo's component tests
 * run in the node environment via react-dom/server, no DOM events).
 */
export function BulkView(props: BulkViewProps): JSX.Element {
  const invalid = props.preview?.invalidRows ?? [];
  // Fresh preview of the current file + a clean list + typed name/message —
  // nothing else unlocks the spend (F5c: "Submit enabled only after a fresh
  // preview").
  const canSubmit =
    props.preview !== null &&
    invalid.length === 0 &&
    props.preview.total > 0 &&
    props.name.trim().length > 0 &&
    props.message.trim().length > 0 &&
    !props.previewing &&
    !props.submitting &&
    props.created === null;

  return (
    <>
      <div className="page-head">
        <h1>Bulk SMS</h1>
      </div>
      {props.created !== null && (
        <p className="banner" data-testid="bulk-created">
          Campaign queued: {props.created.campaignId} — {props.created.totalRecipients} recipients,{" "}
          {props.created.creditsReserved} credits reserved.
        </p>
      )}
      {props.created !== null && (
        <CampaignStatusView
          status={props.campaignStatus ?? null}
          error={props.campaignStatusError ?? null}
          onRefresh={props.onRefreshStatus}
        />
      )}
      {props.previewError !== null && <ErrorBanner message={props.previewError} />}
      {props.submitError !== null && <ErrorBanner message={props.submitError} />}

      <div
        className="dropzone"
        data-testid="bulk-dropzone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const file = event.dataTransfer.files[0];
          if (file !== undefined) props.onFileChosen(file);
        }}
      >
        <label htmlFor="bulkFile">
          <input
            id="bulkFile"
            type="file"
            accept=".csv,.xlsx,.xls,text/csv"
            data-testid="bulk-file-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) props.onFileChosen(file);
            }}
          />{" "}
          Drop a .csv or .xlsx recipient file here, or choose one
        </label>
        {props.fileName !== null && (
          <p data-testid="bulk-file-name">{props.fileName}</p>
        )}
        {props.previewing && <p className="muted">Parsing and previewing…</p>}
      </div>

      <div className="paste-box" data-testid="bulk-paste">
        <label htmlFor="bulkPasted">Or paste recipients</label>
        <p className="muted">
          One E.164 number per line (<code>+8801711000001</code>). Pasted lists go through the
          same preview, credit check and per-campaign limit as an uploaded file.
        </p>
        <textarea
          id="bulkPasted"
          data-testid="bulk-pasted"
          rows={4}
          value={props.pasted ?? ""}
          placeholder={"+8801711000001\n+8801711000002"}
          onChange={(event) => props.onPasted?.(event.target.value)}
        />
        <button
          type="button"
          data-testid="bulk-preview-pasted"
          disabled={(props.pasted ?? "").trim().length === 0 || props.previewing || props.submitting}
          onClick={(): void => props.onPreviewPasted?.()}
        >
          Preview pasted recipients
        </button>
      </div>

      {props.preview !== null && (
        <div data-testid="bulk-preview">
          <p>
            <strong data-testid="bulk-total">{props.preview.total}</strong> recipients ready
            {props.preview.perCampaignLimit !== undefined && (
              <> — per-campaign limit {props.preview.perCampaignLimit}</>
            )}
            {props.preview.headerSkipped === true && <> — header row skipped</>}
          </p>
          <p className="mono" data-testid="bulk-sample">
            {props.preview.sampleFirst5.join(", ") || "—"}
          </p>
          {invalid.length > 0 && (
            <>
              <table data-testid="bulk-invalid">
                <thead>
                  <tr>
                    <th>Line</th>
                    <th>Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {invalid.map((row) => (
                    <tr key={row.line}>
                      <td className="num">{row.line}</td>
                      <td>{row.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted" data-testid="bulk-invalid-hint">
                Fix these lines and re-upload — invalid rows are never sent.
              </p>
            </>
          )}
        </div>
      )}

      <label htmlFor="bulkName">Campaign name</label>
      <input
        id="bulkName"
        data-testid="bulk-name"
        maxLength={100}
        value={props.name}
        onChange={(event) => props.onName(event.target.value)}
      />
      <div className="var-chips" data-testid="bulk-var-chips">
        <span className="muted">Insert:</span>
        {TEMPLATE_VARIABLES.map((token) => (
          <button
            key={token}
            type="button"
            className="chip var-chip"
            onClick={(): void => props.onInsertVariable?.(token)}
          >
            {token}
          </button>
        ))}
      </div>
      <label htmlFor="bulkMessage">Message</label>
      <textarea
        id="bulkMessage"
        data-testid="bulk-message"
        rows={4}
        value={props.message}
        ref={props.messageRef}
        onChange={(event) => props.onMessage(event.target.value)}
      />
      <button type="button" data-testid="bulk-submit" disabled={!canSubmit} onClick={props.onSubmit}>
        {props.submitting ? "Creating…" : "Create campaign"}
      </button>
      {props.preview === null && !props.previewing && (
        <p className="muted">
          Choose a file or paste numbers above, then preview recipients — nothing is sent before
          you confirm.
        </p>
      )}
    </>
  );
}

/** Container: file → server-side preview → checksum-bound create. */
export function Bulk(): JSX.Element {
  const [fileName, setFileName] = useState<string | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<boolean>(false);
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [name, setName] = useState<string>("");
  const [message, setMessage] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState<BulkCreateResult | null>(null);
  // ISSUE-112: pasted recipient source + the live broadcast status of the
  // campaign that was just queued (polled until it reaches a terminal state).
  const [pasted, setPasted] = useState<string>("");
  const [campaignStatus, setCampaignStatus] = useState<BulkCampaignStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  // Bumped by the manual Refresh button to restart the poll loop.
  const [statusRefreshTick, setStatusRefreshTick] = useState<number>(0);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  /** Choosing a file invalidates any earlier preview — freshness is per file. */
  const chooseFile = (file: File): void => {
    setFileName(file.name);
    setCsvText(null);
    setPreview(null);
    setPreviewError(null);
    setSubmitError(null);
    setCreated(null);
    setPreviewing(true);
    void (async (): Promise<void> => {
      try {
        const text = await fileToCsvText(file);
        const result = await previewBulkCsv(text);
        setCsvText(text);
        setPreview(result);
      } catch (err) {
        setPreviewError(describeError(err));
      } finally {
        setPreviewing(false);
      }
    })();
  };

  /** Editing the pasted list invalidates any earlier preview — freshness is per source. */
  const onPasted = (value: string): void => {
    setPasted(value);
    setFileName(null);
    setCsvText(null);
    setPreview(null);
    setPreviewError(null);
    setSubmitError(null);
  };

  /**
   * Step 1 over the pasted source: normalise to one E.164 per line and run it
   * through the SAME server preview as a file — the count, invalid-row report,
   * credit check and checksum binding are the server's, so pasting can never
   * bypass the two-step rule or the per-campaign limit.
   */
  const previewPasted = (): void => {
    const lines = pasted
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) {
      setPreviewError("Paste at least one E.164 number, one per line.");
      return;
    }
    const text = lines.join("\n");
    setFileName(PASTED_SOURCE_LABEL);
    setCsvText(null);
    setPreview(null);
    setPreviewError(null);
    setSubmitError(null);
    setCreated(null);
    setPreviewing(true);
    void (async (): Promise<void> => {
      try {
        const result = await previewBulkCsv(text);
        setCsvText(text);
        setPreview(result);
      } catch (err) {
        setPreviewError(describeError(err));
      } finally {
        setPreviewing(false);
      }
    })();
  };

  /** Inserts a template token at the message caret and restores the caret. */
  const insertVariable = (token: string): void => {
    const caret = messageRef.current?.selectionStart ?? message.length;
    const next = insertToken(message, token, caret);
    setMessage(next.text);
    requestAnimationFrame(() => {
      const box = messageRef.current;
      if (box === null) return;
      box.focus();
      box.setSelectionRange(next.caret, next.caret);
    });
  };

  // Broadcast status: poll the just-created campaign until it reaches a
  // terminal state (completed/cancelled), then stop; failures keep the panel
  // usable via the manual Refresh button instead of spamming the endpoint.
  useEffect(() => {
    if (created === null) {
      setCampaignStatus(null);
      setStatusError(null);
      return;
    }
    let alive = true;
    let terminal = false;
    const poll = (): Promise<void> =>
      getCampaignStatus(created.campaignId)
        .then((status) => {
          if (!alive) return;
          setCampaignStatus(status);
          setStatusError(null);
          terminal = status.status === "completed" || status.status === "cancelled";
        })
        .catch((err: unknown) => {
          if (alive) setStatusError(describeError(err));
        });
    void poll();
    const timer = window.setInterval(() => {
      if (terminal) {
        window.clearInterval(timer);
        return;
      }
      void poll();
    }, STATUS_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [created, statusRefreshTick]);

  const submit = (): void => {
    if (csvText === null || preview === null || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    void (async (): Promise<void> => {
      try {
        const result = await createBulkCampaign({
          checksum: preview.checksum,
          name: name.trim(),
          message,
          csv: csvText,
        });
        setCreated(result);
        // Full reset: the next campaign must go through a fresh preview,
        // so one reviewed file can never be submitted twice by accident.
        setFileName(null);
        setCsvText(null);
        setPreview(null);
        setName("");
        setMessage("");
      } catch (err) {
        setSubmitError(describeError(err));
        if (err instanceof ApiError && err.code === "checksum_mismatch") {
          // The server parsed a different list than we previewed — re-run the
          // preview so the operator reviews what would actually be sent.
          try {
            setPreview(await previewBulkCsv(csvText));
          } catch {
            // Keep the checksum_mismatch error on screen; the operator can
            // re-choose the file to retry from scratch.
          }
        }
      } finally {
        setSubmitting(false);
      }
    })();
  };

  return (
    <BulkView
      fileName={fileName}
      previewing={previewing}
      preview={preview}
      previewError={previewError}
      name={name}
      message={message}
      submitting={submitting}
      submitError={submitError}
      created={created}
      pasted={pasted}
      onPasted={onPasted}
      onPreviewPasted={previewPasted}
      onInsertVariable={insertVariable}
      messageRef={messageRef}
      campaignStatus={campaignStatus}
      campaignStatusError={statusError}
      onRefreshStatus={(): void => setStatusRefreshTick((tick) => tick + 1)}
      onFileChosen={chooseFile}
      onName={setName}
      onMessage={setMessage}
      onSubmit={submit}
    />
  );
}

/**
 * Bulk campaign upload (F5c / ISSUE-85) — two-step by design: pick a file,
 * PREVIEW it (count, first five numbers, line-numbered rejects), then type a
 * campaign name + message. Submit only enables after a preview of the CURRENT
 * file, and the preview's checksum travels with the create call so the server
 * refuses to spend credits if the list changed in between.
 *
 * .xlsx/.xls workbooks are converted to CSV IN THE BROWSER (SheetJS — the one
 * flagged web-v5 dependency): the server accepts CSV only, so a workbook
 * never leaves the browser except as plain recipient text.
 */
import { useState } from "react";
import * as XLSX from "xlsx";
import {
  ApiError,
  createBulkCampaign,
  describeError,
  previewBulkCsv,
  type BulkCreateResult,
  type BulkPreview,
} from "../api";
import { ErrorBanner } from "../components/ErrorBanner";

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
      <label htmlFor="bulkMessage">Message</label>
      <textarea
        id="bulkMessage"
        data-testid="bulk-message"
        rows={4}
        value={props.message}
        onChange={(event) => props.onMessage(event.target.value)}
      />
      <button type="button" data-testid="bulk-submit" disabled={!canSubmit} onClick={props.onSubmit}>
        {props.submitting ? "Creating…" : "Create campaign"}
      </button>
      {props.preview === null && !props.previewing && (
        <p className="muted">Choose a file to preview recipients — nothing is sent before you confirm.</p>
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
      onFileChosen={chooseFile}
      onName={setName}
      onMessage={setMessage}
      onSubmit={submit}
    />
  );
}

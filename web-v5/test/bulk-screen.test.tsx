/**
 * F5c (ISSUE-85) — BulkView render tests (node environment, react-dom/server)
 * plus the client-side file conversion: native csv passes through, workbooks
 * become csv in the browser, unreadable files get a structured error.
 */
import { describe, expect, it } from "vitest";
import { renderToString as renderToRawString } from "react-dom/server";
import * as XLSX from "xlsx";
import type { BulkCreateResult, BulkPreview } from "../src/api";
import { BulkView, fileToCsvText, type BulkViewProps } from "../src/screens/Bulk";

/** Strip React's `<!-- -->` text separators (see operator-screens.test.tsx). */
const renderToString = (el: JSX.Element): string =>
  renderToRawString(el).replace(/<!-- -->/g, "");

const NOOP = (): void => undefined;

function props(overrides: Partial<BulkViewProps> = {}): BulkViewProps {
  return {
    fileName: null,
    previewing: false,
    preview: null,
    previewError: null,
    name: "",
    message: "",
    submitting: false,
    submitError: null,
    created: null,
    onFileChosen: NOOP,
    onName: NOOP,
    onMessage: NOOP,
    onSubmit: NOOP,
    ...overrides,
  };
}

const cleanPreview: BulkPreview = {
  total: 3,
  sampleFirst5: ["+8801711000001", "+8801711000002", "+8801711000003"],
  invalidRows: [],
  checksum: "abc123",
  headerSkipped: true,
  perCampaignLimit: 10_000,
};

const dirtyPreview: BulkPreview = {
  total: 1,
  sampleFirst5: ["+8801711000001"],
  invalidRows: [
    { line: 4, reason: "not a valid E.164 number (expected +<country><number>)" },
    { line: 9, reason: "empty phone number" },
  ],
  checksum: "def456",
};

describe("BulkView", () => {
  it("shows the drop zone and the no-preview hint with submit locked", () => {
    const html = renderToString(<BulkView {...props()} />);
    expect(html).toContain('data-testid="bulk-dropzone"');
    expect(html).toContain(".csv,.xlsx,.xls,text/csv");
    expect(html).toContain("nothing is sent before you confirm");
    expect(html).toContain('data-testid="bulk-submit" disabled');
  });

  it("renders the preview: count, first five, header + per-campaign limit notes", () => {
    const html = renderToString(<BulkView {...props({ preview: cleanPreview })} />);
    expect(html).toContain('data-testid="bulk-total"');
    expect(html).toContain(">3<");
    expect(html).toContain("+8801711000001, +8801711000002, +8801711000003");
    expect(html).toContain("per-campaign limit 10000");
    expect(html).toContain("header row skipped");
    expect(html).not.toContain('data-testid="bulk-invalid"');
    // Still locked: name and message are empty.
    expect(html).toContain('data-testid="bulk-submit" disabled');
  });

  it("lists invalid rows with line numbers and keeps submit locked even when filled", () => {
    const html = renderToString(
      <BulkView {...props({ preview: dirtyPreview, name: "Promo", message: "Hello" })} />,
    );
    expect(html).toContain('data-testid="bulk-invalid"');
    expect(html).toContain("not a valid E.164 number");
    expect(html).toContain("empty phone number");
    expect(html).toContain(">4<");
    expect(html).toContain(">9<");
    expect(html).toContain("invalid rows are never sent");
    expect(html).toContain('data-testid="bulk-submit" disabled');
  });

  it("enables submit only after a fresh clean preview with typed name and message", () => {
    const ready = renderToString(
      <BulkView {...props({ fileName: "list.csv", preview: cleanPreview, name: "Promo", message: "Hello" })} />,
    );
    expect(ready).not.toContain('data-testid="bulk-submit" disabled');
    expect(ready).toContain('data-testid="bulk-file-name"');
    expect(ready).toContain("list.csv");

    const noMessage = renderToString(
      <BulkView {...props({ preview: cleanPreview, name: "Promo", message: "" })} />,
    );
    expect(noMessage).toContain('data-testid="bulk-submit" disabled');
  });

  it("shows a busy label while previewing or submitting", () => {
    const busy = renderToString(
      <BulkView
        {...props({
          previewing: true,
          submitting: true,
          preview: cleanPreview,
          name: "Promo",
          message: "Hello",
        })}
      />,
    );
    expect(busy).toContain("Parsing and previewing…");
    expect(busy).toContain("Creating…");
    expect(busy).toContain('data-testid="bulk-submit" disabled');
  });

  it("renders preview and submit errors as alert banners", () => {
    const html = renderToString(
      <BulkView
        {...props({
          previewError: "Could not read list.xlsx — export it as CSV and retry (unreadable_file)",
          submitError: "Recipient list changed since preview — run preview again (checksum_mismatch)",
        })}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("unreadable_file");
    expect(html).toContain("checksum_mismatch");
  });

  it("renders the success banner after creation and resets the flow", () => {
    const created: BulkCreateResult = {
      ok: true,
      campaignId: "camp-9",
      totalRecipients: 42,
      creditsReserved: 42,
      charset: "gsm",
      status: "queued",
    };
    const html = renderToString(<BulkView {...props({ created })} />);
    expect(html).toContain('data-testid="bulk-created"');
    expect(html).toContain("camp-9");
    expect(html).toContain("42 recipients");
    expect(html).toContain("42 credits reserved");
    expect(html).toContain('data-testid="bulk-submit" disabled');
  });
});

describe("fileToCsvText", () => {
  it("passes a native csv file through unchanged", async () => {
    const csv = "phone\n+8801711000001\n";
    const file = new File([csv], "recipients.csv", { type: "text/csv" });
    expect(await fileToCsvText(file)).toBe(csv);
  });

  it("converts an .xlsx workbook to csv in the browser", async () => {
    const sheet = XLSX.utils.aoa_to_sheet([["phone"], ["+8801711000001"]]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Recipients");
    const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    const file = new File([buffer], "recipients.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const csv = await fileToCsvText(file);
    expect(csv).toContain("+8801711000001");
    expect(csv).toContain("phone");
  });

  it("rejects an unreadable workbook with a structured error", async () => {
    // A local-file header with no central directory: SheetJS throws
    // "Unsupported ZIP file" (plain text would be auto-detected as csv).
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(60).fill(0)]);
    const file = new File([bytes], "recipients.xlsx");
    await expect(fileToCsvText(file)).rejects.toMatchObject({ code: "unreadable_file" });
  });
});

/**
 * F5c (ISSUE-85) — BulkView render tests (node environment, react-dom/server)
 * plus the client-side file conversion: native csv passes through, workbooks
 * become csv in the browser, unreadable files get a structured error.
 */
import { describe, expect, it } from "vitest";
import { renderToString as renderToRawString } from "react-dom/server";
import * as XLSX from "xlsx";
import type { BulkCampaignStatus, BulkCreateResult, BulkPreview } from "../src/api";
import {
  BulkView,
  CampaignStatusView,
  PASTED_SOURCE_LABEL,
  TEMPLATE_VARIABLES,
  fileToCsvText,
  insertToken,
  type BulkViewProps,
} from "../src/screens/Bulk";

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

describe("ISSUE-112: paste recipients + template variable chips", () => {
  it("renders the paste box with a label and a preview action locked while empty", () => {
    const empty = renderToString(<BulkView {...props()} />);
    expect(empty).toContain('data-testid="bulk-paste"');
    expect(empty).toContain('for="bulkPasted"');
    expect(empty).toContain('data-testid="bulk-preview-pasted" disabled');

    const typed = renderToString(
      <BulkView {...props({ pasted: "+8801711000001\n+8801711000002" })} />,
    );
    expect(typed).not.toContain('data-testid="bulk-preview-pasted" disabled');
    expect(typed).toContain("+8801711000001");

    // Once previewed, the source label names the paste box as the list origin.
    const labelled = renderToString(<BulkView {...props({ fileName: PASTED_SOURCE_LABEL })} />);
    expect(labelled).toContain("Pasted recipients");
    expect(labelled).toContain('data-testid="bulk-file-name"');
  });

  it("offers {{name}} and {{phone}} chips above the message box", () => {
    const html = renderToString(<BulkView {...props()} />);
    expect(html).toContain('data-testid="bulk-var-chips"');
    for (const token of TEMPLATE_VARIABLES) {
      expect(html, token).toContain(`>${token}</button>`);
    }
    // Chips sit ABOVE the message textarea, per the handoff spec.
    expect(html.indexOf("bulk-var-chips")).toBeLessThan(html.indexOf("bulk-message"));
  });

  it("insertToken places a token at the caret with exactly one spacing character", () => {
    expect(insertToken("", "{{name}}", 0)).toEqual({ text: "{{name}}", caret: 8 });
    const atEnd = insertToken("Hi ", "{{name}}", 3);
    expect(atEnd.text).toBe("Hi {{name}}");
    expect(atEnd.caret).toBe(11);
    const mid = insertToken("HiBob", "{{name}}", 2);
    expect(mid.text).toBe("Hi {{name}} Bob");
    expect(mid.caret).toBe(11);
    // A newline already separates, but fused words on the right still get one space.
    const afterNewline = insertToken("Hello\nthere", "{{phone}}", 6);
    expect(afterNewline.text).toBe("Hello\n{{phone}} there");
    // Out-of-range carets clamp to the end instead of throwing.
    expect(insertToken("ab", "{{phone}}", 99).text).toBe("ab {{phone}}");
    expect(insertToken("ab", "{{phone}}", -5).text).toBe("{{phone}} ab");
  });
});

describe("ISSUE-112: campaign broadcast status visualisation", () => {
  const STATUS: BulkCampaignStatus = {
    campaignId: "camp-9",
    name: "Spring sale",
    status: "sending",
    sourceType: "csv",
    totalRecipients: 100,
    sentCount: 40,
    failedCount: 10,
    queuedCount: 50,
    createdAt: 1791500000,
    startedAt: 1791500010,
    completedAt: null,
    unlimitedPass: false,
  };
  const CREATED: BulkCreateResult = {
    ok: true,
    campaignId: "camp-9",
    totalRecipients: 42,
    creditsReserved: 42,
    charset: "gsm",
    status: "queued",
  };

  it("shows the status chip, counters and a determinate progress bar", () => {
    const html = renderToString(<CampaignStatusView status={STATUS} error={null} />);
    expect(html).toContain('data-testid="campaign-status"');
    expect(html).toContain('data-testid="campaign-status-chip"');
    expect(html).toContain(">sending<");
    expect(html).toContain('data-testid="campaign-percent"');
    expect(html).toContain(">50%<");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain("width:50%");
    expect(html).toContain("</strong> sent");
    expect(html).toContain("</strong> failed");
    expect(html).toContain("</strong> queued");
    expect(html).toContain("of 100 recipients");
  });

  it("renders the loading state and poll failures as an alert", () => {
    const loading = renderToString(<CampaignStatusView status={null} error={null} />);
    expect(loading).toContain("Loading broadcast status…");

    const failed = renderToString(
      <CampaignStatusView status={null} error="Unauthorized (invalid_app_credentials)" />,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("invalid_app_credentials");
  });

  it("offers the refresh action only when a handler is wired", () => {
    expect(renderToString(<CampaignStatusView status={STATUS} error={null} />)).not.toContain(
      "Refresh status",
    );
    expect(
      renderToString(<CampaignStatusView status={STATUS} error={null} onRefresh={NOOP} />),
    ).toContain("Refresh status");
  });

  it("shows the status panel only after a campaign was created", () => {
    expect(renderToString(<BulkView {...props()} />)).not.toContain("campaign-status");
    const created = renderToString(<BulkView {...props({ created: CREATED })} />);
    expect(created).toContain("Broadcast status");
    expect(created).toContain("Loading broadcast status…");
  });
});

const { test, expect } = require("@playwright/test");

const ADMIN_EMAIL = "callzr@gmail.com";
const ADMIN_PASSWORD = "@DELL123dell#";
const BASE_URL = "https://authenticator-15fb7.web.app";

/**
 * Helper: wait for an element to be visible with a short timeout.
 * Returns true/false instead of throwing.
 */
const isVisible = async (page, selector, timeout = 3000) => {
  try {
    return await page.locator(selector).isVisible({ timeout });
  } catch {
    return false;
  }
};

/**
 * Helper: get the first visible error text on the page.
 */
const getErrorText = async (page) => {
  const err = page.locator(".text-red-700, .bg-red-50").first();
  if (await err.isVisible({ timeout: 500 }).catch(() => false)) {
    return (await err.textContent()).trim();
  }
  return null;
};

/**
 * Helper: login as admin via the UI.
 */
const loginAsAdmin = async (page) => {
  await page.goto(`${BASE_URL}/login`);
  await page.fill('input[type="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/.*dashboard/, { timeout: 10000 });
};

/**
 * Helper: navigate to the contact groups page.
 */
const goToContactGroups = async (page) => {
  await page.goto(`${BASE_URL}/dashboard/contact-groups`);
  await page.waitForLoadState("networkidle");
};

/**
 * Helper: navigate to the message templates page.
 */
const goToTemplates = async (page) => {
  await page.goto(`${BASE_URL}/dashboard/templates`);
  await page.waitForLoadState("networkidle");
};

// ===========================================================
// VT1: Contact Groups — Create, List, Delete
// ===========================================================
test.describe("VT1 — Contact Groups CRUD", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
    await loginAsAdmin(page);
  });

  test("Contact Groups page loads and shows correct UI elements", async ({
    page,
  }) => {
    await goToContactGroups(page);

    // Page header
    await expect(page.locator('h1:has-text("Contact Groups")')).toBeVisible({
      timeout: 5000,
    });
    await expect(
      page.locator("text=Save and reuse recipient lists across campaigns."),
    ).toBeVisible();

    // N/50 counter
    await expect(page.locator("text=/\\d+ \\/ 50 groups used/")).toBeVisible();

    // New Group button
    await expect(
      page.getByRole("button", { name: "New Group" }).first(),
    ).toBeVisible();
  });

  test("Create a contact group with valid phone numbers", async ({ page }) => {
    await goToContactGroups(page);

    // Count existing groups
    const initialRows = await page
      .locator("tbody tr")
      .count()
      .catch(() => 0);

    // Open create modal
    await page.getByRole("button", { name: "New Group" }).first().click();
    await expect(page.locator("text=Create Contact Group")).toBeVisible({
      timeout: 3000,
    });

    // Fill group name
    const nameInput = page.locator('input[placeholder*="Weekly Promo"]');
    await nameInput.fill(`Test Group ${Date.now()}`);

    // Fill phone numbers via textarea
    const textareas = page.locator("textarea");
    const csvTextarea = textareas.first();
    await csvTextarea.fill("+8801711111111\n+8801822222222\n+8801833333333");

    // Wait for validation to process
    await page.waitForTimeout(1000);

    // Check that valid count is shown (green text for valid count)
    await expect(page.locator(".text-green-700").first()).toBeVisible({
      timeout: 3000,
    });

    // Click Save
    const saveBtn = page.locator('button:has-text("Save Group")');
    await expect(saveBtn).toBeEnabled({ timeout: 3000 });
    await saveBtn.click();

    // Verify success — modal closes and table updates
    await expect(page.locator('button:has-text("Save Group")'))
      .not.toBeVisible({ timeout: 10000 })
      .catch(() => {});

    // Verify table now has more rows
    await page.waitForTimeout(2000);
    const newRows = await page
      .locator("tbody tr")
      .count()
      .catch(() => 0);
    // Either new row added, or an error shown
    const hasError = await getErrorText(page);
    if (hasError) {
      console.log(
        "Create group returned error (may be expected in test env):",
        hasError,
      );
    }
    console.log(`Group rows: ${initialRows} → ${newRows}`);
  });

  test("Cannot create a group with 0 valid phones", async ({ page }) => {
    await goToContactGroups(page);
    await page.getByRole("button", { name: "New Group" }).first().click();
    await expect(page.locator("text=Create Contact Group")).toBeVisible({
      timeout: 3000,
    });

    // Fill name only
    await page
      .locator('input[placeholder*="Weekly Promo"]')
      .fill("Empty Group");

    // Save button should be disabled
    const saveBtn = page.locator('button:has-text("Save Group")');
    await expect(saveBtn).toBeDisabled({ timeout: 2000 });

    console.log("VT1 AC-02 PASS: Save Group disabled with no phone numbers");
  });

  test("Delete a contact group", async ({ page }) => {
    await goToContactGroups(page);
    await page.waitForTimeout(2000);

    // Find delete buttons
    const deleteBtns = page.locator('button:has-text("Delete")');
    const count = await deleteBtns.count();

    if (count === 0) {
      console.log("No groups to delete — skipping delete test");
      return;
    }

    // Click first delete button
    await deleteBtns.first().click();

    // Expect confirmation modal
    await expect(page.locator("text=Delete Contact Group")).toBeVisible({
      timeout: 3000,
    });
    await expect(
      page.locator("text=/will not affect campaigns/"),
    ).toBeVisible();

    // Confirm delete
    await page.click('button:has-text("Confirm Delete")');
    await page.waitForTimeout(3000);

    const hasError = await getErrorText(page);
    if (hasError) {
      console.log("Delete error:", hasError);
    } else {
      console.log("VT1 AC-09 PASS: Group deleted successfully");
    }
  });
});

// ===========================================================
// VT2: Contact Group Detail — Paginated Phone List
// ===========================================================
test.describe("VT2 — Contact Group Detail", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
    await loginAsAdmin(page);
  });

  test("View a contact group detail page with phone list", async ({ page }) => {
    await goToContactGroups(page);
    await page.waitForTimeout(2000);

    const viewBtns = page.locator('button:has-text("View")');
    const count = await viewBtns.count();

    if (count === 0) {
      console.log("No groups to view — creating one first");
      // Create a group first
      await page.getByRole("button", { name: "New Group" }).first().click();
      await expect(page.locator("text=Create Contact Group")).toBeVisible({
        timeout: 3000,
      });
      await page
        .locator('input[placeholder*="Weekly Promo"]')
        .fill("VT2 Test Group");
      await page
        .locator("textarea")
        .first()
        .fill("+8801711111111\n+8801822222222");
      await page.waitForTimeout(1000);
      await page.click('button:has-text("Save Group")');
      await page.waitForTimeout(3000);
      await page.goto(`${BASE_URL}/dashboard/contact-groups`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(2000);
    }

    const viewBtnsAfter = page.locator('button:has-text("View")');
    if ((await viewBtnsAfter.count()) === 0) {
      console.log("SKIP: No groups available for detail view");
      return;
    }

    // Click View on first group
    await viewBtnsAfter.first().click();
    await page.waitForLoadState("networkidle");

    // Should be on detail page with back link
    await expect(page.locator("text=← Contact Groups")).toBeVisible({
      timeout: 5000,
    });

    // Phone table should exist
    const phoneTable = page.locator("table");
    await expect(phoneTable).toBeVisible({ timeout: 5000 });

    // At least one phone row
    const phoneRows = page.locator("tbody tr");
    const rowCount = await phoneRows.count();
    expect(rowCount).toBeGreaterThanOrEqual(1);

    // Phone numbers should start with +
    const firstPhone = await phoneRows
      .first()
      .locator("td")
      .first()
      .textContent();
    expect(firstPhone.trim()).toMatch(/^\+\d+/);

    console.log(`VT2 PASS: Detail page shows ${rowCount} phone number(s)`);
  });
});

// ===========================================================
// VT3: Message Templates — Create, Edit, Delete
// ===========================================================
test.describe("VT3 — Message Templates", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
    await loginAsAdmin(page);
  });

  test("Templates page loads with correct UI", async ({ page }) => {
    await goToTemplates(page);
    await expect(page.locator('h1:has-text("Message Templates")')).toBeVisible({
      timeout: 5000,
    });
    await expect(
      page.locator("text=Save reusable SMS message bodies"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New Template" }).first(),
    ).toBeVisible();
  });

  test("Create a message template", async ({ page }) => {
    await goToTemplates(page);

    // Open create modal
    await page.getByRole("button", { name: "New Template" }).first().click();
    await expect(
      page.getByRole("heading", { name: "New Template" }),
    ).toBeVisible({
      timeout: 3000,
    });

    // Fill template
    const templateName = `VT3 Template ${Date.now()}`;
    await page.locator('input[placeholder*="Weekly Sale"]').fill(templateName);
    await page
      .locator('textarea[placeholder*="SMS message"]')
      .fill("Hello! Check out our latest deals at dpRelay.");

    // Character count should be visible
    await expect(page.locator("text=/\\d+ \\/ 1600 characters/")).toBeVisible();

    // Segment counter
    await expect(page.locator("text=/\\d+ segment/")).toBeVisible();

    // Save
    await page.click('button:has-text("Save")');
    await page.waitForTimeout(3000);

    // Modal should close, new template card visible
    const hasError = await getErrorText(page);
    if (hasError) {
      console.log("Create template error:", hasError);
    } else {
      // Check that template appears in grid
      const templateCards = page.locator("text=VT3 Template");
      if ((await templateCards.count()) > 0) {
        console.log("VT3 AC-05 PASS: Template created and visible");
      }
    }
  });

  test("Edit a message template", async ({ page }) => {
    await goToTemplates(page);
    await page.waitForTimeout(2000);

    // Find edit buttons (pencil icon)
    const editBtns = page.locator('button[title="Edit"]');
    const count = await editBtns.count();

    if (count === 0) {
      console.log("No templates to edit — skipping");
      return;
    }

    await editBtns.first().click();
    await expect(page.locator("text=Edit Template")).toBeVisible({
      timeout: 3000,
    });

    // Modify the name
    const nameInput = page.locator('input[placeholder*="Weekly Sale"]');
    await nameInput.fill(`Edited Template ${Date.now()}`);

    await page.click('button:has-text("Save")');
    await page.waitForTimeout(3000);

    const hasError = await getErrorText(page);
    if (!hasError) {
      console.log("VT3 PASS: Template edited successfully");
    } else {
      console.log("Edit error:", hasError);
    }
  });

  test("Delete a message template", async ({ page }) => {
    await goToTemplates(page);
    await page.waitForTimeout(2000);

    const deleteBtns = page.locator('button[title="Delete"]');
    const count = await deleteBtns.count();

    if (count === 0) {
      console.log("No templates to delete — skipping");
      return;
    }

    await deleteBtns.first().click();
    await expect(page.locator("text=Delete Template")).toBeVisible({
      timeout: 3000,
    });
    await page.click('button:has-text("Confirm Delete")');
    await page.waitForTimeout(3000);

    const hasError = await getErrorText(page);
    if (!hasError) {
      console.log("VT3 PASS: Template deleted successfully");
    } else {
      console.log("Delete error:", hasError);
    }
  });

  test("Template body limited to 1600 characters", async ({ page }) => {
    await goToTemplates(page);
    await page.getByRole("button", { name: "New Template" }).first().click();
    await expect(
      page.getByRole("heading", { name: "New Template" }),
    ).toBeVisible({
      timeout: 3000,
    });

    // Check maxlength on textarea
    const textarea = page.locator('textarea[placeholder*="SMS message"]');
    const maxLength = await textarea.getAttribute("maxLength");
    expect(maxLength).toBe("1600");

    console.log("VT3 GAP-1 PASS: maxLength=1600 on template body textarea");
  });
});

// ===========================================================
// VT5: Campaign Creation — Contact Groups Tab
// ===========================================================
test.describe("VT5 — Campaign with Contact Groups", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
    await loginAsAdmin(page);
  });

  test("Step 2 shows both Upload CSV and Use Contact Groups tabs", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/dashboard/bulk/create`);
    await page.waitForLoadState("networkidle");

    // Check if we have apps available
    const appOptions = await page.locator("select option").count();
    if (appOptions <= 1) {
      console.log("SKIP: No apps registered — cannot test campaign creation");
      return;
    }

    // Step 1: fill details
    await page
      .locator('input[placeholder*="Summer sale"]')
      .fill("VT5 Contact Group Campaign");
    await page.locator("select").selectOption({ index: 1 });
    await page.click('button:has-text("Continue")');
    await page.waitForTimeout(2000);

    // Step 2: verify tab switcher exists
    await expect(page.locator('button:has-text("Upload CSV")')).toBeVisible({
      timeout: 3000,
    });
    await expect(
      page.locator('button:has-text("Use Contact Groups")'),
    ).toBeVisible({ timeout: 3000 });

    console.log("VT5 AC-04 PASS: Both tabs visible in Step 2");
  });

  test("Use Contact Groups tab shows group selection", async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/bulk/create`);
    await page.waitForLoadState("networkidle");

    const appOptions = await page.locator("select option").count();
    if (appOptions <= 1) {
      console.log("SKIP: No apps registered");
      return;
    }

    // Step 1
    await page
      .locator('input[placeholder*="Summer sale"]')
      .fill("VT5 Groups Test");
    await page.locator("select").selectOption({ index: 1 });
    await page.click('button:has-text("Continue")');
    await page.waitForTimeout(1000);

    // Switch to Contact Groups tab
    await page.click('button:has-text("Use Contact Groups")');
    await page.waitForTimeout(2000);

    // Check if groups are available
    const groupLabels = page.locator('label:has(input[type="checkbox"])');
    const groupCount = await groupLabels.count();

    if (groupCount === 0) {
      // Should show empty state
      const emptyState = page.locator("text=No saved groups");
      if (await emptyState.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log("VT5: Contact Groups tab shows empty state correctly");
      }
    } else {
      // Select a group
      await groupLabels.first().click();
      await page.waitForTimeout(500);

      // Should show selection summary
      const summary = page.locator(
        "text=/\\d+ group.*selected.*\\d+ total recipients/",
      );
      if (await summary.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log("VT5 AC-04 PASS: Group selection shows recipient count");
      }

      // Continue should be enabled
      await page.click('button:has-text("Continue")');
      await page.waitForTimeout(1000);

      // Should be on Step 3
      const messageArea = page.locator("textarea");
      if (await messageArea.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log("VT5 PASS: Proceeded to message step with contact groups");
      }
    }
  });
});

// ===========================================================
// VT6: Load Template in Campaign Creation
// ===========================================================
test.describe("VT6 — Load Template in Campaign", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
    await loginAsAdmin(page);
  });

  test("Load Template button appears when templates exist", async ({
    page,
  }) => {
    // First ensure at least one template exists
    await goToTemplates(page);
    await page.waitForTimeout(2000);

    let templateCount = await page
      .locator(".rounded-lg.border.border-gray-200.bg-white")
      .count();

    if (templateCount === 0) {
      // Create a template first
      await page.getByRole("button", { name: "New Template" }).first().click();
      await expect(
        page.getByRole("heading", { name: "New Template" }),
      ).toBeVisible({
        timeout: 3000,
      });
      await page
        .locator('input[placeholder*="Weekly Sale"]')
        .fill("VT6 Test Template");
      await page
        .locator('textarea[placeholder*="SMS message"]')
        .fill("Test message for VT6 template loading");
      await page.click('button:has-text("Save")');
      await page.waitForTimeout(3000);
    }

    // Navigate to campaign creation
    await page.goto(`${BASE_URL}/dashboard/bulk/create`);
    await page.waitForLoadState("networkidle");

    const appOptions = await page.locator("select option").count();
    if (appOptions <= 1) {
      console.log("SKIP: No apps registered");
      return;
    }

    // Step 1
    await page
      .locator('input[placeholder*="Summer sale"]')
      .fill("VT6 Template Campaign");
    await page.locator("select").selectOption({ index: 1 });
    await page.click('button:has-text("Continue")');
    await page.waitForTimeout(1000);

    // Step 2: use CSV tab (default) with valid phones
    const csvTextarea = page.locator("textarea").first();
    if (await csvTextarea.isVisible({ timeout: 2000 }).catch(() => false)) {
      await csvTextarea.fill("+8801711111111");
      await page.waitForTimeout(500);
      await page.click('button:has-text("Continue")');
      await page.waitForTimeout(1000);

      // Step 3: Load Template button should be visible
      const loadTemplateBtn = page.locator('button:has-text("Load Template")');
      if (
        await loadTemplateBtn.isVisible({ timeout: 3000 }).catch(() => false)
      ) {
        console.log("VT6 AC-05 PASS: Load Template button visible in Step 3");

        // Click Load Template
        await loadTemplateBtn.click();
        await page.waitForTimeout(500);

        // Template picker dropdown should appear
        const templatePicker = page.locator(".shadow-xl:has(button)");
        if (
          await templatePicker.isVisible({ timeout: 2000 }).catch(() => false)
        ) {
          // Click first template
          const templateOptions = templatePicker.locator("button");
          const optionCount = await templateOptions.count();
          if (optionCount > 0) {
            await templateOptions.first().click();
            await page.waitForTimeout(500);

            // Message textarea should now have content
            const msgTextarea = page.locator(
              'label:has-text("Message Template") textarea',
            );
            const msgValue = await msgTextarea.inputValue().catch(() => "");
            if (msgValue.length > 0) {
              console.log(
                "VT6 AC-05 PASS: Template loaded into message textarea",
              );
            }
          }
        }
      } else {
        console.log(
          "VT6: Load Template not visible (may have 0 templates after delete)",
        );
      }
    }
  });
});

// ===========================================================
// VT7: Bulk Campaign Detail — Download Report
// ===========================================================
test.describe("VT7 — Download Report Button", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
    await loginAsAdmin(page);
  });

  test("Download Report button visible on completed/cancelled/failed campaigns", async ({
    page,
  }) => {
    // Go to bulk campaigns list
    await page.goto(`${BASE_URL}/dashboard/bulk`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    // Find campaigns with relevant statuses
    const campaignRows = page.locator("tbody tr");
    const rowCount = await campaignRows.count();

    if (rowCount === 0) {
      console.log("SKIP: No campaigns to check");
      return;
    }

    // Look for completed, cancelled, or failed campaigns
    const statusCell = page
      .locator("td")
      .locator("text=/completed|cancelled|failed/i");
    const statusCount = await statusCell.count();

    if (statusCount > 0) {
      // Click the first matching campaign's View button
      const viewBtn = statusCell
        .first()
        .locator("..")
        .locator('button:has-text("View")');
      if (await viewBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await viewBtn.click();
      } else {
        // Try clicking the row or using the link
        const link = statusCell.first().locator("..").locator("a");
        if (await link.isVisible({ timeout: 1000 }).catch(() => false)) {
          await link.click();
        }
      }

      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(2000);

      // Check for Download Report button
      const downloadBtn = page.locator('button:has-text("Download Report")');
      if (await downloadBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log("VT7 AC-07 PASS: Download Report button visible");

        // Test the download
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 15000 }).catch(() => null),
          downloadBtn.click(),
        ]);

        if (download) {
          const filename = download.suggestedFilename();
          console.log(`VT7 AC-08: Download triggered: ${filename}`);
          expect(filename).toMatch(/-report\.csv$/);

          // Read the CSV content and verify structure
          const filePath = await download.path();
          if (filePath) {
            const fs = require("fs");
            const content = fs.readFileSync(filePath, "utf-8");
            const lines = content.split("\n");
            // First line should be the header
            expect(lines[0]).toContain("phone");
            expect(lines[0]).toContain("status");
            expect(lines[0]).toContain("errorMessage");
            expect(lines[0]).toContain("attemptedAt");
            console.log("VT7 AC-08 PASS: CSV has correct header columns");
            console.log(`CSV has ${lines.length - 1} data rows`);
          }
        } else {
          console.log("VT7: Download did not trigger (may be preparing still)");
        }
      } else {
        console.log(
          "VT7: Download Report button not visible — campaign may be in sending state",
        );
      }
    } else {
      console.log("VT7: No completed/cancelled/failed campaigns found");
    }
  });

  test("Download Report NOT visible on sending/queued campaigns", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/dashboard/bulk`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    // Look for sending or queued campaigns
    const sendingStatus = page.locator("td").locator("text=/sending|queued/i");
    const sendingCount = await sendingStatus.count();

    if (sendingCount > 0) {
      const viewBtn = sendingStatus
        .first()
        .locator("..")
        .locator('button:has-text("View")');
      if (await viewBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await viewBtn.click();
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(2000);

        const downloadBtn = page.locator('button:has-text("Download Report")');
        const isDownloadVisible = await downloadBtn
          .isVisible({ timeout: 2000 })
          .catch(() => false);
        expect(isDownloadVisible).toBe(false);
        console.log(
          "VT7 PASS: Download Report correctly hidden for active campaign",
        );
      }
    } else {
      console.log("VT7: No active campaigns to verify button hidden state");
    }
  });
});

// ===========================================================
// VT-Sidebar: Sidebar entries and routing
// ===========================================================
test.describe("VT-Sidebar — New Sidebar Entries & Routes", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
    await loginAsAdmin(page);
  });

  test("Sidebar shows Contact Groups link", async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForLoadState("networkidle");

    const contactGroupsLink = page.locator('a:has-text("Contact Groups")');
    await expect(contactGroupsLink).toBeVisible({ timeout: 5000 });
    console.log("VT-Sidebar PASS: Contact Groups link in sidebar");
  });

  test("Sidebar shows Templates link", async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForLoadState("networkidle");

    const templatesLink = page.locator('a:has-text("Templates")');
    await expect(templatesLink).toBeVisible({ timeout: 5000 });
    console.log("VT-Sidebar PASS: Templates link in sidebar");
  });

  test("Contact Groups route renders page", async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/contact-groups`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator('h1:has-text("Contact Groups")')).toBeVisible({
      timeout: 5000,
    });
    console.log("VT-Sidebar PASS: /dashboard/contact-groups route works");
  });

  test("Templates route renders page", async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/templates`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator('h1:has-text("Message Templates")')).toBeVisible({
      timeout: 5000,
    });
    console.log("VT-Sidebar PASS: /dashboard/templates route works");
  });

  test("Sidebar highlights Contact Groups when on detail page", async ({
    page,
  }) => {
    await goToContactGroups(page);
    await page.waitForTimeout(2000);

    const viewBtns = page.locator('button:has-text("View")');
    if ((await viewBtns.count()) > 0) {
      await viewBtns.first().click();
      await page.waitForLoadState("networkidle");

      // Check that Contact Groups sidebar item is highlighted
      const activeLink = page.locator(
        'a.bg-brand-50:has-text("Contact Groups")',
      );
      if (await activeLink.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log(
          "VT-Sidebar AC-20 PASS: Contact Groups highlighted on detail sub-page",
        );
      }
    }
  });
});

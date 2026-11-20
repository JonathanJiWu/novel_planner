// Browser journeys against the single-user local server (web_app.py).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  addIdea, download, launchBrowser, newPage, pdfText, startLocalServer, statusText, toastText, waitForSaved,
} from "./harness.mjs";

let server;
let browser;

before(async () => {
  server = await startLocalServer();
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await server?.stop();
});

async function open() {
  const { context, page } = await newPage(browser);
  await page.goto(server.url);
  await waitForSaved(page);
  return { context, page };
}

test("planning work autosaves and survives a reload", async () => {
  const { context, page } = await open();
  await page.fill("#project-title", "The Quiet Archive");
  await addIdea(page, "A lighthouse keeper who collects lost letters.", "Character");
  await page.click("[data-open-stage]");
  const card = page.locator('.question-card[data-question-id="story_identity"]');
  await card.locator("textarea").fill("A librarian finds a forbidden record.\nIt names her mother.");
  await card.locator("select").nth(1).selectOption("settled");
  await waitForSaved(page);
  assert.match(await page.textContent("#progress-detail"), /^1 of \d+ essential decisions settled$/);

  await page.reload();
  await waitForSaved(page);
  assert.equal(await page.inputValue("#project-title"), "The Quiet Archive");
  assert.equal(await page.locator(".idea-card").count(), 1);
  assert.equal(await page.locator(".idea-category-select").inputValue(), "Character");
  await page.click("[data-open-stage]");
  assert.equal(
    await page.locator('.question-card[data-question-id="story_identity"] textarea').inputValue(),
    "A librarian finds a forbidden record.\nIt names her mother.",
  );
  assert.deepEqual(page.errors, []);
  await context.close();
});

test("clearing the project name does not stop other changes from saving", async () => {
  const { context, page } = await open();
  await page.fill("#project-title", "");
  await addIdea(page, "Saved even though the title is blank.");
  await waitForSaved(page);
  await page.reload();
  await waitForSaved(page);
  assert.equal(await page.inputValue("#project-title"), "Untitled novel");
  assert.ok(await page.locator(".idea-text", { hasText: "Saved even though the title is blank." }).count());
  await context.close();
});

test("importing files skips empty ones and splits long ones", async () => {
  const { context, page } = await open();
  const longText = Array.from({ length: 2500 }, (_, index) => `Paragraph ${index}: ${"words ".repeat(18)}`).join("\n\n");
  await page.setInputFiles("#material-file", [
    { name: "empty.txt", mimeType: "text/plain", buffer: Buffer.from(" \n") },
    { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Harbor\nThe harbor closes at dusk.") },
    { name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from(longText) },
  ]);
  const message = await toastText(page);
  assert.match(message, /^Imported \d+ materials for review\. Not imported: empty\.txt is empty\.$/);
  await waitForSaved(page);
  await page.click("#overview-button");
  await page.selectOption("#overview-filter", "materials");
  const sources = await page.locator(".overview-meta").allTextContents();
  assert.ok(sources.some((meta) => meta.includes("notes.md")));
  assert.ok(sources.some((meta) => /draft\.txt \(part 1 of [2-9]\)/.test(meta)));
  await context.close();
});

test("a stale tab is told about the conflict instead of overwriting newer work", async () => {
  const first = await open();
  const second = await open();

  await first.page.fill("#project-title", "Saved by the first tab");
  await waitForSaved(first.page);

  await addIdea(second.page, "Typed in the stale second tab");
  await second.page.waitForSelector("#sync-banner:not([hidden])");
  assert.match(await statusText(second.page), /resolve the conflict/);

  await second.page.click("#conflict-load");
  assert.equal(await second.page.inputValue("#project-title"), "Saved by the first tab");
  assert.equal(await second.page.locator(".idea-text", { hasText: "Typed in the stale second tab" }).count(), 0);

  // After reloading the saved version, editing works normally again.
  await second.page.fill("#project-title", "Edited after resolving");
  await waitForSaved(second.page);

  // The first tab is now stale; it can choose to keep its own version.
  await addIdea(first.page, "Keep this idea");
  await first.page.waitForSelector("#sync-banner:not([hidden])");
  await first.page.click("#conflict-keep");
  await waitForSaved(first.page);
  await second.page.reload();
  await waitForSaved(second.page);
  assert.ok(await second.page.locator(".idea-text", { hasText: "Keep this idea" }).count());
  await first.context.close();
  await second.context.close();
});

test("a save started while another is in flight waits instead of overlapping", async () => {
  const { context, page } = await open();
  const statuses = [];
  await page.route("**/api/project", async (route) => {
    if (route.request().method() === "PUT") await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  page.on("response", (response) => {
    if (response.request().method() === "PUT") statuses.push(response.status());
  });
  await page.fill("#project-title", "First edit");
  await page.waitForFunction(() => document.querySelector("#save-state").textContent.includes("Saving"));
  await page.fill("#project-title", "Second edit"); // arrives while the first save is in flight
  const markdown = (await download(page, "#export-markdown")).toString("utf8"); // exporting saves first
  await waitForSaved(page);
  assert.equal(await page.isVisible("#sync-banner"), false, "no false conflict");
  assert.ok(statuses.length >= 2);
  assert.ok(statuses.every((status) => status === 200), JSON.stringify(statuses));
  assert.ok(markdown.startsWith("# Second edit\n"), "the export includes the latest edit");
  await context.close();
});

test("closing the page with unsaved changes asks for confirmation", async () => {
  const { context, page } = await open();
  await page.fill("#project-title", "Not saved yet");
  let prompted = false;
  page.on("dialog", async (dialog) => {
    prompted = dialog.type() === "beforeunload";
    await dialog.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(prompted, true);
  await context.close();
});

test("the overview lists open decisions and links back to the planner", async () => {
  const { context, page } = await open();
  await page.click("[data-open-stage]");
  const card = page.locator('.question-card[data-question-id="story_seed"]');
  await card.locator("textarea").fill("A lighthouse that remembers every ship.");
  await waitForSaved(page);
  await page.click("#overview-button");
  await page.selectOption("#overview-filter", "open");
  const openCard = page.locator(".overview-card", { hasText: "A lighthouse that remembers every ship." });
  assert.equal(await openCard.count(), 1);
  assert.ok(await page.locator(".overview-card", { hasText: "Not yet answered." }).count(), "unresolved essentials are listed");
  await openCard.locator("button", { hasText: "Open in planner" }).click();
  await page.waitForSelector("#question-page.active");
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), await card.locator("h3").textContent());
  await context.close();
});

test("exports download the saved plan as Markdown and PDF", async () => {
  const { context, page } = await open();
  await page.fill("#project-title", "Export Novel");
  await page.click("[data-open-stage]");
  await page.locator('.question-card[data-question-id="story_identity"] textarea').fill("林黛玉 writes poems — Пушкин reads them.");
  const markdown = (await download(page, "#export-markdown")).toString("utf8");
  assert.ok(markdown.startsWith("# Export Novel\n"));
  assert.ok(markdown.includes("林黛玉 writes poems — Пушкин reads them."));
  const text = await pdfText(await download(page, "#export-pdf"));
  assert.ok(text.includes("Export Novel"));
  assert.ok(text.includes("林黛玉 writes poems — Пушкин reads them."), "non-Latin text survives in the PDF");
  await context.close();
});

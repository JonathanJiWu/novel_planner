// Browser journeys against the static GitHub Pages build (browser-only profiles in IndexedDB).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  PASSWORD, addIdea, download, launchBrowser, logIn, newPage, register, startStaticServer, waitForSaved,
} from "./harness.mjs";

let server;
let browser;

before(async () => {
  server = await startStaticServer();
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await server?.stop();
});

test("a project saved before profiles existed is restored into the first profile", async () => {
  const { context, page } = await newPage(browser);
  await page.goto(server.app);
  await page.waitForSelector("#auth-page:not([hidden])"); // start-up has finished
  await page.evaluate(() => localStorage.setItem("novel-architect-project", JSON.stringify({
    title: "My Older Demo Novel",
    answers: { story_seed: "A lighthouse that remembers ships" },
    ideas: [{ id: "legacy-1", text: "legacy idea", category: "Story" }],
    materials: [],
    theme: "paper",
  })));
  await page.reload();
  await register(page, "demo@example.com");
  assert.equal(await page.inputValue("#project-title"), "My Older Demo Novel");
  assert.equal(await page.locator(".idea-card").count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "paper");
  assert.equal(await page.evaluate(() => localStorage.getItem("novel-architect-project")), null);
  assert.ok(await page.evaluate(() => localStorage.getItem("novel-architect-project-migrated")), "a backup copy is kept");

  // A second profile does not receive the same project again.
  await page.click("#sign-out");
  await register(page, "second@example.com");
  assert.equal(await page.inputValue("#project-title"), "My Novel");
  await context.close();
});

test("profiles are explained honestly and keep projects separate", async () => {
  const { context, page } = await newPage(browser);
  await page.goto(server.app);
  await page.waitForSelector("#auth-page:not([hidden])");
  assert.match(await page.textContent("#auth-intro"), /in this browser only/);
  assert.equal(await page.isVisible("#magic-link"), false);
  assert.equal(await page.isVisible(".oauth-actions"), false);

  await register(page, "writer@example.com");
  await page.fill("#project-title", "Browser-only novel");
  await addIdea(page, "Stored in IndexedDB");
  await waitForSaved(page);
  assert.equal((await page.textContent("#save-state")).trim(), "Saved in this browser");

  await page.click("#sign-out");
  await page.waitForSelector("#auth-page:not([hidden])");
  await page.fill("#auth-email", "writer@example.com");
  await page.fill("#auth-password", "wrong-password");
  await page.click("#sign-in");
  await page.waitForFunction(() => document.querySelector("#auth-message").classList.contains("error"));

  await logIn(page, "writer@example.com", PASSWORD);
  assert.equal(await page.inputValue("#project-title"), "Browser-only novel");
  await page.reload();
  await waitForSaved(page);
  assert.equal(await page.locator(".idea-text", { hasText: "Stored in IndexedDB" }).count(), 1);
  await context.close();
});

test("two tabs of the same browser profile do not overwrite each other silently", async () => {
  const { context, page: first } = await newPage(browser);
  await first.goto(server.app);
  await register(first, "tabs@example.com");
  const second = await context.newPage();
  await second.goto(server.app);
  await waitForSaved(second);

  await first.fill("#project-title", "From the first tab");
  await waitForSaved(first);
  await second.fill("#project-title", "From the second tab");
  await second.waitForSelector("#sync-banner:not([hidden])");
  await second.click("#conflict-load");
  assert.equal(await second.inputValue("#project-title"), "From the first tab");
  await context.close();
});

test("exports produce the full blueprint and a printable plan", async () => {
  const { context, page } = await newPage(browser);
  await page.goto(server.app);
  await register(page, "export@example.com");
  await page.fill("#project-title", "Printable Novel");
  await page.click("[data-open-stage]");
  await page.locator('.question-card[data-question-id="story_identity"] textarea').fill("Line one\nLine two");
  assert.equal((await page.textContent("#export-pdf")).trim(), "↓  Print or save as PDF");

  const markdown = (await download(page, "#export-markdown")).toString("utf8");
  assert.ok(markdown.startsWith("# Printable Novel\n"));
  assert.ok(markdown.includes("### Stage A — Story Identity"));
  assert.ok(markdown.includes("  - Line one\n    Line two\n"));

  await page.evaluate(() => {
    window.__printed = [];
    window.print = () => window.__printed.push(document.body.classList.contains("printing-plan"));
  });
  await page.click("#export-pdf");
  await page.waitForFunction(() => window.__printed.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__printed), [true]);
  const printView = await page.textContent("#print-view");
  assert.ok(printView.includes("Printable Novel"));
  assert.ok(printView.includes("Stage J — Continuity & Readiness"));
  assert.ok(printView.includes("Line one\nLine two"));
  await context.close();
});

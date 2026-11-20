// Browser journeys against the static GitHub Pages build. Visitors plan right
// away (saved in this browser); optional profiles also live only in this browser.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  PASSWORD, addIdea, signOut, download, launchBrowser, logIn, newPage, openSignIn, register, startStaticServer,
  statusText, waitForSaved,
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

async function open(context) {
  const page = await context.newPage();
  await page.goto(server.app);
  await waitForSaved(page);
  return page;
}

test("the demo opens straight into planning, with work kept in this browser", async () => {
  const { context, page } = await newPage(browser);
  await page.goto(server.app);
  await waitForSaved(page);
  assert.equal(await statusText(page), "Saved in this browser");
  assert.equal(await page.isVisible("#auth-dialog"), false, "no sign-in wall");
  await page.fill("#project-title", "Browser-only novel");
  await addIdea(page, "Stored in IndexedDB");
  await waitForSaved(page);
  await page.reload();
  await waitForSaved(page);
  assert.equal(await page.inputValue("#project-title"), "Browser-only novel");
  assert.equal(await page.locator(".idea-text", { hasText: "Stored in IndexedDB" }).count(), 1);
  assert.deepEqual(page.errors, []);
  await context.close();
});

test("a project saved by the first version of the demo is restored, and moves into a new profile", async () => {
  const { context, page } = await newPage(browser);
  await page.goto(server.app);
  await waitForSaved(page);
  await page.evaluate(() => localStorage.setItem("novel-architect-project", JSON.stringify({
    title: "My Older Demo Novel",
    answers: { story_seed: "A lighthouse that remembers ships" },
    ideas: [{ id: "legacy-1", text: "legacy idea", category: "Story" }],
    materials: [],
    theme: "paper",
  })));
  await page.evaluate(() => new Promise((resolve) => {
    const request = indexedDB.open("novel-architect-auth", 1);
    request.onsuccess = () => {
      const transaction = request.result.transaction("projects", "readwrite");
      transaction.objectStore("projects").delete("guest");
      transaction.oncomplete = () => resolve();
    };
  }));
  await page.reload();
  await waitForSaved(page);
  assert.equal(await page.inputValue("#project-title"), "My Older Demo Novel", "restored without signing in");
  assert.equal(await page.locator(".idea-card").count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "paper");
  assert.ok(await page.evaluate(() => localStorage.getItem("novel-architect-project-migrated")), "a backup copy is kept");

  await register(page, "demo@example.com");
  assert.equal(await page.inputValue("#project-title"), "My Older Demo Novel", "the work moves into the profile");
  await signOut(page);
  assert.equal(await page.inputValue("#project-title"), "My Novel", "a fresh page after signing out");
  await register(page, "second@example.com");
  assert.equal(await page.inputValue("#project-title"), "My Novel", "a second profile does not receive it again");
  await context.close();
});

test("profiles are explained honestly and keep projects separate", async () => {
  const { context, page } = await newPage(browser);
  await page.goto(server.app);
  await waitForSaved(page);
  await openSignIn(page);
  assert.match(await page.textContent("#auth-intro"), /in this browser only/);
  assert.equal(await page.isVisible("#magic-link"), false);
  assert.equal(await page.isVisible(".oauth-actions"), false);
  await page.click("#auth-continue");

  await page.fill("#project-title", "Profile novel");
  await register(page, "writer@example.com");
  assert.equal(await statusText(page), "Saved in this browser");
  await signOut(page);

  await openSignIn(page);
  await page.fill("#auth-email", "writer@example.com");
  await page.fill("#auth-password", "wrong-password");
  await page.click("#sign-in");
  await page.waitForFunction(() => document.querySelector("#auth-message").classList.contains("error"));
  await logIn(page, "writer@example.com", PASSWORD);
  assert.equal(await page.inputValue("#project-title"), "Profile novel");
  await page.reload();
  await waitForSaved(page);
  assert.equal(await page.inputValue("#project-title"), "Profile novel");
  await context.close();
});

test("two tabs in the same browser do not overwrite each other silently", async () => {
  const { context } = await newPage(browser);
  const first = await open(context);
  const second = await open(context);
  await first.fill("#project-title", "From the first tab");
  await waitForSaved(first);
  await second.fill("#project-title", "From the second tab");
  await second.waitForSelector("#sync-banner:not([hidden])");
  await second.click("#conflict-load");
  assert.equal(await second.inputValue("#project-title"), "From the first tab");
  await context.close();
});

test("exports produce the full blueprint and a printable plan with the readiness assessment", async () => {
  const { context, page } = await newPage(browser);
  await page.goto(server.app);
  await waitForSaved(page);
  await page.fill("#project-title", "Printable Novel");
  await page.click("#continue-planning");
  await page.locator('.question-card[data-question-id="story_identity"] textarea').fill("Line one\nLine two");
  assert.equal((await page.textContent("#export-pdf")).trim(), "↓  Print or save as PDF");

  const markdown = (await download(page, "#export-markdown")).toString("utf8");
  assert.ok(markdown.startsWith("# Printable Novel\n"));
  assert.ok(markdown.includes("### Stage A — Story Identity"));
  assert.ok(markdown.includes("  - Line one\n    Line two\n"));
  assert.ok(markdown.includes("## Ready to Write Chapter One?"));
  assert.ok(markdown.includes("## Pre-drafting checklist"));

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
  assert.ok(printView.includes("Ready to Write Chapter One?"));
  assert.ok(printView.includes("Line one\nLine two"));
  await context.close();
});

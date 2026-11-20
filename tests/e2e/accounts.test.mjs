// Browser journeys against the production app with built-in accounts (app.py + SQLite).
// Signing in is optional: visitors plan right away and can sign in as they work.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  PASSWORD, addIdea, signOut, download, launchBrowser, logIn, newPage, openSignIn, register, startAccountServer,
  statusText, toastText, waitForSaved,
} from "./harness.mjs";

let server;
let browser;

before(async () => {
  server = await startAccountServer();
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

/** The project stored for the signed-in account, read straight from the API. */
function accountProject(page) {
  return page.evaluate(async () => {
    const token = localStorage.getItem("novel-architect-auth-token");
    const response = await fetch("/api/project", { headers: { Authorization: `Bearer ${token}` } });
    return response.json();
  });
}

test("visitors can plan without signing in, and their work moves into a new account", async () => {
  const { context, page } = await open();
  assert.equal(await statusText(page), "Saved in this browser");
  assert.equal(await page.isVisible("#login-button"), true);
  assert.equal(await page.isVisible("#auth-dialog"), false, "no sign-in wall");

  await page.fill("#project-title", "The Lantern Archive");
  await addIdea(page, "A keeper collects lost letters.", "Character");
  await page.click("#continue-planning");
  await page.locator('.question-card[data-question-id="story_identity"] textarea').fill("A keeper finds a letter to her dead sister.");
  await waitForSaved(page);
  await page.waitForSelector("#account-prompt:not([hidden])"); // offered once there is work worth keeping
  await page.reload();
  await waitForSaved(page);
  assert.equal(await page.inputValue("#project-title"), "The Lantern Archive", "work is kept in this browser");

  await addIdea(page, "A second idea after returning");
  await page.waitForSelector("#account-prompt:not([hidden])"); // offered again while editing
  await page.click("#account-prompt-signin");
  await register(page, "writer@example.com");
  assert.match(await toastText(page), /now saved to your account/);
  assert.equal(await page.textContent("#account-email"), "writer@example.com");
  assert.equal(await page.isVisible("#account-prompt"), false);

  const saved = await accountProject(page);
  assert.equal(saved.title, "The Lantern Archive");
  assert.equal(saved.answers.story_identity, "A keeper finds a letter to her dead sister.");
  assert.deepEqual(saved.ideas.map((idea) => idea.text).sort(), ["A keeper collects lost letters.", "A second idea after returning"]);

  await signOut(page);
  assert.equal(await page.inputValue("#project-title"), "My Novel", "signing out leaves a fresh, private page");
  assert.equal(await page.locator(".idea-card").count(), 0);
  assert.deepEqual(page.errors, []);
  await context.close();
});

test("signing in combines browser work with an existing account without losing anything", async () => {
  const first = await open();
  await register(first.page, "returning@example.com");
  await first.page.click("#continue-planning");
  await first.page.locator('.question-card[data-question-id="story_identity"] textarea').fill("The account's premise.");
  await waitForSaved(first.page);
  await first.context.close();

  const visitor = await open();
  await visitor.page.click("#continue-planning");
  await visitor.page.locator('.question-card[data-question-id="story_identity"] textarea').fill("A premise written before signing in.");
  await visitor.page.locator('.question-card[data-question-id="dramatic_interest"] textarea').fill("Who sent the letter?");
  await addIdea(visitor.page, "An idea from this browser");
  await waitForSaved(visitor.page);
  await logIn(visitor.page, "returning@example.com");
  assert.match(await toastText(visitor.page), /kept as material to review/);

  const saved = await accountProject(visitor.page);
  assert.equal(saved.answers.story_identity, "The account's premise.", "the account's answer is not overwritten");
  assert.equal(saved.answers.dramatic_interest, "Who sent the letter?");
  assert.ok(saved.ideas.some((idea) => idea.text === "An idea from this browser"));
  const kept = saved.materials.find((material) => material.text === "A premise written before signing in.");
  assert.ok(kept, "the browser's differing answer is preserved");
  assert.match(kept.source, /^Answer written before signing in/);
  await visitor.context.close();
});

test("Next section advances exactly one stage after signing out and in again", async () => {
  const { context, page } = await open();
  await register(page, "navigator@example.com");
  await signOut(page);
  await logIn(page, "navigator@example.com");
  await addIdea(page, "One idea");
  assert.equal(await page.locator(".idea-card").count(), 1, "one click adds exactly one idea");
  await page.click("#continue-planning");
  await page.click("#next-stage");
  assert.equal(await page.textContent("#stage-heading"), "Reader promise");
  await context.close();
});

test("after a session expires, work can be saved by signing in again or kept in the browser", async () => {
  const revoke = (page) => page.evaluate(async () => {
    const token = localStorage.getItem("novel-architect-auth-token");
    await fetch("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  });

  const again = await open();
  await register(again.page, "expiring@example.com");
  await revoke(again.page);
  await again.page.fill("#project-title", "Written after the session expired");
  await again.page.waitForSelector("#auth-dialog[open]");
  assert.match(await again.page.textContent("#auth-message"), /session has expired/);
  await logIn(again.page, "expiring@example.com");
  assert.equal((await accountProject(again.page)).title, "Written after the session expired");
  await again.context.close();

  const keep = await open();
  await register(keep.page, "keeper@example.com");
  await revoke(keep.page);
  await keep.page.fill("#project-title", "Kept in this browser");
  await keep.page.waitForSelector("#auth-dialog[open]");
  await keep.page.click("#auth-continue");
  await keep.page.waitForFunction(() => document.querySelector("#save-state").textContent.includes("Saved in this browser"));
  await keep.page.reload();
  await waitForSaved(keep.page);
  assert.equal(await keep.page.inputValue("#project-title"), "Kept in this browser");
  assert.equal(await keep.page.isVisible("#login-button"), true);
  await keep.context.close();
});

test("an invalid stored session falls back to planning without signing in", async () => {
  const { context, page } = await open();
  await page.evaluate(() => localStorage.setItem("novel-architect-auth-token", "not-a-real-token"));
  await page.reload();
  await waitForSaved(page);
  assert.equal(await statusText(page), "Saved in this browser");
  assert.match(await toastText(page), /session expired/);
  assert.equal(await page.evaluate(() => localStorage.getItem("novel-architect-auth-token")), null);
  await context.close();
});

test("the sign-in offer can be dismissed and stays dismissed", async () => {
  const { context, page } = await open();
  await addIdea(page, "Something worth keeping");
  await page.waitForSelector("#account-prompt:not([hidden])");
  await page.click("#account-prompt-dismiss");
  assert.equal(await page.isVisible("#account-prompt"), false);
  await page.reload();
  await waitForSaved(page);
  await addIdea(page, "Another idea");
  await waitForSaved(page);
  assert.equal(await page.isVisible("#account-prompt"), false);
  await context.close();
});

test("visitors can export without signing in", async () => {
  const { context, page } = await open();
  await page.fill("#project-title", "Visitor Export");
  const markdown = (await download(page, "#export-markdown")).toString("utf8");
  assert.ok(markdown.startsWith("# Visitor Export\n"));
  assert.ok(markdown.includes("## Ready to Write Chapter One?"));
  const pdf = await download(page, "#export-pdf");
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  await context.close();
});

test("administrator addresses are reserved; an operator-created administrator manages projects", async () => {
  const visitor = await open();
  await openSignIn(visitor.page);
  await visitor.page.fill("#auth-email", "owner@example.com");
  await visitor.page.fill("#auth-password", PASSWORD);
  await visitor.page.click("#sign-up");
  await visitor.page.waitForFunction(() => document.querySelector("#auth-message").classList.contains("error"));
  assert.match(await visitor.page.textContent("#auth-message"), /reserved for a site administrator/);
  await visitor.context.close();

  const writer = await open();
  await register(writer.page, "listed@example.com");
  await writer.page.fill("#project-title", "Project to remove");
  await waitForSaved(writer.page);

  server.createUser("owner@example.com");
  const admin = await open();
  await logIn(admin.page, "owner@example.com");
  assert.equal(await admin.page.isVisible("#admin-button"), true);
  await admin.page.click("#admin-button");
  const card = admin.page.locator("#admin-project-list .overview-card", { hasText: "Project to remove" });
  await card.waitFor();
  assert.match(await card.textContent(), /listed@example\.com/);
  admin.page.once("dialog", (dialog) => dialog.accept());
  await card.locator("button", { hasText: "Delete project" }).click();
  await card.waitFor({ state: "detached" });
  await admin.context.close();

  // The writer's open tab learns about the deletion instead of silently recreating the project.
  await writer.page.fill("#project-title", "Edited after deletion");
  await writer.page.waitForSelector("#sync-banner:not([hidden])");
  await writer.context.close();
});

test("repeated failed sign-ins are slowed down", async () => {
  const { context, page } = await open();
  await openSignIn(page);
  await page.fill("#auth-email", "nobody@example.com");
  for (let attempt = 0; attempt < 11; attempt += 1) {
    await page.fill("#auth-password", `wrong-password-${attempt}`);
    await page.click("#sign-in");
    await page.waitForFunction(() => /Invalid|Too many/.test(document.querySelector("#auth-message").textContent));
    if (attempt < 10) await page.evaluate(() => { document.querySelector("#auth-message").textContent = ""; });
  }
  assert.match(await page.textContent("#auth-message"), /Too many attempts/);
  await context.close();
});

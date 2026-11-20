// Browser journeys against the production app with built-in accounts (app.py + SQLite).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  PASSWORD, addIdea, launchBrowser, logIn, newPage, register, startAccountServer, statusText, waitForSaved,
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
  return { context, page };
}

test("register, sign out, and sign back in without duplicated actions", async () => {
  const { context, page } = await open();
  assert.equal(await page.isVisible("#register-button"), true);
  await register(page, "writer@example.com");
  assert.equal(await page.isVisible("#sign-out"), true, "sign-out is available right after registering");
  assert.equal(await page.textContent("#account-email"), "writer@example.com");
  assert.equal(await page.isVisible("#admin-button"), false);
  assert.equal(await page.isVisible("#register-button"), false);

  await addIdea(page, "First idea");
  await waitForSaved(page);
  await page.click("#sign-out");
  await page.waitForSelector("#auth-page:not([hidden])");
  assert.equal(await page.locator(".idea-card").count(), 0, "the signed-out page holds no project data");
  assert.equal(await page.inputValue("#project-title"), "My Novel");

  await logIn(page, "writer@example.com");
  assert.equal(await page.locator(".idea-card").count(), 1);
  await addIdea(page, "Second idea");
  assert.equal(await page.locator(".idea-card").count(), 2, "one click adds exactly one idea");
  await page.click("[data-open-stage]");
  await page.click("#next-stage");
  assert.equal(await page.textContent("#stage-heading"), "Reader promise", "Next section advances exactly one stage");
  assert.deepEqual(page.errors, []);
  await context.close();
});

test("a new account starts empty and cannot see another writer's project", async () => {
  const alice = await open();
  await register(alice.page, "alice@example.com");
  await alice.page.fill("#project-title", "Alice's private novel");
  await waitForSaved(alice.page);

  const bob = await open();
  await register(bob.page, "bob@example.com");
  assert.equal(await bob.page.inputValue("#project-title"), "My Novel");
  assert.equal(await bob.page.locator(".idea-card").count(), 0);
  await alice.context.close();
  await bob.context.close();
});

test("an expired session keeps unsaved work and saves it after logging in again", async () => {
  const { context, page } = await open();
  await register(page, "expiring@example.com");
  // Revoke the session on the server, as if it expired or was signed out elsewhere.
  await page.evaluate(async () => {
    const token = localStorage.getItem("novel-architect-auth-token");
    await fetch("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  });
  await page.fill("#project-title", "Written after the session expired");
  await page.waitForSelector("#auth-page:not([hidden])");
  assert.match(await page.textContent("#auth-message"), /session has expired/);
  assert.match(await statusText(page), /log in again/);

  await logIn(page, "expiring@example.com");
  await page.reload();
  await waitForSaved(page);
  assert.equal(await page.inputValue("#project-title"), "Written after the session expired");
  await context.close();
});

test("an invalid stored session leads to the login page", async () => {
  const { context, page } = await open();
  await page.waitForSelector("#auth-page:not([hidden])"); // start-up has finished reading storage
  await page.evaluate(() => localStorage.setItem("novel-architect-auth-token", "not-a-real-token"));
  await page.reload();
  await page.waitForSelector("#auth-page:not([hidden])");
  assert.match(await page.textContent("#auth-message"), /session has expired/);
  assert.equal(await page.evaluate(() => localStorage.getItem("novel-architect-auth-token")), null);
  await context.close();
});

test("administrator addresses are reserved; an operator-created administrator manages projects", async () => {
  const visitor = await open();
  await visitor.page.waitForSelector("#auth-page:not([hidden])");
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

test("repeated failed logins are slowed down", async () => {
  const { context, page } = await open();
  await page.waitForSelector("#auth-page:not([hidden])");
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

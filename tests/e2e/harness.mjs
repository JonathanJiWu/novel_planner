// Shared helpers for the browser end-to-end tests: real servers, real browser.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const PYTHON = process.env.PYTHON || "python3";
export const PASSWORD = "correct-horse-battery";

export function tempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), `novel-e2e-${prefix}-`));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, child, output) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${output.join("")}`);
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}:\n${output.join("")}`);
}

async function startProcess(args, { env = {}, cwd = ROOT, readyPath = "/" } = {}) {
  const port = await freePort();
  const output = [];
  const child = spawn(PYTHON, args(port), {
    cwd,
    env: { ...process.env, PYTHONUNBUFFERED: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const url = `http://127.0.0.1:${port}`;
  await waitForHttp(`${url}${readyPath}`, child, output);
  return {
    url,
    output,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

/** web_app.py: the single-user local server. */
export function startLocalServer() {
  const dir = tempDir("local");
  return startProcess((port) => ["web_app.py", "--port", String(port), "--project-file", path.join(dir, "project.json")], {
    readyPath: "/api/health",
  });
}

/** app.py with built-in accounts and a fresh SQLite database. */
export async function startAccountServer(extraEnv = {}) {
  const dir = tempDir("accounts");
  const env = {
    AUTH_REQUIRED: "true",
    NOVEL_PLANNER_DB: path.join(dir, "accounts.db"),
    ADMIN_EMAILS: "owner@example.com",
    AUTH_SECRET: "",
    SUPABASE_URL: "",
    SUPABASE_ANON_KEY: "",
    ...extraEnv,
  };
  const server = await startProcess(
    (port) => ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", String(port)],
    { env, readyPath: "/api/health" },
  );
  server.env = env;
  /** Create an account on the server, the way an operator would. */
  server.createUser = (email, password = PASSWORD) => {
    const result = spawnSync(PYTHON, ["manage.py", "create-user", email, "--password-stdin"], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      input: `${password}\n`,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  };
  return server;
}

/** The static GitHub Pages build, served under /novel_planner/ like the live site. */
export async function startStaticServer() {
  const dir = tempDir("static");
  mkdirSync(dir, { recursive: true });
  symlinkSync(path.join(ROOT, "web"), path.join(dir, "novel_planner"));
  const server = await startProcess((port) => ["-m", "http.server", String(port), "--bind", "127.0.0.1"], {
    cwd: dir,
    readyPath: "/novel_planner/",
  });
  server.app = `${server.url}/novel_planner/`;
  return server;
}

export async function launchBrowser() {
  return chromium.launch();
}

/** A new isolated browser profile with a console/page-error collector. */
export async function newPage(browser, options = {}) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 }, ...options });
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(error.message));
  return { context, page };
}

const SAVED = /^(All changes saved|Saved in this browser)$/;

export async function waitForSaved(page) {
  await page.waitForFunction(
    (pattern) => new RegExp(pattern).test(document.querySelector("#save-state").textContent.trim()),
    SAVED.source,
    { timeout: 15000 },
  );
}

export async function statusText(page) {
  return (await page.textContent("#save-state")).trim();
}

export async function toastText(page) {
  await page.waitForSelector("#toast.show");
  return (await page.textContent("#toast")).trim();
}

/** Open the optional sign-in dialog (it may already be open, e.g. after a session expired). */
export async function openSignIn(page) {
  if (!(await page.isVisible("#auth-dialog[open]"))) await page.click("#login-button");
  await page.waitForSelector("#auth-dialog[open]");
}

async function submitCredentials(page, button, email, password) {
  await openSignIn(page);
  await page.fill("#auth-email", email);
  await page.fill("#auth-password", password);
  await page.click(button);
  await page.waitForSelector("#auth-dialog", { state: "hidden" });
  await page.waitForSelector("#sign-out:not([hidden])");
  await waitForSaved(page);
}

/** Sign out and wait for the page to reload into a fresh visitor session. */
export async function signOut(page) {
  await Promise.all([page.waitForEvent("load"), page.click("#sign-out")]);
  await waitForSaved(page);
}

export async function register(page, email, password = PASSWORD) {
  await submitCredentials(page, "#sign-up", email, password);
}

export async function logIn(page, email, password = PASSWORD) {
  await submitCredentials(page, "#sign-in", email, password);
}

export async function addIdea(page, text, category) {
  await page.click("#stage-nav .nav-item >> nth=0");
  await page.fill("#idea-text", text);
  if (category) await page.selectOption("#idea-category", category);
  await page.click("#add-idea");
}

export async function download(page, selector) {
  const [file] = await Promise.all([page.waitForEvent("download"), page.click(selector)]);
  return readFileSync(await file.path());
}

/** Extract all text from a PDF with pdf.js (including CJK via standard CMaps). */
export async function pdfText(buffer) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const cMapUrl = path.join(ROOT, "node_modules/pdfjs-dist/cmaps/") ;
  const document = await getDocument({ data: new Uint8Array(buffer), cMapUrl, cMapPacked: true, verbosity: 0 }).promise;
  let text = "";
  for (let number = 1; number <= document.numPages; number += 1) {
    const content = await (await document.getPage(number)).getTextContent();
    text += `${content.items.map((item) => item.str).join("")}\n`;
  }
  return text;
}

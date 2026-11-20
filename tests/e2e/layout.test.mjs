// Themes, hidden controls, and the small-screen layout.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { addIdea, launchBrowser, newPage, startLocalServer, waitForSaved } from "./harness.mjs";

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

function luminance(rgb) {
  const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map((value) => {
    const channel = Number(value) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground, background) {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

test("every theme restyles the whole interface with readable text", async () => {
  const { context, page } = await newPage(browser);
  await page.goto(server.url);
  await waitForSaved(page);
  await addIdea(page, "An idea that must stay readable in every theme.");
  for (const theme of ["dark", "light", "paper"]) {
    await page.selectOption("#theme-select", theme);
    await page.click("#stage-nav .nav-item >> nth=0");
    const idea = await page.$eval(".idea-text", (element) => {
      const card = element.closest(".idea-card");
      return { color: getComputedStyle(element).color, background: getComputedStyle(card).backgroundColor };
    });
    assert.ok(contrast(idea.color, idea.background) >= 4.5, `${theme}: idea text contrast ${contrast(idea.color, idea.background)}`);

    await page.click("#continue-planning");
    const surfaces = await page.evaluate(() => {
      const read = (selector) => getComputedStyle(document.querySelector(selector)).backgroundColor;
      return { body: read("body"), guide: read(".stage-guide"), select: read(".answer-controls select") };
    });
    const pageIsLight = luminance(surfaces.body) > 0.5;
    assert.equal(pageIsLight, theme !== "dark", `${theme}: page background`);
    for (const [name, color] of Object.entries(surfaces)) {
      // Regression: panels and dropdowns stayed black in the light themes.
      assert.equal(luminance(color) > 0.5, pageIsLight, `${theme}: ${name} matches the theme (${color})`);
    }
  }
  await context.close();
});

test("the three appearance modes are offered by name", async () => {
  const { context, page } = await newPage(browser);
  await page.goto(server.url);
  await waitForSaved(page);
  const options = await page.$$eval("#theme-select option", (items) => items.map((item) => [item.value, item.textContent]));
  assert.deepEqual(options, [["dark", "Dark mode"], ["light", "Bright mode"], ["paper", "Parchment mode"]]);
  await page.selectOption("#theme-select", "paper");
  const texture = await page.evaluate(() => getComputedStyle(document.body).backgroundImage);
  assert.match(texture, /data:image\/svg\+xml/, "parchment mode has a paper texture");
  await context.close();
});

test("controls hidden by the app stay hidden", async () => {
  // Regression: CSS display rules overrode the hidden attribute, so Register and
  // Database admin showed up in local mode.
  const { context, page } = await newPage(browser);
  await page.goto(server.url);
  await waitForSaved(page);
  for (const selector of ["#login-button", "#sign-out", "#admin-button", "#sync-banner", "#account-prompt"]) {
    assert.equal(await page.isVisible(selector), false, selector);
  }
  await context.close();
});

test("the phone layout fits the screen and keeps export and the project name", async () => {
  const { context, page } = await newPage(browser, { viewport: { width: 390, height: 844 }, isMobile: true });
  await page.goto(server.url);
  await waitForSaved(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.equal(overflow, 0, "no horizontal scrolling");
  for (const selector of ["#project-title", "#export-markdown", "#export-pdf", "#progress-value"]) {
    assert.equal(await page.isVisible(selector), true, selector);
  }
  await context.close();
});

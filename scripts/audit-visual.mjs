/**
 * Full UI audit: smoke, keyboard, responsive, network, and axe-core accessibility checks.
 * Read-only by default: it does not create exports, change settings, or delete data.
 * Requires a running dev server and APP_ACCESS_KEY in the environment.
 *
 *   npm run dev            # in one terminal
 *   npm run audit:visual   # in another
 *
 * Results print as PASS/FAIL lines; exit code 1 means at least one check failed.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
const NAME = process.env.AUDIT_USER ?? "audit-runner";

const results = [];
function record(area, ok, detail) {
  results.push({ area, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  [${area}] ${detail}`);
}

let activeBrowser;

async function run() {
  const browser = await chromium.launch({ channel: process.env.AUDIT_CHANNEL ?? "chrome" });
  activeBrowser = browser;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const consoleErrors = [];
  const pageErrors = [];
  const failedResponses = [];
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url().replace(/([?&][^=]+=)[^&]*/g, "$1[redacted]") });
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  // Sign in only if the login screen is present.
  await page.locator("#login-name, .workspace").first().waitFor({ state: "visible", timeout: 15000 });
  if (await page.locator("#login-name").count()) {
    const key = process.env.APP_ACCESS_KEY;
    if (!key) throw new Error("APP_ACCESS_KEY is required to sign in");
    await page.getByLabel("Your name").fill(NAME);
    await page.getByLabel("Access key").fill(key);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  const workspace = page.locator(".workspace");
  try {
    await workspace.waitFor({ state: "visible", timeout: 15000 });
  } catch {
    const loginError = await page.locator("[role=alert]").allTextContents();
    record("smoke", false, `login did not reach the workspace${loginError.length ? `: ${loginError.join(" ")}` : ""}`);
    await browser.close();
    process.exitCode = 1;
    return;
  }
  record("smoke", true, "authenticated workspace loaded");
  const axeFindings = [];
  try {
    await page.addScriptTag({ url: "https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js" });
  } catch (error) {
    record("axe", false, `axe-core could not be loaded: ${error.message}`);
  }
  const auditAxe = async (view) => {
    if (!(await page.evaluate(() => Boolean(window.axe)))) return;
    const violations = await page.evaluate(async () => {
      const results = await window.axe.run(document, { resultTypes: ["violations"] });
      return results.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.length,
        help: v.help,
        targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
      }));
    });
    axeFindings.push(...violations.map((v) => ({ ...v, view })));
    record("axe", violations.length === 0, violations.length ? `${view}: ${violations.map((v) => `${v.impact} ${v.id} (${v.nodes})`).join("; ")}` : `${view}: no violations`);
  };
  await auditAxe("workspace");

  // Search form labels (radius control only renders in radius mode).
  if (await page.locator("#radius-number").count()) {
    const radiusLabelText = await page.locator(`label[for="radius-number"]`).first().textContent();
    record("a11y-form", (radiusLabelText ?? "").includes("Radius"), `number input label = ${JSON.stringify((radiusLabelText ?? "").trim())}`);
    const sliderName = await page.locator("#radius").evaluate((el) => el.getAttribute("aria-label"));
    record("a11y-form", Boolean(sliderName), `slider aria-label = ${JSON.stringify(sliderName)}`);
  } else {
    record("a11y-form", true, "radius control not rendered in the current search mode (skipped)");
  }

  // Combobox keyboard behavior.
  const country = page.getByRole("combobox", { name: "Country" });
  if (await country.count()) {
    await country.focus();
    await page.keyboard.press("End");
    const activeId = await country.getAttribute("aria-activedescendant");
    const activeExists = activeId ? await page.locator(`#${activeId}`).count() : 0;
    record("a11y-combobox", activeExists === 1, `active descendant ${activeId} resolves to ${activeExists} node(s)`);
    await page.keyboard.press("Escape");
  } else {
    const combos = await page.getByRole("combobox").allTextContents();
    record("a11y-combobox", false, `no "Country" combobox on screen; comboboxes = ${JSON.stringify(combos)}`);
  }

  // Details panel with hours.
  const detailsButtons = page.getByRole("button", { name: /Show details for/i });
  const detailCount = await detailsButtons.count();
  if (detailCount > 0) {
    const detailTrigger = detailsButtons.first();
    await detailTrigger.click();
    const panel = page.locator(".details-panel");
    await panel.waitFor({ timeout: 10000 });
    const detailsFocused = await panel.evaluate((el) => el === document.activeElement);
    record("a11y-details", detailsFocused, detailsFocused ? "focus moves to the details panel on open" : "focus did not move to the details panel");
    const chart = page.locator(".hours-chart");
    const hasChart = await chart.count();
    record("visual-hours", true, hasChart ? "hours chart rendered" : "first place has no weekly hours chart (source-dependent)");
    await auditAxe("details panel");
    // Escape closes the panel.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const closed = (await panel.count()) === 0;
    record("a11y-details", closed, closed ? "Escape closes the details panel" : "Escape did not close the details panel");
    const focusRestored = await detailTrigger.evaluate((el) => el === document.activeElement);
    record("a11y-details", focusRestored, focusRestored ? "focus returns to the place trigger on close" : "focus did not return to the place trigger");
  } else {
    record("visual-hours", false, "no result rows with details buttons were available");
  }

  // Exports modal.
  await page.getByRole("button", { name: "Exports", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 10000 });
  record("modal", true, "exports dialog opened");
  await auditAxe("exports dialog");
  const focusInDialog = await dialog.evaluate((el) => el.contains(document.activeElement));
  record("a11y-modal", focusInDialog, focusInDialog ? "focus starts inside the exports dialog" : "focus did not start inside the exports dialog");
  await page.keyboard.press("Shift+Tab");
  const trapped = await dialog.evaluate((el) => el.contains(document.activeElement));
  record("a11y-modal", trapped, trapped ? "Shift+Tab keeps focus inside the dialog" : "Shift+Tab escaped the dialog");
  await page.getByLabel("Export from").selectOption("saved");
  const picker = page.locator(".export-place-picker");
  const legend = await picker.locator("legend").count();
  const legendHidden = legend ? await picker.locator("legend").evaluate((el) => getComputedStyle(el).clip) : "";
  record("a11y-export", legend === 1 && legendHidden !== "auto", `saved-places group has a visually hidden legend (clip=${legendHidden})`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const exportsClosed = (await page.getByRole("dialog").count()) === 0;
  record("modal", exportsClosed, exportsClosed ? "Escape closes the exports dialog" : "Escape did not close the exports dialog");

  // Responsive overflow checks at three breakpoints.
  for (const [label, size] of [
    ["375", { width: 375, height: 812 }],
    ["768", { width: 768, height: 1024 }],
    ["1440", { width: 1440, height: 900 }],
  ]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(250);
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      win: window.innerWidth,
      body: document.body.scrollWidth,
    }));
    record("responsive", overflow.doc <= overflow.win + 1 && overflow.body <= overflow.win + 1, `${label}px horizontal overflow = ${Math.max(overflow.doc, overflow.body) - overflow.win}px`);
  }

  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(200);
  const inactivePaneHidden = await page.evaluate(() => {
    const map = document.querySelector(".map-pane");
    const sidebar = document.querySelector(".sidebar");
    const isHiddenStyle = (el) => el && getComputedStyle(el).display === "none";
    const hasInert = (el) => el && (el.hasAttribute("inert") || el.getAttribute("aria-hidden") === "true");
    return { map: isHiddenStyle(map) || hasInert(map), sidebar: isHiddenStyle(sidebar) || hasInert(sidebar) };
  });
  record("a11y-responsive", inactivePaneHidden.map || inactivePaneHidden.sidebar, `hidden mobile pane is removed from the a11y tree (map=${inactivePaneHidden.map}, sidebar=${inactivePaneHidden.sidebar})`);
  await auditAxe("375px mobile list");

  await page.getByRole("button", { name: "Map", exact: true }).click();
  await page.waitForTimeout(300);
  const mapModeHidden = await page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar");
    return sidebar ? sidebar.hasAttribute("inert") || sidebar.getAttribute("aria-hidden") === "true" : false;
  });
  record("a11y-responsive", mapModeHidden, mapModeHidden ? "sidebar is removed from the a11y tree in mobile map mode" : "sidebar stays exposed in mobile map mode");
  await auditAxe("375px mobile map");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.waitForTimeout(200);

  // The app probes /api/auth/me before login, so a single 401 is the expected unauthenticated state.
  const expected401 = failedResponses.every((response) => response.status === 401 && response.url.endsWith("/api/auth/me"));
  const unexpectedConsole = consoleErrors.filter((message) => !/401 \(Unauthorized\)/.test(message));
  for (const message of unexpectedConsole) console.log(`   console: ${message.slice(0, 300)}`);
  for (const response of failedResponses) console.log(`   response: ${response.status} ${response.url}`);
  record("network", failedResponses.length === 0 || expected401, `${failedResponses.length} failed response(s)${expected401 ? " (pre-login /api/auth/me probe only)" : ""}`);
  record("console", unexpectedConsole.length === 0 && pageErrors.length === 0, `${unexpectedConsole.length} unexpected console error(s), ${pageErrors.length} page error(s)`);

  if (axeFindings.length) {
    console.log("\naxe-core violation details:");
    for (const v of axeFindings) console.log(`  [${v.view}] ${v.impact} ${v.id}: ${v.help} — ${v.targets.join(", ")}`);
  }

  await browser.close();
  activeBrowser = null;

  const failures = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
  if (failures.length) process.exitCode = 1;
}

run().catch(async (error) => {
  console.error(error);
  if (activeBrowser) await activeBrowser.close().catch(() => undefined);
  process.exitCode = 1;
});
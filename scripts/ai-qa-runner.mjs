import { chromium } from "@playwright/test";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const smokeMode = args.has("--smoke");

await loadEnv(path.join(ROOT, ".env"));

const config = {
  hiringcatUrl: envUrl("HIRINGCAT_URL", "https://hiringcat.com"),
  qaUrl: envUrl("HIRINGCAT_QA_URL", "https://aamirmursleen.github.io/hiringcat-qa/"),
  publicBaseUrl: envUrl("PUBLIC_BASE_URL", "https://aamirmursleen.github.io/hiringcat-qa"),
  email: process.env.HIRINGCAT_TEST_EMAIL || "",
  password: process.env.HIRINGCAT_TEST_PASSWORD || "",
  orgSlug: process.env.HIRINGCAT_ORG_SLUG || "",
  jobSlug: process.env.HIRINGCAT_JOB_SLUG || "",
  customDomain: trimTrailingSlash(process.env.HIRINGCAT_CUSTOM_DOMAIN || ""),
  uploadProvider: (process.env.VIDEO_UPLOAD_PROVIDER || "local").toLowerCase(),
  moonpushUploadUrl: process.env.MOONPUSH_UPLOAD_URL || "https://www.moonpush.com/api/upload",
  sendWhatsApp: process.env.SEND_WHATSAPP === "1",
  reportPhone: process.env.QA_REPORT_PHONE || "",
  waqueenApiKey: process.env.WAQUEEN_API_KEY || "",
  waqueenMessagesUrl: process.env.WAQUEEN_MESSAGES_URL || "https://waqueen.com/api/v1/messages",
  headless: process.env.QA_HEADLESS !== "0",
  interactiveLogin: process.env.HIRINGCAT_LOGIN_INTERACTIVE === "1",
  loginWaitMs: Number(process.env.HIRINGCAT_LOGIN_WAIT_MS || 180_000),
};

const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const runRel = `runs/${runId}`;
const runDir = path.join(ROOT, runRel);
const videosDir = path.join(runDir, "videos");
const screenshotsDir = path.join(runDir, "screenshots");
const tracesDir = path.join(runDir, "traces");
const captionsDir = path.join(runDir, "captions");
const rawVideoDir = path.join(runDir, "raw-videos");
await fs.mkdir(videosDir, { recursive: true });
await fs.mkdir(screenshotsDir, { recursive: true });
await fs.mkdir(tracesDir, { recursive: true });
await fs.mkdir(captionsDir, { recursive: true });
await fs.mkdir(rawVideoDir, { recursive: true });

const sections = scenarioSections();
const selectedSections = smokeMode ? sections.filter((section) => section.smoke) : sections;

const browser = await chromium.launch({ headless: config.headless });
const results = [];

try {
  for (const section of selectedSections) {
    const result = await runSection(browser, section);
    results.push(result);
    console.log(`${result.status.padEnd(4)} ${section.id} - ${result.reason}`);
  }
} catch (error) {
  await browser.close().catch(() => {});
  throw error;
}

const summary = summarize(results);
const report = {
  runId,
  generatedAt: new Date().toISOString(),
  target: {
    hiringcatUrl: config.hiringcatUrl,
    qaUrl: config.qaUrl,
    orgSlug: config.orgSlug || null,
    jobSlug: config.jobSlug || null,
    customDomain: config.customDomain || null,
  },
  summary,
  results,
};

await fs.writeFile(path.join(runDir, "summary.json"), JSON.stringify(report, null, 2));
await writeReportHtml(report);
await writeReportPdf();
await fs.rm(rawVideoDir, { recursive: true, force: true });
await browser.close();

if (config.sendWhatsApp) {
  await sendWhatsAppReport(report);
}

console.log("");
console.log(`AI QA run complete: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped.`);
console.log(`Local report: ${path.join(runDir, "report.html")}`);
console.log(`Public report after push: ${publicUrl("report.html")}`);

async function runSection(browserInstance, section) {
  const startedAt = Date.now();
  const context = await browserInstance.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: {
      dir: rawVideoDir,
      size: { width: 1920, height: 1080 },
    },
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await context.newPage();
  const captionEvents = [];
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  let status = "SKIP";
  let reason = "";
  let assertion = "";
  let screenshotPath = "";
  let tracePath = "";
  let videoPath = "";
  let vttPath = "";

  try {
    await showChecklistContext(page, section, captionEvents, startedAt);
    const preflight = preflightSection(section);
    if (!preflight.ok) {
      status = "SKIP";
      reason = preflight.reason;
      await caption(page, captionEvents, startedAt, `Result: SKIP - ${reason}`);
    } else {
      await caption(page, captionEvents, startedAt, `Running: ${section.title}`);
      const liveResult = await executeSection(page, section, captionEvents, startedAt);
      status = liveResult.status;
      reason = liveResult.reason;
      assertion = liveResult.assertion || "";
      await caption(page, captionEvents, startedAt, `Result: ${status} - ${reason}`);
    }
  } catch (error) {
    status = "FAIL";
    reason = error instanceof Error ? error.message : "Unknown runner error.";
    await safeCaption(page, captionEvents, startedAt, `Result: FAIL - ${reason}`);
  } finally {
    screenshotPath = path.join(screenshotsDir, `${section.id}.png`);
    try {
      await page.screenshot({ path: screenshotPath, fullPage: false });
    } catch {}

    tracePath = path.join(tracesDir, `${section.id}-trace.zip`);
    try {
      await context.tracing.stop({ path: tracePath });
    } catch {}

    const video = page.video();
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    const rawPath = video ? await video.path().catch(() => "") : "";
    if (rawPath) {
      videoPath = path.join(videosDir, `${section.id}.webm`);
      await fs.copyFile(rawPath, videoPath);
    }
    vttPath = path.join(captionsDir, `${section.id}.vtt`);
    await fs.writeFile(vttPath, toVtt(captionEvents, Date.now() - startedAt));
  }

  const uploaded = await uploadArtifacts({ section, videoPath, screenshotPath, tracePath, vttPath });
  return {
    id: section.id,
    title: section.title,
    status,
    reason,
    assertion,
    humanRequired: status === "SKIP" && /human|credential|access|token|gmail|dns|payment|send-ready/i.test(reason),
    durationMs: Date.now() - startedAt,
    errors: errors.slice(0, 10),
    videoUrl: uploaded.videoUrl,
    captionUrl: uploaded.captionUrl,
    screenshotUrl: uploaded.screenshotUrl,
    traceUrl: uploaded.traceUrl,
  };
}

async function showChecklistContext(page, section, captionEvents, startedAt) {
  await page.goto(config.qaUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await installCaptionOverlay(page);
  await caption(page, captionEvents, startedAt, `HiringCat AI QA - ${section.title}`);
  const sectionLocator = page.locator(`#${section.checklistId || section.id}`).first();
  if (await sectionLocator.count()) {
    await sectionLocator.scrollIntoViewIfNeeded();
  }
}

async function executeSection(page, section, captionEvents, startedAt) {
  if (section.id === "qa-form-smoke") return testQaChecklist(page, captionEvents, startedAt);
  if (section.id === "target-app-preflight") return testTargetAppPreflight(page, captionEvents, startedAt);
  if (section.publicRoute) return testPublicRoute(page, section, captionEvents, startedAt);
  if (section.authenticatedRoute) return testAuthenticatedRoute(page, section, captionEvents, startedAt);
  return {
    status: "SKIP",
    reason: "This section requires a specialized external assertion that is not configured in this run.",
  };
}

async function testQaChecklist(page, captionEvents, startedAt) {
  await caption(page, captionEvents, startedAt, "Checking QA checklist page, task count, progress, and report buttons.");
  await expectVisible(page, "h1", /HiringCat QA Checklist/i);
  const sectionCount = await page.locator(".section").count();
  const taskCount = await page.locator(".task-card").count();
  if (sectionCount < 20 || taskCount < 50) {
    throw new Error(`QA checklist rendered ${sectionCount} sections and ${taskCount} tasks; expected at least 20 sections and 50 tasks.`);
  }
  await page.locator(".v-pass").first().click();
  await expectVisible(page, "#statPass", /^1$/);
  await expectVisible(page, "#resultsBox", /Today's Results/i);
  await caption(page, captionEvents, startedAt, `Verified ${sectionCount} sections and ${taskCount} task cards.`);
  return {
    status: "PASS",
    reason: `Checklist rendered ${sectionCount} sections/${taskCount} tasks and Pass progress worked.`,
    assertion: "QA checklist infrastructure works.",
  };
}

async function testTargetAppPreflight(page, captionEvents, startedAt) {
  await caption(page, captionEvents, startedAt, `Opening HiringCat target app: ${config.hiringcatUrl}`);
  const response = await page.goto(config.hiringcatUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const statusCode = response?.status() ?? 0;
  const bodyText = (await page.locator("body").innerText({ timeout: 5000 }).catch(() => "")).trim();

  if (statusCode >= 500 || statusCode === 0) {
    return {
      status: "FAIL",
      reason: `Target app returned HTTP ${statusCode || "unknown"}.`,
      assertion: "HiringCat target app should load before dashboard E2E runs.",
    };
  }

  if (hasAuthConfigError(bodyText)) {
    return {
      status: "FAIL",
      reason: "Local app loaded but recruiter authentication is not configured. Set VITE_CLERK_PUBLISHABLE_KEY plus backend Clerk/API/database env before localhost dashboard E2E.",
      assertion: "Localhost dashboard testing requires configured Clerk and backend env.",
    };
  }

  if (!bodyText || hasBlockingAppError(bodyText)) {
    return {
      status: "FAIL",
      reason: "Target app loaded but body is empty or contains an app error.",
      assertion: "HiringCat target app should show usable content.",
    };
  }

  return {
    status: "PASS",
    reason: `Target app loaded with HTTP ${statusCode}.`,
    assertion: "HiringCat target app preflight passed.",
  };
}

async function testPublicRoute(page, section, captionEvents, startedAt) {
  const target = resolveSectionUrl(section);
  await caption(page, captionEvents, startedAt, `Opening public URL: ${target}`);
  const response = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const statusCode = response?.status() ?? 0;
  if (statusCode >= 500 || statusCode === 0) {
    return {
      status: "FAIL",
      reason: `Public route returned HTTP ${statusCode || "unknown"}.`,
      assertion: "Public page should load without server error.",
    };
  }
  await page.waitForTimeout(1200);
  const bodyText = (await page.locator("body").innerText({ timeout: 5000 }).catch(() => "")).trim();
  if (!bodyText || hasBlockingAppError(bodyText)) {
    return {
      status: "FAIL",
      reason: "Public route loaded but body is empty or contains an app error.",
      assertion: "Public page should show usable content.",
    };
  }
  return {
    status: "PASS",
    reason: `Public route loaded with HTTP ${statusCode}.`,
    assertion: "Public route returned usable content.",
  };
}

async function testAuthenticatedRoute(page, section, captionEvents, startedAt) {
  await caption(page, captionEvents, startedAt, "Logging into HiringCat with private test credentials.");
  await login(page);
  const target = resolveSectionUrl(section);
  await caption(page, captionEvents, startedAt, `Opening authenticated URL: ${target}`);
  const response = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const statusCode = response?.status() ?? 0;
  if (statusCode >= 500 || statusCode === 0) {
    return {
      status: "FAIL",
      reason: `Authenticated route returned HTTP ${statusCode || "unknown"}.`,
      assertion: "Dashboard route should load without server error.",
    };
  }
  await page.waitForTimeout(1500);
  const bodyText = (await page.locator("body").innerText({ timeout: 5000 }).catch(() => "")).trim();
  if (/sign in|sign-in/i.test(page.url()) && !/dashboard/i.test(page.url())) {
    return {
      status: "FAIL",
      reason: "Login did not reach dashboard; route redirected back to sign-in.",
      assertion: "Private credentials should allow dashboard access.",
    };
  }
  if (hasAuthFormOrError(bodyText)) {
    return {
      status: "FAIL",
      reason: "Dashboard route shows sign-in UI or authentication error instead of a recruiter dashboard.",
      assertion: "Private credentials should create an authenticated dashboard session.",
    };
  }
  if (!bodyText || hasBlockingAppError(bodyText)) {
    return {
      status: "FAIL",
      reason: "Dashboard route loaded but body is empty or contains an app error.",
      assertion: "Dashboard should show usable content.",
    };
  }
  return {
    status: "PASS",
    reason: `${section.title} route loaded after login.`,
    assertion: "Authenticated dashboard route is accessible.",
  };
}

async function login(page) {
  await page.goto(`${config.hiringcatUrl}/sign-in`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const initialBody = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  if (hasAuthConfigError(initialBody)) {
    throw new Error("Login page cannot run because authentication is not configured. Set VITE_CLERK_PUBLISHABLE_KEY, Clerk backend keys, API URL, and database env for localhost.");
  }
  await fillFirst(page, [
    'input[name="identifier"]',
    'input[name="email"]',
    'input[type="email"]',
    'input[autocomplete="email"]',
  ], config.email);
  const passwordInput = await fillFirst(page, [
    'input[name="password"]',
    'input[type="password"]',
    'input[autocomplete="current-password"]',
  ], config.password);
  await passwordInput.press("Enter");
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(3500);

  if (/dashboard/i.test(page.url())) return;

  const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  if (/verification code|verify.*email|enter.*code|we sent.*code/i.test(bodyText)) {
    if (!config.interactiveLogin) {
      throw new Error("Login requires an email/OTP verification code. Re-run with QA_HEADLESS=0 and HIRINGCAT_LOGIN_INTERACTIVE=1 so a human can enter the code.");
    }
    console.log(`Interactive login required. Enter the code in the browser within ${Math.round(config.loginWaitMs / 1000)} seconds.`);
    await page.waitForURL("**/dashboard**", { timeout: config.loginWaitMs });
    return;
  }

  if (hasAuthFormOrError(bodyText)) {
    throw new Error("Login failed with an invalid credential or authorization error.");
  }
}

function preflightSection(section) {
  if (section.id === "qa-form-smoke") return { ok: true };
  if (section.requiresCredentials && (!config.email || !config.password)) {
    return { ok: false, reason: "Private HiringCat test email/password are missing, so AI cannot safely verify authenticated dashboard flow." };
  }
  if (section.requiresOrgJob && (!config.orgSlug || !config.jobSlug)) {
    return { ok: false, reason: "Organization slug and job slug are missing, so AI cannot verify this public candidate route." };
  }
  if (section.requiresCustomDomain && !config.customDomain) {
    return { ok: false, reason: "Custom domain is not configured for this run." };
  }
  if (section.humanOnly) return { ok: false, reason: section.humanReason };
  return { ok: true };
}

function resolveSectionUrl(section) {
  if (section.url) return section.url;
  if (section.path) return `${config.hiringcatUrl}${section.path}`;
  if (section.publicRoute === "careers") return `${config.hiringcatUrl}/careers/${encodeURIComponent(config.orgSlug)}`;
  if (section.publicRoute === "apply") return `${config.hiringcatUrl}/apply/${encodeURIComponent(config.orgSlug)}/${encodeURIComponent(config.jobSlug)}`;
  if (section.publicRoute === "availability") return `${config.hiringcatUrl}/availability/${encodeURIComponent(config.orgSlug)}`;
  if (section.publicRoute === "custom-domain") return config.customDomain;
  return config.hiringcatUrl;
}

function hasAuthConfigError(text) {
  return /Authentication is not configured|Set VITE_CLERK_PUBLISHABLE_KEY/i.test(text || "");
}

function hasBlockingAppError(text) {
  return /Application error|Internal Server Error|Something went wrong|Authentication is not configured|Set VITE_CLERK_PUBLISHABLE_KEY/i.test(text || "");
}

function hasAuthFormOrError(text) {
  return /Sign in to HiringCat|WELCOME BACK|Couldn't find your account|Could not find your account|could not sign in|check your email and password|invalid|incorrect|unauthorized/i.test(text || "");
}

async function fillFirst(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.fill(value, { timeout: 5000 });
    return locator;
  }
  throw new Error(`Could not find input selector from: ${selectors.join(", ")}`);
}

async function clickFirst(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.click({ timeout: 5000 });
    return;
  }
  throw new Error(`Could not find clickable selector from: ${selectors.join(", ")}`);
}

async function expectVisible(page, selector, expectedText) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: 10_000 });
  const text = await locator.innerText().catch(() => "");
  if (expectedText && !expectedText.test(text)) {
    throw new Error(`Expected ${selector} text to match ${expectedText}, got "${text}".`);
  }
}

async function installCaptionOverlay(page) {
  await page.addStyleTag({
    content: `
      #ai-qa-caption {
        position: fixed;
        left: 32px;
        right: 32px;
        bottom: 28px;
        z-index: 2147483647;
        background: rgba(15, 23, 42, 0.92);
        color: white;
        border: 1px solid rgba(255,255,255,0.22);
        box-shadow: 0 18px 50px rgba(0,0,0,0.28);
        border-radius: 14px;
        padding: 16px 18px;
        font: 700 24px/1.35 Inter, Arial, sans-serif;
        letter-spacing: 0;
        pointer-events: none;
      }
    `,
  });
  await page.evaluate(() => {
    const existing = document.getElementById("ai-qa-caption");
    if (existing) return;
    const el = document.createElement("div");
    el.id = "ai-qa-caption";
    document.body.appendChild(el);
  });
}

async function caption(page, events, startedAt, text) {
  events.push({ at: Date.now() - startedAt, text });
  await page.evaluate((value) => {
    const el = document.getElementById("ai-qa-caption");
    if (el) el.textContent = value;
  }, text);
  await page.waitForTimeout(600);
}

async function safeCaption(page, events, startedAt, text) {
  try {
    await caption(page, events, startedAt, text);
  } catch {}
}

function toVtt(events, totalMs) {
  const lines = ["WEBVTT", ""];
  const normalized = events.length ? events : [{ at: 0, text: "HiringCat AI QA" }];
  normalized.forEach((event, index) => {
    const start = event.at;
    const end = normalized[index + 1]?.at ?? Math.max(totalMs, start + 1500);
    lines.push(String(index + 1));
    lines.push(`${formatVttTime(start)} --> ${formatVttTime(Math.max(end, start + 1000))}`);
    lines.push(event.text.replace(/\s+/g, " ").trim());
    lines.push("");
  });
  return lines.join("\n");
}

function formatVttTime(ms) {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const milli = total % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(milli).padStart(3, "0")}`;
}

async function uploadArtifacts({ section, videoPath, screenshotPath, tracePath, vttPath }) {
  const files = {
    videoUrl: videoPath,
    screenshotUrl: screenshotPath,
    traceUrl: tracePath,
    captionUrl: vttPath,
  };
  if (config.uploadProvider === "moonpush") {
    return {
      videoUrl: videoPath ? await uploadMoonPush(videoPath) : "",
      screenshotUrl: screenshotPath ? await uploadMoonPush(screenshotPath) : "",
      traceUrl: tracePath ? await uploadMoonPush(tracePath) : "",
      captionUrl: vttPath ? await uploadMoonPush(vttPath) : "",
    };
  }
  return Object.fromEntries(Object.entries(files).map(([key, value]) => [key, value ? publicUrl(path.relative(runDir, value).replaceAll(path.sep, "/")) : ""]));
}

async function uploadMoonPush(filePath) {
  const form = new FormData();
  const data = await fs.readFile(filePath);
  form.append("file", new Blob([data]), path.basename(filePath));
  const response = await fetch(config.moonpushUploadUrl, { method: "POST", body: form });
  if (!response.ok) throw new Error(`MoonPush upload failed for ${path.basename(filePath)}: HTTP ${response.status}`);
  const json = await response.json();
  return json.shareUrl || json.downloadUrl || json.url || "";
}

function publicUrl(file = "") {
  return `${trimTrailingSlash(config.publicBaseUrl)}/${runRel}${file ? `/${file}` : ""}`;
}

async function writeReportHtml(report) {
  const html = renderReportHtml(report);
  await fs.writeFile(path.join(runDir, "report.html"), html);
}

async function writeReportPdf() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1600 } });
  const page = await context.newPage();
  await page.goto(`file://${path.join(runDir, "report.html")}`, { waitUntil: "load" });
  await page.pdf({
    path: path.join(runDir, `HiringCat-AI-QA-${runId}.pdf`),
    format: "A4",
    printBackground: true,
    margin: { top: "12mm", right: "10mm", bottom: "12mm", left: "10mm" },
  });
  await context.close();
}

function renderReportHtml(report) {
  const rows = report.results.map((result) => `
    <article class="card ${result.status.toLowerCase()}">
      <div class="row">
        <div>
          <p class="eyebrow">${escapeHtml(result.id)}</p>
          <h2>${escapeHtml(result.title)}</h2>
        </div>
        <span class="status">${result.status}</span>
      </div>
      <p><strong>Reason:</strong> ${escapeHtml(result.reason)}</p>
      ${result.assertion ? `<p><strong>Assertion:</strong> ${escapeHtml(result.assertion)}</p>` : ""}
      ${result.humanRequired ? `<p class="human">Human verification required for this item.</p>` : ""}
      <div class="links">
        ${result.videoUrl ? `<a href="${escapeHtml(result.videoUrl)}">Video</a>` : ""}
        ${result.captionUrl ? `<a href="${escapeHtml(result.captionUrl)}">Captions</a>` : ""}
        ${result.screenshotUrl ? `<a href="${escapeHtml(result.screenshotUrl)}">Screenshot</a>` : ""}
        ${result.traceUrl ? `<a href="${escapeHtml(result.traceUrl)}">Trace</a>` : ""}
      </div>
    </article>
  `).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HiringCat AI QA Report ${escapeHtml(report.runId)}</title>
  <style>
    body{margin:0;background:#f8fafc;color:#172033;font:14px/1.55 Inter,Arial,sans-serif}
    main{max-width:1080px;margin:0 auto;padding:28px 18px 46px}
    .hero{background:linear-gradient(135deg,#16a34a,#2563eb);color:white;border-radius:18px;padding:26px 24px;margin-bottom:18px}
    h1{margin:0;font-size:30px;letter-spacing:0} h2{margin:2px 0 0;font-size:18px}
    .summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 0}
    .metric{background:white;border:1px solid #e8edf4;border-radius:14px;padding:14px;box-shadow:0 4px 18px rgba(15,23,42,.06)}
    .metric b{display:block;font-size:28px}.metric span{color:#64748b;font-weight:700;font-size:12px;text-transform:uppercase}
    .card{background:white;border:1px solid #e8edf4;border-left:6px solid #94a3b8;border-radius:14px;padding:16px;margin:12px 0;box-shadow:0 4px 18px rgba(15,23,42,.06);break-inside:avoid}
    .card.pass{border-left-color:#00b894}.card.fail{border-left-color:#e17055}.card.skip{border-left-color:#94a3b8}
    .row{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.eyebrow{margin:0;color:#64748b;font-size:11px;font-weight:800;text-transform:uppercase}
    .status{font-weight:900;border-radius:999px;padding:5px 10px;background:#eef2f7}.pass .status{background:#dcfce7;color:#166534}.fail .status{background:#fee2e2;color:#991b1b}.skip .status{background:#f1f5f9;color:#475569}
    .links{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.links a{background:#ecfdf5;color:#15803d;border:1px solid #bbf7d0;border-radius:10px;padding:7px 11px;font-weight:800;text-decoration:none}
    .human{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:10px;padding:9px 11px;font-weight:700}.meta{color:#dbeafe;margin-top:8px}.target{color:#64748b;margin:0 0 16px}
    @media print{body{background:white}.links a{color:#172033}}
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <h1>HiringCat AI QA Report</h1>
      <div class="meta">Run ${escapeHtml(report.runId)} · ${escapeHtml(report.generatedAt)}</div>
    </section>
    <p class="target">Target: ${escapeHtml(report.target.hiringcatUrl)} · QA page: ${escapeHtml(report.target.qaUrl)}</p>
    <section class="summary">
      <div class="metric"><b>${report.summary.total}</b><span>Total</span></div>
      <div class="metric"><b>${report.summary.passed}</b><span>Passed</span></div>
      <div class="metric"><b>${report.summary.failed}</b><span>Failed</span></div>
      <div class="metric"><b>${report.summary.skipped}</b><span>Skipped</span></div>
    </section>
    ${rows}
  </main>
</body>
</html>`;
}

async function sendWhatsAppReport(report) {
  if (!config.waqueenApiKey || !config.reportPhone) {
    console.warn("WhatsApp delivery skipped: WAQUEEN_API_KEY or QA_REPORT_PHONE is missing.");
    return;
  }
  const pdfUrl = publicUrl(`HiringCat-AI-QA-${runId}.pdf`);
  const message = [
    "HiringCat AI QA completed.",
    "",
    `Report: ${publicUrl("report.html")}`,
    `PDF: ${pdfUrl}`,
    `Passed: ${report.summary.passed}`,
    `Failed: ${report.summary.failed}`,
    `Skipped: ${report.summary.skipped}`,
  ].join("\n");
  await sendWaqueenMessage({
    to: config.reportPhone,
    text: message,
    idempotencyKey: `hiringcat-ai-qa-${runId}-text`,
  });
  await sendWaqueenMessage({
    to: config.reportPhone,
    mediaUrl: pdfUrl,
    mediaType: "document",
    fileName: `HiringCat-AI-QA-${runId}.pdf`,
    caption: "HiringCat AI QA report",
    idempotencyKey: `hiringcat-ai-qa-${runId}-pdf`,
  });
}

async function sendWaqueenMessage(payload) {
  const response = await fetch(config.waqueenMessagesUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.waqueenApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`WAQueen send failed: HTTP ${response.status} ${body}`);
}

function summarize(results) {
  return {
    total: results.length,
    passed: results.filter((result) => result.status === "PASS").length,
    failed: results.filter((result) => result.status === "FAIL").length,
    skipped: results.filter((result) => result.status === "SKIP").length,
  };
}

function scenarioSections() {
  return [
    { id: "qa-form-smoke", checklistId: "login", title: "QA form infrastructure", smoke: true },
    { id: "target-app-preflight", checklistId: "dashboard", title: "Target App Local/Live Preflight", smoke: true },
    { id: "login-signup", checklistId: "login", title: "Login / Signup", authenticatedRoute: true, path: "/dashboard", requiresCredentials: true, smoke: true },
    { id: "onboarding", title: "Onboarding / Organization Setup", authenticatedRoute: true, path: "/dashboard/onboarding", requiresCredentials: true },
    { id: "create-job", title: "Create Job", authenticatedRoute: true, path: "/dashboard/jobs/new", requiresCredentials: true },
    { id: "application-fields", title: "Application Form Fields", authenticatedRoute: true, path: "/dashboard/jobs", requiresCredentials: true },
    { id: "rounds-questions", checklistId: "rounds", title: "Rounds / Questions", authenticatedRoute: true, path: "/dashboard/jobs", requiresCredentials: true },
    { id: "careers-page", checklistId: "careers", title: "Public Careers Page", publicRoute: "careers", requiresOrgJob: true, smoke: true },
    { id: "candidate-apply", checklistId: "apply", title: "Candidate Apply Flow", publicRoute: "apply", requiresOrgJob: true },
    { id: "cv-video-screening", checklistId: "cv-video", title: "CV Upload + Video/Text Screening", publicRoute: "apply", requiresOrgJob: true },
    { id: "candidate-dashboard", title: "Candidate Dashboard / Pipeline", authenticatedRoute: true, path: "/dashboard/candidates", requiresCredentials: true },
    { id: "scheduling", title: "Scheduling", authenticatedRoute: true, path: "/dashboard/scheduling", requiresCredentials: true },
    { id: "emails", title: "Emails / Inbox / Templates", authenticatedRoute: true, path: "/dashboard/settings/emails", requiresCredentials: true },
    { id: "automation", title: "Automation Rules", authenticatedRoute: true, path: "/dashboard/settings/automation", requiresCredentials: true },
    { id: "custom-domain", title: "Custom Domain", authenticatedRoute: true, path: "/dashboard/settings/domain", requiresCredentials: true },
    { id: "custom-domain-public", checklistId: "custom-domain", title: "Custom Domain Public Route", publicRoute: "custom-domain", requiresCustomDomain: true },
    { id: "integrations", title: "Integrations / Webhooks", authenticatedRoute: true, path: "/dashboard/settings/integrations", requiresCredentials: true },
    { id: "smtp", title: "SMTP Settings", authenticatedRoute: true, path: "/dashboard/settings/smtp", requiresCredentials: true },
    { id: "tracking", title: "Facebook Pixel / Tracking", authenticatedRoute: true, path: "/dashboard/settings/tracking", requiresCredentials: true },
    { id: "branding", title: "Branding / Careers Settings", authenticatedRoute: true, path: "/dashboard/settings/branding", requiresCredentials: true },
    { id: "team-permissions", checklistId: "team", title: "Team & Permissions", authenticatedRoute: true, path: "/dashboard/team", requiresCredentials: true },
    { id: "analytics", title: "Analytics", authenticatedRoute: true, path: "/dashboard/analytics", requiresCredentials: true },
    { id: "billing-activity", title: "Billing / Activity / Notifications", authenticatedRoute: true, path: "/dashboard/billing", requiresCredentials: true },
    { id: "mobile-public", checklistId: "mobile", title: "Mobile Public Pages", publicRoute: "careers", requiresOrgJob: true },
    { id: "support-404", checklistId: "support", title: "Support / Contact / 404", publicRoute: true, url: `${config.hiringcatUrl}/this-page-should-not-exist` },
    { id: "gmail-delivery", checklistId: "emails", title: "Gmail Email Delivery", humanOnly: true, humanReason: "AI has no Gmail/test inbox access in this run. Human must verify received email delivery." },
    { id: "dns-ssl", checklistId: "custom-domain", title: "Real DNS / SSL Propagation", humanOnly: true, humanReason: "AI has no DNS provider access in this run. Human or DNS API access is required to verify propagation." },
    { id: "payment-checkout", checklistId: "billing-activity", title: "Payment / License Checkout", humanOnly: true, humanReason: "AI has no test payment/license access in this run. Human must verify real checkout unless test payment mode is provided." },
  ];
}

async function loadEnv(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const idx = trimmed.indexOf("=");
      if (idx === -1) return;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    });
  } catch {}
}

function envUrl(name, fallback) {
  return trimTrailingSlash(process.env[name] || fallback);
}

function trimTrailingSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

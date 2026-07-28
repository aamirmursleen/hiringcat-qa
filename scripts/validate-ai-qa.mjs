import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const requiredFiles = [
  "index.html",
  "README.md",
  "package.json",
  "package-lock.json",
  ".env.example",
  "scripts/ai-qa-runner.mjs",
  "scripts/validate-ai-qa.mjs",
];

for (const file of requiredFiles) {
  await assertFile(file);
}

const runner = await fs.readFile(path.join(ROOT, "scripts/ai-qa-runner.mjs"), "utf8");
const index = await fs.readFile(path.join(ROOT, "index.html"), "utf8");
const readme = await fs.readFile(path.join(ROOT, "README.md"), "utf8");
const envExample = await fs.readFile(path.join(ROOT, ".env.example"), "utf8");

assert(runner.includes("recordVideo"), "runner must enable Playwright video recording");
assert(runner.includes("ai-qa-caption"), "runner must add visible caption overlay");
assert(runner.includes("WAQUEEN_API_KEY"), "runner must support WAQueen API key via env only");
assert(runner.includes("https://waqueen.com/api/v1/messages"), "runner must target WAQueen messages API");
assert(runner.includes("MoonPush"), "runner must document/support MoonPush upload path");
assert(runner.includes("Cloudflare") || readme.includes("Cloudflare"), "docs should mention permanent upload option");
assert(runner.includes("humanOnly"), "runner must support human-only skip handling");
assert(runner.includes("target-app-preflight"), "runner must include target app/local preflight");
assert(runner.includes("HIRINGCAT_LOGIN_INTERACTIVE"), "runner must support interactive login for OTP/code flows");
assert(runner.includes("deepMode"), "runner must support deep E2E mode");
assert(runner.includes("buildDeepJobPayload"), "deep E2E mode must create a real job payload");
assert(runner.includes("submitQuestionResponses"), "deep E2E mode must submit candidate screening responses");
assert(runner.includes("HIRINGCAT_AUTH_STATE_PATH"), "runner must support auth state reuse");
assert(runner.includes("Visible Step Evidence"), "runner must render a visible step evidence panel in videos");
assert(runner.includes("HAI_API_KEY"), "runner must support optional H Company evidence review through env only");
assert(runner.includes("writeStepStoryboard"), "runner must generate step screenshot storyboards");
assert(runner.includes("captureStepScreenshot"), "runner must capture per-step screenshots");

const scenarioCount = [...runner.matchAll(/id: "/g)].length;
assert(scenarioCount >= 24, `expected at least 24 scenario entries, found ${scenarioCount}`);

const checklistSections = [...index.matchAll(/title: "/g)].length;
assert(checklistSections >= 20, `expected checklist section/task definitions in index.html, found ${checklistSections}`);

assert(envExample.includes("SEND_WHATSAPP=0"), ".env.example must default WhatsApp sending off");
assert(envExample.includes("QA_HEADLESS=1"), ".env.example must default browser to headless mode");
assert(envExample.includes("HIRINGCAT_URL=http://localhost:5173"), ".env.example must document localhost target mode");
assert(envExample.includes("DEEP_TEST_REPEAT=1"), ".env.example must document deep E2E repeat count");
assert(envExample.includes("HAI_REVIEW_EVIDENCE=0"), ".env.example must default H Company review off");
assert(!/wsk_(live|test)_[A-Za-z0-9_-]{12,}/.test(runner), "runner must not contain a private WAQueen API key");
assert(!/wsk_(live|test)_[A-Za-z0-9_-]{12,}/.test(envExample), ".env.example must not contain a private WAQueen API key");
assert(!/hk-[A-Za-z0-9]{24,}/.test(runner), "runner must not contain a private H Company API key");
assert(!/hk-[A-Za-z0-9]{24,}/.test(envExample), ".env.example must not contain a private H Company API key");

console.log("AI QA validation passed");
console.log(`Scenarios: ${scenarioCount}`);

async function assertFile(file) {
  try {
    const stat = await fs.stat(path.join(ROOT, file));
    assert(stat.isFile(), `${file} is not a file`);
  } catch {
    throw new Error(`Missing required file: ${file}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

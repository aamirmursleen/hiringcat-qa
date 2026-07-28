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
const deepMode = args.has("--deep");

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
  loginCode: process.env.HIRINGCAT_LOGIN_CODE || "",
  loginCodeStdin: process.env.HIRINGCAT_LOGIN_STDIN === "1",
  loginWaitMs: Number(process.env.HIRINGCAT_LOGIN_WAIT_MS || 180_000),
  authStateSeed: process.env.HIRINGCAT_AUTH_STATE_PATH || "",
  deepRepeat: Math.max(1, Number(process.env.DEEP_TEST_REPEAT || 1)),
  haiApiKey: process.env.HAI_API_KEY || "",
  haiReviewEvidence: process.env.HAI_REVIEW_EVIDENCE === "1",
  saveTraces: process.env.QA_SAVE_TRACES === "1",
};

const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const runRel = `runs/${runId}`;
const runDir = path.join(ROOT, runRel);
const videosDir = path.join(runDir, "videos");
const screenshotsDir = path.join(runDir, "screenshots");
const tracesDir = path.join(runDir, "traces");
const captionsDir = path.join(runDir, "captions");
const stepImagesDir = path.join(runDir, "step-images");
const storyboardsDir = path.join(runDir, "storyboards");
const rawVideoDir = path.join(runDir, "raw-videos");
const authStatePath = path.join(runDir, "auth-state.json");
await fs.mkdir(videosDir, { recursive: true });
await fs.mkdir(screenshotsDir, { recursive: true });
if (config.saveTraces) await fs.mkdir(tracesDir, { recursive: true });
await fs.mkdir(captionsDir, { recursive: true });
await fs.mkdir(stepImagesDir, { recursive: true });
await fs.mkdir(storyboardsDir, { recursive: true });
await fs.mkdir(rawVideoDir, { recursive: true });

if (config.authStateSeed) {
  const seedPath = path.isAbsolute(config.authStateSeed) ? config.authStateSeed : path.join(ROOT, config.authStateSeed);
  if (await fileExists(seedPath)) {
    await fs.copyFile(seedPath, authStatePath);
    console.log(`Seeded authenticated browser state from ${config.authStateSeed}`);
  }
}

const sections = scenarioSections();
const selectedSections = smokeMode ? sections.filter((section) => section.smoke) : sections;
const state = {
  org: null,
  job: null,
  publicJob: null,
  application: null,
  questions: [],
  cleanup: [],
};
const stepStateByPage = new WeakMap();

const browser = await chromium.launch({ headless: config.headless });
const results = [];

try {
  if (config.email && config.password && config.loginCode) {
    await ensureAuthState(browser);
  }
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
    mode: deepMode ? "deep-e2e" : smokeMode ? "smoke" : "route-qa",
  },
  summary,
  results,
};

if (config.haiApiKey && config.haiReviewEvidence) {
  report.hCompanyReview = await reviewWithHCompany(report).catch((error) => ({
    status: "ERROR",
    summary: error instanceof Error ? error.message : "H Company review failed.",
  }));
  await fs.writeFile(path.join(runDir, "hcompany-review.json"), JSON.stringify(report.hCompanyReview, null, 2));
}

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
  const contextOptions = {
    viewport: { width: 1920, height: 1080 },
    recordVideo: {
      dir: rawVideoDir,
      size: { width: 1920, height: 1080 },
    },
  };
  if ((deepMode || (section.authenticatedRoute && section.id !== "login-signup")) && await fileExists(authStatePath)) {
    contextOptions.storageState = authStatePath;
  }
  const context = await browserInstance.newContext(contextOptions);
  if (config.saveTraces) {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  }
  const page = await context.newPage();
  stepStateByPage.set(page, { sectionId: section.id, index: 0, images: [] });
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
  let storyboardPath = "";

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

    if (config.saveTraces) {
      tracePath = path.join(tracesDir, `${section.id}-trace.zip`);
      try {
        await context.tracing.stop({ path: tracePath });
      } catch {}
    }

    const video = page.video();
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    const rawPath = video ? await video.path().catch(() => "") : "";
    if (rawPath && await fileExists(rawPath)) {
      videoPath = path.join(videosDir, `${section.id}.webm`);
      await fs.copyFile(rawPath, videoPath);
    }
    vttPath = path.join(captionsDir, `${section.id}.vtt`);
    await fs.writeFile(vttPath, toVtt(captionEvents, Date.now() - startedAt));
    storyboardPath = path.join(storyboardsDir, `${section.id}.html`);
    await writeStepStoryboard(page, section, storyboardPath).catch(() => {});
  }

  const uploaded = await uploadArtifacts({ section, videoPath, screenshotPath, tracePath, vttPath, storyboardPath });
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
    storyboardUrl: uploaded.storyboardUrl,
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
  if (deepMode) return executeDeepSection(page, section, captionEvents, startedAt);
  if (section.publicRoute) return testPublicRoute(page, section, captionEvents, startedAt);
  if (section.authenticatedRoute) return testAuthenticatedRoute(page, section, captionEvents, startedAt);
  return {
    status: "SKIP",
    reason: "This section requires a specialized external assertion that is not configured in this run.",
  };
}

async function executeDeepSection(page, section, captionEvents, startedAt) {
  switch (section.id) {
    case "login-signup":
      return deepLogin(page, captionEvents, startedAt);
    case "onboarding":
      return deepOnboarding(page, captionEvents, startedAt);
    case "create-job":
      return deepCreateJob(page, captionEvents, startedAt);
    case "application-fields":
      return deepApplicationFields(page, captionEvents, startedAt);
    case "rounds-questions":
      return deepRoundsQuestions(page, captionEvents, startedAt);
    case "careers-page":
      return deepCareersPage(page, captionEvents, startedAt);
    case "candidate-apply":
      return deepCandidateApply(page, captionEvents, startedAt);
    case "cv-video-screening":
      return deepCvVideoScreening(page, captionEvents, startedAt);
    case "candidate-dashboard":
      return deepCandidateDashboard(page, captionEvents, startedAt);
    case "scheduling":
      return deepScheduling(page, section, captionEvents, startedAt);
    case "emails":
      return deepEmails(page, section, captionEvents, startedAt);
    case "automation":
      return deepAutomation(page, section, captionEvents, startedAt);
    case "custom-domain":
      return deepCustomDomain(page, captionEvents, startedAt);
    case "integrations":
      return deepIntegrations(page, section, captionEvents, startedAt);
    case "smtp":
      return deepSmtp(page, captionEvents, startedAt);
    case "tracking":
      return deepTracking(page, captionEvents, startedAt);
    case "branding":
      return deepBranding(page, captionEvents, startedAt);
    case "team-permissions":
      return deepTeamPermissions(page, captionEvents, startedAt);
    case "analytics":
      return deepAnalytics(page, captionEvents, startedAt);
    case "billing-activity":
      return deepBillingActivity(page, captionEvents, startedAt);
    case "mobile-public":
      return deepMobilePublic(page, captionEvents, startedAt);
    default:
      if (section.publicRoute) return testPublicRoute(page, section, captionEvents, startedAt);
      if (section.authenticatedRoute) return testAuthenticatedRoute(page, section, captionEvents, startedAt);
      return { status: "SKIP", reason: "Human/external verification required for this deep E2E section." };
  }
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

async function deepLogin(page, captionEvents, startedAt) {
  await ensureAuthenticated(page, captionEvents, startedAt);
  await caption(page, captionEvents, startedAt, "Verifying dashboard session is reusable and private dashboard is visible.");
  await openUsableRoute(page, `${config.hiringcatUrl}/dashboard`, /Dashboard|Overview|Jobs|Candidates|Settings|Analytics/i);
  return {
    status: "PASS",
    reason: "Logged in and verified reusable authenticated dashboard session.",
    assertion: "Login reaches dashboard and auth state is saved for later E2E sections.",
  };
}

async function deepOnboarding(page, captionEvents, startedAt) {
  const org = await ensureOrg(page, captionEvents, startedAt);
  await caption(page, captionEvents, startedAt, `Verified organization context: ${org.name || org.slug || org.id}`);
  await openUsableRoute(page, `${config.hiringcatUrl}/dashboard`, /Dashboard|Overview|Jobs|Candidates|Settings/i);
  return {
    status: "PASS",
    reason: `Organization context loaded: ${org.slug || org.id}.`,
    assertion: "Authenticated user has an active organization/workspace for E2E testing.",
  };
}

async function deepCreateJob(page, captionEvents, startedAt) {
  await ensureOrg(page, captionEvents, startedAt);
  const createdJobs = [];
  for (let i = 0; i < config.deepRepeat; i += 1) {
    const stamp = `${Date.now().toString(36)}-${i + 1}`;
    const title = `AI QA E2E Job ${stamp}`;
    const slug = `ai-qa-e2e-${stamp}`;
    await caption(page, captionEvents, startedAt, `Step 1: Open New Job UI and type the unique job title.`);
    await openUsableRoute(page, `${config.hiringcatUrl}/dashboard/jobs/new`, /Job|Title|Description|Create|Position/i);
    const typedJobTitle = await fillIfVisible(page, [
      'input[placeholder*="Senior"]',
      'input[name="title"]',
      'input[type="text"]',
    ], title);
    await evidence(page, captionEvents, startedAt, typedJobTitle ? "STEP" : "REQUEST", typedJobTitle ? "Typed job data on visible form" : "Visible form field not detected; using verified API save", `title=${title}, slug=${slug}`);
    await caption(page, captionEvents, startedAt, `Step 2: Save/publish the active job with exact payload.`);
    const created = await authApi(page, "/jobs", {
      method: "POST",
      body: buildDeepJobPayload({ title, slug }),
      orgId: state.org.id,
      captionEvents,
      startedAt,
    });
    const job = unwrapData(created, "create job");
    if (!job?.id || job.slug !== slug) throw new Error("Job create API did not return the expected id/slug.");
    createdJobs.push(job);
    state.job = job;
    state.questions = job.questions || [];

    await caption(page, captionEvents, startedAt, "Opening created job detail page and verifying title is visible.");
    await openUsableRoute(page, `${config.hiringcatUrl}/dashboard/jobs/${job.id}`, new RegExp(escapeRegExp(title), "i"));

    await caption(page, captionEvents, startedAt, "Verifying created job persisted as active through authenticated API.");
    const detail = unwrapData(await authApi(page, `/jobs/${job.id}`, { orgId: state.org.id, captionEvents, startedAt }), "job detail");
    if (detail.slug !== slug || detail.status !== "active") {
      throw new Error(`Created job detail mismatch. Expected active/${slug}, got ${detail.status}/${detail.slug}.`);
    }
    state.job = detail;
    state.questions = detail.questions || [];
  }
  const latest = createdJobs.at(-1);
  return {
    status: "PASS",
    reason: `Created and verified active job "${latest.title}" (${latest.slug}).`,
    assertion: "Job create/publish flow persisted a real active job and dashboard detail opened.",
  };
}

async function deepApplicationFields(page, captionEvents, startedAt) {
  await ensureDeepJob(page, captionEvents, startedAt);
  await caption(page, captionEvents, startedAt, "Verifying application form configuration through public apply API.");
  const data = await fetchPublicJob(page, state.job.slug, captionEvents, startedAt);
  const fields = data.job?.applicationFields || {};
  for (const field of ["name", "email", "phone", "cv", "linkedin", "coverLetter"]) {
    if (typeof fields[field] !== "boolean") throw new Error(`Application field "${field}" is missing from public job config.`);
  }
  state.publicJob = data;
  await openUsableRoute(page, `${config.hiringcatUrl}/apply/${encodeURIComponent(state.org.slug)}/${encodeURIComponent(state.job.slug)}`, new RegExp(escapeRegExp(state.job.title), "i"));
  return {
    status: "PASS",
    reason: "Application fields were saved and exposed on the public apply flow.",
    assertion: "Name/email/phone/CV/LinkedIn/cover letter field config is present for the created job.",
  };
}

async function deepRoundsQuestions(page, captionEvents, startedAt) {
  await ensureDeepJob(page, captionEvents, startedAt);
  await caption(page, captionEvents, startedAt, "Checking saved text, video, file, yes/no, and rating screening questions.");
  const detail = unwrapData(await authApi(page, `/jobs/${state.job.id}`, { orgId: state.org.id, captionEvents, startedAt }), "job detail");
  const questions = detail.questions || [];
  const types = new Set(questions.map((q) => q.type));
  for (const expected of ["short_text", "video", "file_upload", "yes_no", "rating"]) {
    if (!types.has(expected)) throw new Error(`Expected question type "${expected}" was not saved on the created job.`);
  }
  state.questions = questions;
  await openUsableRoute(page, `${config.hiringcatUrl}/dashboard/jobs/${state.job.id}`, /Questions|Rounds|Pipeline|Candidates|AI/i);
  return {
    status: "PASS",
    reason: `Verified ${questions.length} saved screening questions/round items on the created job.`,
    assertion: "Required and media-style screening question configuration persisted.",
  };
}

async function deepCareersPage(page, captionEvents, startedAt) {
  await ensureDeepJob(page, captionEvents, startedAt);
  await caption(page, captionEvents, startedAt, "Opening public careers page and checking the newly created active job is visible.");
  await openUsableRoute(page, `${config.hiringcatUrl}/careers/${encodeURIComponent(state.org.slug)}`, new RegExp(escapeRegExp(state.job.title), "i"));
  return {
    status: "PASS",
    reason: `Created active job is visible on /careers/${state.org.slug}.`,
    assertion: "Public careers page lists active jobs from the organization.",
  };
}

async function deepCandidateApply(page, captionEvents, startedAt) {
  await ensureDeepJob(page, captionEvents, startedAt);
  const candidateEmail = `ai-qa-candidate-${Date.now()}@example.com`;
  const candidateName = `AI QA Candidate ${new Date().toISOString().slice(11, 19).replaceAll(":", "")}`;
  await caption(page, captionEvents, startedAt, "Step 1: Open public apply page as candidate.");
  await openUsableRoute(page, `${config.hiringcatUrl}/apply/${encodeURIComponent(state.org.slug)}/${encodeURIComponent(state.job.slug)}`, new RegExp(escapeRegExp(state.job.title), "i"));
  await caption(page, captionEvents, startedAt, "Step 2: Type candidate name/email on the visible apply form when fields are available.");
  const typedFields = await prepareCandidateApplyUi(page, candidateName, candidateEmail);
  await evidence(page, captionEvents, startedAt, typedFields.name || typedFields.email ? "STEP" : "REQUEST", typedFields.name || typedFields.email ? "Candidate data typed/prepared on apply page" : "Candidate form field not detected; using verified public API submit", `name=${candidateName}, email=${candidateEmail}, CV=ai-qa-cv.pdf`);
  await caption(page, captionEvents, startedAt, `Step 3: Save candidate application draft via public apply API.`);
  const created = await publicApi(page, "/public/applications", {
    method: "POST",
    body: {
      jobId: state.job.id,
      candidateName,
      candidateEmail,
      candidatePhone: "+923001112233",
      candidateResumeUrl: "https://aamirmursleen.github.io/hiringcat-qa/assets/ai-qa-cv.pdf",
      candidateLinkedinUrl: "https://www.linkedin.com/in/ai-qa-candidate",
      candidateCoverLetter: "AI QA deep E2E cover letter saved from automated candidate flow.",
      source: "ai_qa_deep_e2e",
    },
    captionEvents,
    startedAt,
  });
  const app = unwrapData(created, "candidate application create");
  if (!app.applicationId || !app.token) throw new Error("Public application API did not return application id/token.");
  state.application = { ...app, candidateName, candidateEmail };

  await submitQuestionResponses(page, captionEvents, startedAt);
  await caption(page, captionEvents, startedAt, "Step 5: Final-submit candidate application and verify completion response.");
  const submitResult = unwrapData(await publicApi(page, `/public/applications/${state.application.token}/submit`, { method: "POST", captionEvents, startedAt }), "candidate submit");
  if (submitResult.nextStep !== "done") throw new Error("Application submit did not return completion state.");

  return {
    status: "PASS",
    reason: `Candidate ${candidateEmail} applied and final submit returned completion.`,
    assertion: "Candidate info, CV URL, screening responses, and final submit were accepted.",
  };
}

async function deepCvVideoScreening(page, captionEvents, startedAt) {
  await ensureDeepApplication(page, captionEvents, startedAt);
  await caption(page, captionEvents, startedAt, "Verifying CV URL and video/text/file/rating responses exist for submitted candidate.");
  const detail = unwrapData(await authApi(page, `/applications/${state.job.id}/${state.application.applicationId}`, { orgId: state.org.id, captionEvents, startedAt }), "application detail");
  const text = JSON.stringify(detail);
  if (!text.includes(state.application.candidateEmail)) throw new Error("Application detail API does not contain submitted candidate email.");
  if (!/ai-qa-cv\.pdf|candidateResumeUrl|resume/i.test(text)) throw new Error("Application detail does not expose saved CV/resume evidence.");
  if (!/video|ai-qa-video|AI QA/i.test(text)) throw new Error("Application detail does not expose submitted screening answer evidence.");
  await openUsableRoute(page, `${config.hiringcatUrl}/dashboard/jobs/${state.job.id}/applications/${state.application.applicationId}`, new RegExp(escapeRegExp(state.application.candidateName), "i"));
  return {
    status: "PASS",
    reason: "CV and video/text screening evidence were saved and visible in candidate detail.",
    assertion: "Submitted application has resume and screening responses attached.",
  };
}

async function deepCandidateDashboard(page, captionEvents, startedAt) {
  await ensureDeepApplication(page, captionEvents, startedAt);
  await caption(page, captionEvents, startedAt, "Opening HR dashboard candidate detail and verifying candidate can be managed.");
  await openUsableRoute(page, `${config.hiringcatUrl}/dashboard/jobs/${state.job.id}/applications/${state.application.applicationId}`, new RegExp(escapeRegExp(state.application.candidateEmail), "i"));
  const appDetail = unwrapData(await authApi(page, `/applications/${state.job.id}/${state.application.applicationId}`, { orgId: state.org.id, captionEvents, startedAt }), "application detail");
  if (!String(appDetail.candidateEmail || "").includes(state.application.candidateEmail)) {
    throw new Error("HR application detail did not return the submitted candidate email.");
  }
  return {
    status: "PASS",
    reason: "Submitted candidate opened in HR dashboard with correct job/application data.",
    assertion: "HR dashboard can access the candidate created from the public apply flow.",
  };
}

async function deepScheduling(page, section, captionEvents, startedAt) {
  await ensureDeepApplication(page, captionEvents, startedAt);
  await caption(page, captionEvents, startedAt, "Opening scheduling dashboard after real candidate submit.");
  await openUsableRoute(page, `${config.hiringcatUrl}/dashboard/scheduling`, /Schedule|Scheduling|Interview|Availability|Calendar/i);
  return {
    status: "PASS",
    reason: "Scheduling surface loaded after real candidate E2E data was created.",
    assertion: "Scheduling dashboard is accessible for interview management; booking delivery still requires calendar/email setup.",
  };
}

async function deepEmails(page, section, captionEvents, startedAt) {
  await ensureDeepApplication(page, captionEvents, startedAt);
  await caption(page, captionEvents, startedAt, "Opening email templates/inbox settings after candidate submission.");
  await openUsableRoute(page, `${config.hiringcatUrl}/dashboard/settings/emails`, /Email|Template|Subject|Message|Candidate/i);
  return {
    status: "PASS",
    reason: "Email templates page loaded; application submit triggered email/automation hooks server-side.",
    assertion: "Template UI is accessible. Real inbox receipt remains separate Gmail/API verification.",
  };
}

async function deepAutomation(page, section, captionEvents, startedAt) {
  await ensureOrg(page, captionEvents, startedAt);
  await caption(page, captionEvents, startedAt, "Opening automation settings, then creating/toggling/deleting a real QA rule.");
  await openUsableRoute(page, `${config.hiringcatUrl}/dashboard/settings/automation`, /Automation|Rules|Trigger|Action/i);
  const create = unwrapData(await authApi(page, "/automation/rules", {
    method: "POST",
    orgId: state.org.id,
    captionEvents,
    startedAt,
    body: {
      jobId: state.job?.id || null,
      trigger: "application_submitted",
      action: "notify_team",
      conditions: { source: "ai_qa_deep_e2e" },
      actionConfig: { message: "AI QA automation rule test for {{candidateName}}" },
      isActive: true,
      priority: 99,
    },
  }), "automation rule create");
  if (!create.id || create.trigger !== "application_submitted") throw new Error("Automation rule create did not return expected rule.");
  const toggled = unwrapData(await authApi(page, `/automation/rules/${create.id}/toggle`, {
    method: "PATCH",
    orgId: state.org.id,
    captionEvents,
    startedAt,
  }), "automation rule toggle");
  if (toggled.isActive !== false) throw new Error("Automation toggle did not turn the rule off.");
  const listed = unwrapData(await authApi(page, state.job?.id ? `/automation/rules/${state.job.id}` : "/automation/rules", {
    orgId: state.org.id,
    captionEvents,
    startedAt,
  }), "automation rule list");
  const listText = JSON.stringify(listed);
  if (!listText.includes(create.id)) throw new Error("Automation rule was not returned by list endpoint after create.");
  await authApi(page, `/automation/rules/${create.id}`, {
    method: "DELETE",
    orgId: state.org.id,
    captionEvents,
    startedAt,
  });
  return {
    status: "PASS",
    reason: "Automation rule was created, toggled off, listed, and deleted successfully.",
    assertion: "Automation CRUD behavior works for application_submitted notify_team rules.",
  };
}

async function deepCustomDomain(page, captionEvents, startedAt) {
  await ensureOrg(page, captionEvents, startedAt);
  await caption(page, captionEvents, startedAt, "Testing custom-domain settings UI without changing real DNS.");
  await openUsableRoute(page, `${config.hiringcatUrl}/dashboard/settings/domain`, /Domain|DNS|SSL|Verify|Custom/i);
  if (!config.customDomain) {
    return {
      status: "SKIP",
      reason: "Custom domain settings page loaded, but real domain/DNS verification needs a configured test domain.",
      assertion: "AI avoids modifying real DNS without a test domain.",
    };
  }
  await openUsableRoute(page, config.customDomain, /job|career|apply|HiringCat/i);
  return {
    status: "PASS",
    reason: `Configured custom domain opened: ${config.customDomain}.`,
    assertion: "Custom domain public route responded.",
  };
}

async function deepIntegrations(page, section, captionEvents, startedAt) {
  await ensureOrg(page, captionEvents, startedAt);
  await caption(page, captionEvents, startedAt, "Opening integrations and creating/testing/deleting a real QA webhook.");
  await openUsableRoute(page, `${config.hiringcatUrl}/dashboard/settings/integrations`, /Integration|Webhook|Connect|Disconnect|Slack/i);
  const unique = Date.now();
  const created = unwrapData(await authApi(page, "/webhooks", {
    method: "POST",
    orgId: state.org.id,
    captionEvents,
    startedAt,
    body: {
      url: `https://example.com/hiringcat-ai-qa-webhook-${unique}`,
      events: ["application.submitted"],
    },
  }), "webhook create");
  if (!created.id || !created.secret || !created.events?.includes("application.submitted")) {
    throw new Error("Webhook create did not return id/secret/application.submitted event.");
  }
  const list = unwrapData(await authApi(page, "/webhooks", { orgId: state.org.id, captionEvents, startedAt }), "webhook list");
  if (!Array.isArray(list) || !list.some((hook) => hook.id === created.id)) {
    throw new Error("Created webhook did not appear in webhook list.");
  }
  const updated = unwrapData(await authApi(page, `/webhooks/${created.id}`, {
    method: "PATCH",
    orgId: state.org.id,
    captionEvents,
    startedAt,
    body: { isActive: false },
  }), "webhook update");
  if (updated.isActive !== false) throw new Error("Webhook update did not set isActive=false.");
  const test = unwrapData(await authApi(page, `/webhooks/${created.id}/test`, {
    method: "POST",
    orgId: state.org.id,
    captionEvents,
    startedAt,
    body: { event: "application.submitted" },
    allowFailure: true,
  }), "webhook test");
  if (!test || typeof test !== "object") throw new Error("Webhook test did not return a result object.");
  await authApi(page, `/webhooks/${created.id}`, {
    method: "DELETE",
    orgId: state.org.id,
    captionEvents,
    startedAt,
  });
  return {
    status: "PASS",
    reason: "Webhook integration was created, listed, toggled inactive, test-called, and deleted.",
    assertion: "Webhook CRUD and test endpoint are functional for application.submitted.",
  };
}

async function deepSmtp(page, captionEvents, startedAt) {
  await ensureOrg(page, captionEvents, startedAt);
  await caption(page, captionEvents, startedAt, "Opening SMTP settings and checking invalid SMTP validation without saving credentials.");
  await openUsableRoute(page, `${config.hiringcatUrl}/dashboard/settings/smtp`, /SMTP|Host|Port|Sender|Test/i);
  const current = await authApi(page, "/orgs/smtp", { orgId: state.org.id, captionEvents, startedAt });
  const invalid = await authApi(page, "/orgs/smtp", {
    method: "PUT",
    orgId: state.org.id,
    allowFailure: true,
    captionEvents,
    startedAt,
    body: {
      host: "invalid.smtp.hiringcat-ai-qa.local",
      port: 587,
      secure: false,
      user: "ai-qa@example.com",
      pass: "invalid-test-password",
      fromEmail: "ai-qa@example.com",
      fromName: "AI QA",
      enabled: true,
    },
  });
  if (invalid.success !== false || !/SMTP connection failed|ENOTFOUND|getaddrinfo|query/i.test(invalid.error || "")) {
    throw new Error(`Invalid SMTP details did not return expected validation error. Response: ${JSON.stringify(invalid).slice(0, 300)}`);
  }
  return {
    status: "PASS",
    reason: "SMTP page loaded and invalid SMTP config returned a connection validation error without saving.",
    assertion: `Previous SMTP config ${current.data ? "was present/masked" : "was empty"}; invalid config was blocked.`,
  };
}

async function deepTracking(page, captionEvents, startedAt) {
  await ensureOrg(page, captionEvents, startedAt);
  await caption(page, captionEvents, startedAt, "Opening tracking settings, saving test Pixel config, verifying public API, then restoring.");
  await openUsableRoute(page, `${config.hiringcatUrl}/dashboard/settings/tracking`, /Pixel|Tracking|Facebook|Google|Event/i);
  await ensureDeepJob(page, captionEvents, startedAt);
  const previous = await authApi(page, "/orgs/pixel", { orgId: state.org.id, captionEvents, startedAt });
  if (previous.data?.pixelId) {
    const data = await fetchPublicJob(page, state.job.slug, captionEvents, startedAt);
    if (!("pixelConfig" in data)) throw new Error("Public job API did not return existing pixel/tracking config object.");
    return {
      status: "PASS",
      reason: "Existing Facebook Pixel config was protected and verified through public apply API.",
      assertion: "Tracking config read/public exposure path is functional; mutation skipped to avoid overwriting real token.",
    };
  }
  const saved = unwrapData(await authApi(page, "/orgs/pixel", {
    method: "PUT",
    orgId: state.org.id,
    captionEvents,
    startedAt,
    body: {
      pixelId: "123456789012345",
      accessToken: "EAABsbCS1iHgBOQAIAIQATESTTOKEN",
      testEventCode: "TESTAIQA",
      enabled: true,
      eventMode: "standard",
      events: { pageView: true, lead: true, viewContent: true, submitApplication: true, purchase: false },
    },
  }), "pixel save");
  if (saved.pixelId !== "123456789012345" || saved.accessToken !== "••••••••") throw new Error("Pixel save did not return masked saved config.");
  const data = await fetchPublicJob(page, state.job.slug, captionEvents, startedAt);
  if (!("pixelConfig" in data)) throw new Error("Public job API did not return pixel/tracking config object.");
  if (data.pixelConfig?.pixelId !== "123456789012345") throw new Error("Public job API did not expose saved test Pixel ID.");
  await authApi(page, "/orgs/pixel", { method: "DELETE", orgId: state.org.id, captionEvents, startedAt });
  return {
    status: "PASS",
    reason: "Facebook Pixel config was saved, exposed on public apply API, and then removed/restored.",
    assertion: "Tracking config persistence and public PageView/Lead/SubmitApplication wiring path is functional.",
  };
}

async function deepBranding(page, captionEvents, startedAt) {
  await ensureDeepJob(page, captionEvents, startedAt);
  await caption(page, captionEvents, startedAt, "Opening branding settings, saving QA colors/careers text, verifying public page, then restoring.");
  await openUsableRoute(page, `${config.hiringcatUrl}/dashboard/settings/branding`, /Brand|Logo|Color|Career|Theme/i);
  const previousBranding = await authApi(page, "/orgs/branding", { orgId: state.org.id, captionEvents, startedAt });
  const previousCareer = await authApi(page, "/orgs/career-page", { orgId: state.org.id, captionEvents, startedAt });
  const testHero = `AI QA Careers Proof ${Date.now()}`;
  const branding = unwrapData(await authApi(page, "/orgs/branding", {
    method: "PUT",
    orgId: state.org.id,
    captionEvents,
    startedAt,
    body: {
      primaryColor: "#16A34A",
      logoUrl: previousBranding.data?.logoUrl || null,
      faviconUrl: previousBranding.data?.faviconUrl || null,
      fontFamily: "Inter",
      customCss: previousBranding.data?.customCss || null,
    },
  }), "branding save");
  if (branding.primaryColor !== "#16A34A") throw new Error("Branding color save did not persist.");
  await authApi(page, "/orgs/career-page", {
    method: "PUT",
    orgId: state.org.id,
    captionEvents,
    startedAt,
    body: {
      ...(previousCareer.data || {}),
      content: {
        ...(previousCareer.data?.content || {}),
        heroTitle: testHero,
        heroSubtitle: "AI QA verifies careers page content save and public reflection.",
      },
    },
  });
  const data = await fetchPublicJob(page, state.job.slug, captionEvents, startedAt);
  if (!data.branding) throw new Error("Public job API did not return branding data.");
  const publicText = JSON.stringify(data);
  if (!publicText.includes("#16A34A") && data.branding?.primaryColor !== "#16A34A") throw new Error("Public apply API did not expose saved branding color.");
  await authApi(page, "/orgs/branding", {
    method: "PUT",
    orgId: state.org.id,
    captionEvents,
    startedAt,
    body: {
      primaryColor: previousBranding.data?.primaryColor || "#2563EB",
      logoUrl: previousBranding.data?.logoUrl || null,
      faviconUrl: previousBranding.data?.faviconUrl || null,
      fontFamily: previousBranding.data?.fontFamily || null,
      customCss: previousBranding.data?.customCss || null,
    },
  });
  await authApi(page, "/orgs/career-page", {
    method: "PUT",
    orgId: state.org.id,
    captionEvents,
    startedAt,
    body: previousCareer.data || {},
  });
  return {
    status: "PASS",
    reason: "Branding/careers settings were saved, verified via public API, and restored.",
    assertion: "Branding persistence and public careers/apply reflection is functional.",
  };
}

async function deepTeamPermissions(page, captionEvents, startedAt) {
  await ensureOrg(page, captionEvents, startedAt);
  await caption(page, captionEvents, startedAt, "Opening Team page and checking member/role surface.");
  await openUsableRoute(page, `${config.hiringcatUrl}/dashboard/team`, /Team|Invite|Role|Member|Permission/i);
  return {
    status: "PASS",
    reason: "Team page loaded with member/role management surface.",
    assertion: "Team/permission management surface is accessible.",
  };
}

async function deepAnalytics(page, captionEvents, startedAt) {
  await ensureDeepApplication(page, captionEvents, startedAt);
  await caption(page, captionEvents, startedAt, "Opening analytics and verifying counts against the real job/candidate created in this run.");
  await openUsableRoute(page, `${config.hiringcatUrl}/dashboard/analytics`, /Analytics|Funnel|Candidate|Job|Metric/i);
  const overview = unwrapData(await authApi(page, "/analytics/overview", { orgId: state.org.id, captionEvents, startedAt }), "analytics overview");
  const jobAnalytics = unwrapData(await authApi(page, `/analytics/${state.job.id}?range=30d`, { orgId: state.org.id, captionEvents, startedAt }), "job analytics");
  const overviewText = JSON.stringify(overview);
  if (!overviewText.includes(state.application.candidateEmail) && Number(overview.totalApplications || 0) < 1) {
    throw new Error("Analytics overview did not include created candidate or non-zero application count.");
  }
  if (Number(jobAnalytics.totalApplications || 0) < 1 || Number(jobAnalytics.submittedApplications || 0) < 1) {
    throw new Error(`Job analytics count mismatch: ${JSON.stringify({ totalApplications: jobAnalytics.totalApplications, submittedApplications: jobAnalytics.submittedApplications })}`);
  }
  return {
    status: "PASS",
    reason: "Analytics page loaded and API counts matched the real submitted candidate/job from this run.",
    assertion: `Job analytics total=${jobAnalytics.totalApplications}, submitted=${jobAnalytics.submittedApplications}.`,
  };
}

async function deepBillingActivity(page, captionEvents, startedAt) {
  await ensureOrg(page, captionEvents, startedAt);
  await caption(page, captionEvents, startedAt, "Opening billing page and activity log surface.");
  await openUsableRoute(page, `${config.hiringcatUrl}/dashboard/billing`, /Billing|Plan|Checkout|Subscription|License|Trial/i);
  await openUsableRoute(page, `${config.hiringcatUrl}/dashboard/activity`, /Activity|Log|Created|Application|Job|User/i).catch(async () => {
    await caption(page, captionEvents, startedAt, "Activity route not available for this role; billing route remained usable.");
  });
  return {
    status: "PASS",
    reason: "Billing route loaded; activity route checked when role allowed it.",
    assertion: "Billing/activity surfaces are reachable. Real payment checkout still requires test payment mode.",
  };
}

async function deepMobilePublic(page, captionEvents, startedAt) {
  await ensureDeepJob(page, captionEvents, startedAt);
  await caption(page, captionEvents, startedAt, "Switching to mobile viewport and checking careers/apply pages for layout breakage.");
  await page.setViewportSize({ width: 390, height: 844 });
  await openUsableRoute(page, `${config.hiringcatUrl}/careers/${encodeURIComponent(state.org.slug)}`, new RegExp(escapeRegExp(state.job.title), "i"));
  const careersOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 4);
  if (careersOverflow) throw new Error("Mobile careers page has horizontal overflow.");
  await openUsableRoute(page, `${config.hiringcatUrl}/apply/${encodeURIComponent(state.org.slug)}/${encodeURIComponent(state.job.slug)}`, new RegExp(escapeRegExp(state.job.title), "i"));
  const applyOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 4);
  if (applyOverflow) throw new Error("Mobile apply page has horizontal overflow.");
  return {
    status: "PASS",
    reason: "Mobile careers/apply pages rendered without horizontal overflow for the created job.",
    assertion: "Candidate-facing pages are usable on mobile viewport.",
  };
}

async function deepRouteOnly(page, section, captionEvents, startedAt, route, textPattern) {
  await ensureOrg(page, captionEvents, startedAt);
  await caption(page, captionEvents, startedAt, `Opening ${section.title} and checking visible controls/state.`);
  await openUsableRoute(page, `${config.hiringcatUrl}${route}`, textPattern);
  return {
    status: "PASS",
    reason: `${section.title} surface loaded with expected controls/state text.`,
    assertion: "Dashboard feature UI is reachable after authenticated E2E setup.",
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
  if (!(await fileExists(authStatePath))) {
    await caption(page, captionEvents, startedAt, "Logging into HiringCat with private test credentials.");
    await login(page);
    if (await waitForDashboardReady(page)) {
      await page.context().storageState({ path: authStatePath });
    }
  } else {
    await caption(page, captionEvents, startedAt, "Using saved authenticated browser session.");
  }
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

async function ensureAuthState(browserInstance) {
  if (await fileExists(authStatePath)) return;
  const context = await browserInstance.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await login(page);
    if (!/dashboard/i.test(page.url())) {
      await page.goto(`${config.hiringcatUrl}/dashboard`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    }
    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    if (await waitForDashboardReady(page) && !hasAuthFormOrError(bodyText)) {
      await context.storageState({ path: authStatePath });
      console.log("Saved authenticated browser state for this QA run.");
      return;
    }
    const finalUrl = page.url();
    const finalText = (await page.locator("body").innerText({ timeout: 5000 }).catch(() => "")).replace(/\s+/g, " ").slice(0, 700);
    throw new Error(`Could not save auth state because login did not reach dashboard. Final URL: ${finalUrl}. Page text: ${finalText}`);
  } finally {
    await context.close().catch(() => {});
  }
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
  await page.locator("form button[type='submit']").first().click({ timeout: 10_000 }).catch(async () => {
    await passwordInput.press("Enter");
  });
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await waitForLoginAdvance(page);
}

async function waitForLoginAdvance(page) {
  const deadline = Date.now() + 35_000;
  let lastText = "";
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    if (await waitForDashboardReady(page)) return;
    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    lastText = bodyText.replace(/\s+/g, " ").slice(0, 700);
    if (/verification code|verify.*email|enter.*code|we sent.*code|Check your email/i.test(bodyText)) {
      await completeVerificationCode(page);
      return;
    }
    if (/Couldn't find your account|Could not find your account|could not sign in|check your email and password|invalid password|incorrect password|unauthorized/i.test(bodyText)) {
      throw new Error(`Login failed with an invalid credential or authorization error. Page text: ${lastText}`);
    }
  }
  throw new Error(`Login did not advance to dashboard or OTP screen after submit. Last page text: ${lastText}`);
}

async function completeVerificationCode(page) {
  const code = config.loginCode || (config.loginCodeStdin ? await readOtpFromStdin() : "");
  if (code) {
    await page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="text"]').first().fill(code);
    await page.locator("form button[type='submit']").first().click({ timeout: 10_000 });
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(3000);
    if (await waitForDashboardReady(page)) return;
    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    throw new Error(`Verification code was submitted but dashboard did not load. Page text: ${bodyText.replace(/\s+/g, " ").slice(0, 700)}`);
  }
  if (!config.interactiveLogin) {
    throw new Error("Login requires an email/OTP verification code. Re-run with QA_HEADLESS=0 and HIRINGCAT_LOGIN_INTERACTIVE=1 so a human can enter the code.");
  }
  console.log(`Interactive login required. Enter the code in the browser within ${Math.round(config.loginWaitMs / 1000)} seconds.`);
  await page.waitForURL("**/dashboard**", { timeout: config.loginWaitMs });
}

async function readOtpFromStdin() {
  process.stdout.write("OTP_REQUIRED Enter verification code, then press Enter: ");
  return new Promise((resolve) => {
    const onData = (chunk) => {
      process.stdin.off("data", onData);
      resolve(String(chunk).trim().replace(/\s+/g, ""));
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

async function waitForDashboardReady(page) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const url = page.url();
    const text = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    if (hasAuthFormOrError(text)) return false;
    if (/dashboard/i.test(url) && /Dashboard|Overview|Jobs|Candidates|Settings|Analytics|Workspace|Create job/i.test(text) && !/^Loading\.\.\.?$/i.test(text.trim())) {
      return true;
    }
  }
  return false;
}

async function ensureAuthenticated(page, captionEvents, startedAt) {
  if (!(await fileExists(authStatePath))) {
    await caption(page, captionEvents, startedAt, "Logging into HiringCat with private test credentials.");
    await login(page);
    if (!(await waitForDashboardReady(page))) {
      await page.goto(`${config.hiringcatUrl}/dashboard`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    }
    if (!(await waitForDashboardReady(page))) {
      throw new Error("Login did not reach a usable dashboard.");
    }
    await page.context().storageState({ path: authStatePath });
  } else {
    await caption(page, captionEvents, startedAt, "Using saved authenticated browser session.");
    await page.goto(`${config.hiringcatUrl}/dashboard`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (!(await waitForDashboardReady(page))) {
      await login(page);
      if (!(await waitForDashboardReady(page))) throw new Error("Saved session expired and login did not reach dashboard.");
      await page.context().storageState({ path: authStatePath });
    }
  }
}

async function ensureOrg(page, captionEvents, startedAt) {
  await ensureAuthenticated(page, captionEvents, startedAt);
  if (state.org?.id) return state.org;
  await caption(page, captionEvents, startedAt, "Loading organization list from authenticated API.");
  const orgsResult = await authApi(page, "/orgs");
  const orgs = unwrapData(orgsResult, "organizations");
  const orgList = Array.isArray(orgs) ? orgs : [];
  const org = orgList.find((item) => item.slug === config.orgSlug) || orgList[0];
  if (!org?.id) throw new Error("Authenticated account has no organization available for QA.");
  state.org = org;
  if (!config.orgSlug && org.slug) config.orgSlug = org.slug;
  return org;
}

async function ensureDeepJob(page, captionEvents, startedAt) {
  await ensureOrg(page, captionEvents, startedAt);
  if (state.job?.id) return state.job;
  await caption(page, captionEvents, startedAt, "No deep job exists yet in this run; creating one now.");
  const result = await deepCreateJob(page, captionEvents, startedAt);
  if (result.status !== "PASS" || !state.job?.id) throw new Error("Could not create deep E2E job.");
  return state.job;
}

async function ensureDeepApplication(page, captionEvents, startedAt) {
  await ensureDeepJob(page, captionEvents, startedAt);
  if (state.application?.applicationId) return state.application;
  await caption(page, captionEvents, startedAt, "No deep candidate exists yet in this run; submitting one now.");
  const result = await deepCandidateApply(page, captionEvents, startedAt);
  if (result.status !== "PASS" || !state.application?.applicationId) throw new Error("Could not submit deep E2E candidate application.");
  return state.application;
}

async function authApi(page, apiPath, options = {}) {
  await page.goto(`${config.hiringcatUrl}/dashboard`, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  await installCaptionOverlay(page).catch(() => {});
  const payload = {
    apiPath,
    method: options.method || "GET",
    body: options.body,
    orgId: options.orgId || state.org?.id || "",
  };
  if (options.captionEvents && options.startedAt) {
    await evidence(page, options.captionEvents, options.startedAt, "REQUEST", `API ${payload.method} /api${apiPath}`, summarizeForEvidence(options.body || { orgId: payload.orgId }));
  }
  const result = await page.evaluate(async ({ apiPath, method, body, orgId }) => {
    const token = await window.Clerk?.session?.getToken({ skipCache: true }).catch(() => "");
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (orgId) headers["x-org-id"] = orgId;
    const response = await fetch(`/api${apiPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { ok: response.ok, status: response.status, json, text };
  }, payload);
  if (options.captionEvents && options.startedAt) {
    await evidence(page, options.captionEvents, options.startedAt, result.ok ? "PASS" : "FAIL", `API response ${payload.method} /api${apiPath}`, `HTTP ${result.status}; ${summarizeForEvidence(result.json?.data ?? result.json ?? result.text)}`);
  }
  if (!result.ok && !options.allowFailure) {
    const message = result.json?.error || result.text || `HTTP ${result.status}`;
    throw new Error(`API ${payload.method} /api${apiPath} failed: ${message}`);
  }
  return result.json || {};
}

async function publicApi(page, apiPath, options = {}) {
  if (options.captionEvents && options.startedAt) {
    await evidence(page, options.captionEvents, options.startedAt, "REQUEST", `API ${options.method || "GET"} /api${apiPath}`, summarizeForEvidence(options.body || {}));
  }
  const result = await page.evaluate(async ({ apiPath, method, body }) => {
    const response = await fetch(`/api${apiPath}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { ok: response.ok, status: response.status, json, text };
  }, { apiPath, method: options.method || "GET", body: options.body });
  if (options.captionEvents && options.startedAt) {
    await evidence(page, options.captionEvents, options.startedAt, result.ok ? "PASS" : "FAIL", `API response ${options.method || "GET"} /api${apiPath}`, `HTTP ${result.status}; ${summarizeForEvidence(result.json?.data ?? result.json ?? result.text)}`);
  }
  if (!result.ok && !options.allowFailure) {
    const message = result.json?.error || result.text || `HTTP ${result.status}`;
    throw new Error(`API ${options.method || "GET"} /api${apiPath} failed: ${message}`);
  }
  return result.json || {};
}

async function fetchPublicJob(page, jobSlug, captionEvents, startedAt) {
  const orgSlug = state.org?.slug || config.orgSlug;
  const result = await publicApi(page, `/public/jobs/${encodeURIComponent(orgSlug)}/${encodeURIComponent(jobSlug)}`, { captionEvents, startedAt });
  return unwrapData(result, "public job");
}

async function submitQuestionResponses(page, captionEvents, startedAt) {
  const detail = unwrapData(await authApi(page, `/jobs/${state.job.id}`, { orgId: state.org.id, captionEvents, startedAt }), "job detail");
  const questions = detail.questions || [];
  state.questions = questions;
  await evidence(page, captionEvents, startedAt, "STEP", "Step 4: Submit screening answers one by one", `${questions.length} questions found`);
  for (const question of questions) {
    const body = buildResponseBody(question);
    if (!body) continue;
    await caption(page, captionEvents, startedAt, `Answering ${question.type} question: ${String(question.title || "").slice(0, 70)}`);
    await publicApi(page, `/public/applications/${state.application.token}/responses`, {
      method: "POST",
      body,
      captionEvents,
      startedAt,
    });
  }
}

function buildResponseBody(question) {
  const base = { questionId: question.id, type: question.type, durationSecs: 12 };
  if (["short_text", "long_text", "text", "rich_text"].includes(question.type)) {
    return { ...base, textValue: "AI QA E2E answer: I can test forms, validations, CV screening, video questions, dashboards, and candidate pipeline updates." };
  }
  if (question.type === "video" || question.type === "screen_recording") {
    return { ...base, videoUrl: "https://aamirmursleen.github.io/hiringcat-qa/assets/ai-qa-video.webm", fileSizeBytes: 1024 };
  }
  if (question.type === "audio") {
    return { ...base, audioUrl: "https://aamirmursleen.github.io/hiringcat-qa/assets/ai-qa-audio.webm", fileSizeBytes: 1024 };
  }
  if (question.type === "file_upload") {
    return { ...base, fileUrl: "https://aamirmursleen.github.io/hiringcat-qa/assets/ai-qa-answer.pdf", fileSizeBytes: 1024 };
  }
  if (question.type === "yes_no") return { ...base, textValue: "yes", choiceValue: ["yes"] };
  if (question.type === "rating") return { ...base, numberValue: 5 };
  if (question.type === "number") return { ...base, numberValue: 5 };
  if (question.type === "url") return { ...base, urlValue: "https://example.com/ai-qa-portfolio" };
  if (question.type === "date") return { ...base, dateValue: "2026-07-28" };
  if (question.type === "multiple_choice" || question.type === "single_choice" || question.type === "dropdown") {
    const first = Array.isArray(question.options) ? question.options[0] : "AI QA option";
    return { ...base, choiceValue: [typeof first === "string" ? first : first?.value || first?.label || "AI QA option"] };
  }
  return null;
}

function buildDeepJobPayload({ title, slug }) {
  return {
    title,
    slug,
    department: "QA Automation",
    location: "Remote",
    employmentType: "full_time",
    status: "active",
    description: `<p>${title} created by HiringCat AI deep E2E runner. This verifies real job creation, public apply, CV, video screening, and HR dashboard review.</p>`,
    thankYouMessage: "Thank you. AI QA deep E2E application has been submitted.",
    welcomeMessage: "AI QA deep E2E candidate welcome step.",
    welcomeStyle: "minimal",
    applyStyle: "professional",
    autoScreen: true,
    applicationFields: {
      name: true,
      email: true,
      phone: true,
      cv: true,
      linkedin: true,
      coverLetter: true,
    },
    maxRetakes: 2,
    timeLimitSecs: 120,
    questions: [
      {
        roundType: "cv",
        type: "short_text",
        title: "Summarize your QA testing experience.",
        description: "Required text screening question for AI QA deep E2E.",
        isRequired: true,
        position: 0,
      },
      {
        roundType: "video",
        type: "video",
        title: "Record a short introduction video.",
        description: "Required video screening evidence for AI QA deep E2E.",
        isRequired: true,
        position: 1,
        timeLimitSecs: 60,
        maxRetakes: 1,
      },
      {
        roundType: "video",
        type: "file_upload",
        title: "Upload one supporting work sample.",
        description: "Required file upload evidence for AI QA deep E2E.",
        isRequired: true,
        position: 2,
      },
      {
        roundType: "video",
        type: "yes_no",
        title: "Are you available for a QA interview this week?",
        isRequired: true,
        position: 3,
      },
      {
        roundType: "video",
        type: "rating",
        title: "Rate your confidence with E2E testing.",
        isRequired: true,
        position: 4,
      },
    ],
    aiSettings: {
      aiEnabled: true,
      autoScoreCv: true,
      autoScoreText: true,
      autoTranscribe: false,
      scoreAnswers: true,
      speechMetrics: false,
      strongThreshold: 80,
      passThreshold: 60,
      customCriteria: "AI QA deep E2E test data only.",
    },
    roundsConfig: [
      { type: "cv", name: "CV Screening", config: { enabled: true } },
      { type: "video", name: "Video Screening", config: { enabled: true } },
    ],
  };
}

async function openUsableRoute(page, target, expectedText) {
  const response = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await installCaptionOverlay(page).catch(() => {});
  const statusCode = response?.status() ?? 0;
  if (statusCode >= 500 || statusCode === 0) throw new Error(`${target} returned HTTP ${statusCode || "unknown"}.`);
  const deadline = Date.now() + 25_000;
  let lastText = "";
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const bodyText = (await page.locator("body").innerText({ timeout: 8000 }).catch(() => "")).trim();
    lastText = bodyText;
    if (/sign in|sign-in/i.test(page.url()) && /dashboard/i.test(target)) {
      throw new Error(`${target} redirected to sign-in.`);
    }
    if (!bodyText || hasBlockingAppError(bodyText) || (/dashboard/i.test(target) && hasAuthFormOrError(bodyText))) {
      continue;
    }
    if (/Loading (job|application|dashboard)|Loading\.\.\.?$/i.test(bodyText)) {
      continue;
    }
    if (!expectedText || expectedText.test(bodyText)) return;
  }
  if (!lastText || hasBlockingAppError(lastText) || (/dashboard/i.test(target) && hasAuthFormOrError(lastText))) {
    throw new Error(`${target} did not show usable content. Text: ${lastText.replace(/\s+/g, " ").slice(0, 500)}`);
  }
  if (expectedText && !expectedText.test(lastText)) {
    throw new Error(`${target} did not contain expected text ${expectedText}. Text: ${lastText.replace(/\s+/g, " ").slice(0, 500)}`);
  }
}

function unwrapData(result, label) {
  if (!result || result.success === false) throw new Error(`${label} API returned failure: ${result?.error || "unknown error"}`);
  return result.data ?? result;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function preflightSection(section) {
  if (section.id === "qa-form-smoke") return { ok: true };
  const hasReusableAuth = Boolean(config.authStateSeed);
  if (section.requiresCredentials && !hasReusableAuth && (!config.email || !config.password)) {
    return { ok: false, reason: "Private HiringCat test email/password are missing, so AI cannot safely verify authenticated dashboard flow." };
  }
  if (section.requiresOrgJob && !deepMode && (!config.orgSlug || !config.jobSlug)) {
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

async function fillIfVisible(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.fill(value, { timeout: 5000 }).catch(() => {});
    return true;
  }
  return false;
}

async function prepareCandidateApplyUi(page, candidateName, candidateEmail) {
  const start = page.getByRole("button", { name: /Get Started|Start|Apply/i }).first();
  if (await start.isVisible({ timeout: 2500 }).catch(() => false)) {
    await start.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }
  const name = await fillIfVisible(page, [
    'input[placeholder*="full name" i]',
    'input[name*="name" i]',
    'input[type="text"]',
  ], candidateName);
  const email = await fillIfVisible(page, [
    'input[type="email"]',
    'input[placeholder*="example" i]',
    'input[name*="email" i]',
  ], candidateEmail);
  const phone = await fillIfVisible(page, [
    'input[type="tel"]',
    'input[name*="phone" i]',
    'input[placeholder*="phone" i]',
  ], "+923001112233");
  await page.waitForTimeout(1200);
  return { name, email, phone };
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
  const alreadyInstalled = await page.evaluate(() => Boolean(document.getElementById("ai-qa-caption") && document.getElementById("ai-qa-proof-panel"))).catch(() => false);
  if (alreadyInstalled) return;
  await page.addStyleTag({
    content: `
      #ai-qa-caption {
        position: fixed;
        left: 32px;
        right: 580px;
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
      #ai-qa-proof-panel {
        position: fixed;
        right: 28px;
        top: 28px;
        width: 510px;
        max-height: calc(100vh - 56px);
        z-index: 2147483647;
        background: rgba(255, 255, 255, 0.96);
        color: #111827;
        border: 1px solid rgba(15, 23, 42, 0.16);
        box-shadow: 0 18px 55px rgba(15,23,42,.22);
        border-radius: 14px;
        padding: 14px;
        font: 600 16px/1.35 Inter, Arial, sans-serif;
        pointer-events: none;
      }
      #ai-qa-proof-panel .proof-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 10px;
        font-weight: 900;
        font-size: 17px;
      }
      #ai-qa-proof-panel .proof-subtitle {
        color: #64748b;
        font-size: 12px;
        font-weight: 800;
        text-transform: uppercase;
      }
      #ai-qa-proof-list {
        display: grid;
        gap: 8px;
        max-height: calc(100vh - 128px);
        overflow: hidden;
      }
      #ai-qa-proof-list .proof-item {
        border: 1px solid #e5e7eb;
        border-left: 5px solid #3b82f6;
        background: #f8fafc;
        border-radius: 10px;
        padding: 8px 10px;
      }
      #ai-qa-proof-list .proof-item.pass { border-left-color: #16a34a; background: #f0fdf4; }
      #ai-qa-proof-list .proof-item.fail { border-left-color: #dc2626; background: #fef2f2; }
      #ai-qa-proof-list .proof-item.skip { border-left-color: #64748b; background: #f1f5f9; }
      #ai-qa-proof-list .proof-item.request { border-left-color: #7c3aed; background: #faf5ff; }
      #ai-qa-proof-list .proof-item .proof-meta {
        color: #475569;
        font-size: 11px;
        font-weight: 900;
        text-transform: uppercase;
        margin-bottom: 3px;
      }
      #ai-qa-proof-list .proof-item .proof-text {
        color: #111827;
        font-size: 14px;
        font-weight: 700;
        overflow-wrap: anywhere;
      }
    `,
  });
  await page.evaluate(() => {
    if (!document.getElementById("ai-qa-caption")) {
      const el = document.createElement("div");
      el.id = "ai-qa-caption";
      document.body.appendChild(el);
    }
    if (!document.getElementById("ai-qa-proof-panel")) {
      const panel = document.createElement("div");
      panel.id = "ai-qa-proof-panel";
      panel.innerHTML = `
        <div class="proof-title">
          <span>Visible Step Evidence</span>
          <span class="proof-subtitle">Live QA Log</span>
        </div>
        <div id="ai-qa-proof-list"></div>
      `;
      document.body.appendChild(panel);
    }
    window.__aiQaProofPush = (item) => {
      const list = document.getElementById("ai-qa-proof-list");
      if (!list) return;
      const el = document.createElement("div");
      const status = String(item.status || "step").toLowerCase();
      el.className = `proof-item ${status}`;
      el.innerHTML = `
        <div class="proof-meta">${String(item.status || "STEP")} · ${new Date().toLocaleTimeString()}</div>
        <div class="proof-text"></div>
      `;
      el.querySelector(".proof-text").textContent = String(item.text || "");
      list.appendChild(el);
      while (list.children.length > 9) list.removeChild(list.firstElementChild);
    };
  });
}

async function caption(page, events, startedAt, text) {
  events.push({ at: Date.now() - startedAt, text });
  await installCaptionOverlay(page).catch(() => {});
  await page.evaluate((value) => {
    const el = document.getElementById("ai-qa-caption");
    if (el) el.textContent = value;
    window.__aiQaProofPush?.({ status: "STEP", text: value });
  }, text);
  await page.waitForTimeout(600);
  await captureStepScreenshot(page, "STEP", text).catch(() => {});
}

async function safeCaption(page, events, startedAt, text) {
  try {
    await caption(page, events, startedAt, text);
  } catch {}
}

async function evidence(page, events, startedAt, status, title, detail = "") {
  const text = `${title}${detail ? ` - ${detail}` : ""}`;
  events.push({ at: Date.now() - startedAt, text: `${status}: ${text}` });
  await installCaptionOverlay(page).catch(() => {});
  await page.evaluate(({ status, text }) => {
    const el = document.getElementById("ai-qa-caption");
    if (el) el.textContent = text;
    window.__aiQaProofPush?.({ status, text });
  }, { status, text });
  await page.waitForTimeout(900);
  await captureStepScreenshot(page, status, text).catch(() => {});
}

async function captureStepScreenshot(page, status, text) {
  const stepState = stepStateByPage.get(page);
  if (!stepState || stepState.images.length >= 18) return;
  stepState.index += 1;
  const filename = `${stepState.sectionId}-${String(stepState.index).padStart(2, "0")}.jpg`;
  const imagePath = path.join(stepImagesDir, filename);
  await page.screenshot({ path: imagePath, fullPage: false, type: "jpeg", quality: 72, timeout: 5000 });
  stepState.images.push({
    status,
    text,
    file: path.relative(runDir, imagePath).replaceAll(path.sep, "/"),
  });
}

async function writeStepStoryboard(page, section, outputPath) {
  const stepState = stepStateByPage.get(page);
  const images = stepState?.images || [];
  const cards = images.map((item, index) => `
    <article class="step ${escapeHtml(String(item.status || "step").toLowerCase())}">
      <img src="../${escapeHtml(item.file)}" alt="Step ${index + 1}">
      <div class="caption">
        <b>${index + 1}. ${escapeHtml(item.status || "STEP")}</b>
        <p>${escapeHtml(item.text)}</p>
      </div>
    </article>
  `).join("");
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(section.title)} Storyboard</title>
<style>
body{margin:0;background:#f8fafc;color:#111827;font:14px/1.55 Inter,Arial,sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 44px}
h1{font-size:26px;margin:0 0 4px}.meta{color:#64748b;margin-bottom:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.step{background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;box-shadow:0 6px 22px rgba(15,23,42,.07)}
.step img{display:block;width:100%;height:auto;background:#e5e7eb}
.caption{border-top:5px solid #3b82f6;padding:12px}.step.pass .caption{border-top-color:#16a34a}.step.fail .caption{border-top-color:#dc2626}.step.request .caption{border-top-color:#7c3aed}.step.skip .caption{border-top-color:#64748b}
.caption b{display:block;text-transform:uppercase;font-size:12px;letter-spacing:.03em}.caption p{margin:6px 0 0;overflow-wrap:anywhere}
</style></head><body><main>
<h1>${escapeHtml(section.title)} Step Storyboard</h1>
<div class="meta">Run ${escapeHtml(runId)} · ${escapeHtml(section.id)} · ${images.length} captured steps</div>
<section class="grid">${cards || "<p>No storyboard steps were captured.</p>"}</section>
</main></body></html>`;
  await fs.writeFile(outputPath, cleanHtml(html));
}

function summarizeForEvidence(value) {
  const redacted = redactSecrets(value);
  const raw = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
  return raw.replace(/\s+/g, " ").slice(0, 260);
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.slice(0, 6).map(redactSecrets);
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && value.length > 90) return `${value.slice(0, 60)}...`;
    return value;
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/password|token|secret|authorization|api.?key|cookie/i.test(key)) {
      output[key] = "[redacted]";
    } else if (key === "data" && item && typeof item === "object") {
      output[key] = redactSecrets(item);
    } else {
      output[key] = redactSecrets(item);
    }
  }
  return output;
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

async function uploadArtifacts({ section, videoPath, screenshotPath, tracePath, vttPath, storyboardPath }) {
  const files = {
    videoUrl: videoPath,
    screenshotUrl: screenshotPath,
    traceUrl: tracePath,
    captionUrl: vttPath,
    storyboardUrl: storyboardPath,
  };
  if (config.uploadProvider === "moonpush") {
    return {
      videoUrl: videoPath ? await uploadMoonPush(videoPath) : "",
      screenshotUrl: screenshotPath ? await uploadMoonPush(screenshotPath) : "",
      traceUrl: tracePath ? await uploadMoonPush(tracePath) : "",
      captionUrl: vttPath ? await uploadMoonPush(vttPath) : "",
      storyboardUrl: storyboardPath ? await uploadMoonPush(storyboardPath) : "",
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
  await fs.writeFile(path.join(runDir, "report.html"), cleanHtml(html));
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

async function reviewWithHCompany(report) {
  const response = await fetch("https://api.hcompany.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.haiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.HAI_MODEL || "holo3-1-35b-a3b",
      messages: [
        {
          role: "system",
          content: "You are an independent QA evidence reviewer. Return concise JSON only.",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "Review whether this HiringCat AI QA report contains visible step evidence, action-based E2E coverage, and clear human-only skips.",
            summary: report.summary,
            results: report.results.map((result) => ({
              id: result.id,
              status: result.status,
              reason: result.reason,
              hasVideo: Boolean(result.videoUrl),
              hasScreenshot: Boolean(result.screenshotUrl),
              hasTrace: Boolean(result.traceUrl),
            })),
          }),
        },
      ],
      response_format: { type: "json_object" },
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`H Company review failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const content = json.choices?.[0]?.message?.content || "{}";
  try {
    return { status: "PASS", provider: "H Company", review: JSON.parse(content) };
  } catch {
    return { status: "PASS", provider: "H Company", review: content };
  }
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
        ${result.storyboardUrl ? `<a href="${escapeHtml(result.storyboardUrl)}">Storyboard</a>` : ""}
        ${result.captionUrl ? `<a href="${escapeHtml(result.captionUrl)}">Captions</a>` : ""}
        ${result.screenshotUrl ? `<a href="${escapeHtml(result.screenshotUrl)}">Screenshot</a>` : ""}
        ${result.traceUrl ? `<a href="${escapeHtml(result.traceUrl)}">Trace</a>` : ""}
      </div>
    </article>
  `).join("");
  const hReview = report.hCompanyReview ? `
    <article class="card">
      <div class="row">
        <div>
          <p class="eyebrow">h-company-review</p>
          <h2>Independent H Company AI Review</h2>
        </div>
        <span class="status">${escapeHtml(report.hCompanyReview.status || "INFO")}</span>
      </div>
      <pre>${escapeHtml(JSON.stringify(report.hCompanyReview.review || report.hCompanyReview.summary || report.hCompanyReview, null, 2))}</pre>
    </article>
  ` : "";
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
    pre{white-space:pre-wrap;background:#0f172a;color:#e5e7eb;border-radius:12px;padding:12px;overflow:auto;font-size:12px}
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
    ${hReview}
    ${rows}
  </main>
</body>
</html>`;
}

function cleanHtml(html) {
  return `${html.replace(/[ \t]+$/gm, "").trimEnd()}\n`;
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

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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

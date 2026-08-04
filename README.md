# HiringCat QA Checklist

Static GitHub Pages QA checklist for HiringCat. The public checklist is scoped to a 1-hour do-or-die manual QA pass.

## Files

- `index.html` - 1-hour do-or-die QA page with sections, checkboxes, Pass/Fail/Skip, notes, localStorage progress, copy report, and PDF download.
- `scripts/ai-qa-runner.mjs` - Playwright-based AI QA runner that records HD evidence, adds visible captions, generates report HTML/PDF, and can send the report through WAQueen.
- `.env.example` - safe config template. Never commit real passwords or API keys.

## AI QA Runner Workflow

```mermaid
flowchart TD
  A[Start HiringCat AI QA Runner] --> B[Load secure env config]
  B --> C[Create run folder with date/time]
  C --> D[Open Playwright browser 1920x1080]
  D --> E[Start section video recording]
  E --> F[Show caption overlay: current task + expected result]
  F --> G[AI performs browser steps]
  G --> H[Assert expected result from UI/network]
  H --> I{Can verify?}
  I -->|Matched| J[PASS]
  I -->|Mismatch| K[FAIL + reason + screenshot]
  I -->|Needs human/external access| L[SKIP + reason]
  J --> M[Save video, screenshots, captions, storyboard]
  K --> M
  L --> M
  M --> N[Generate HTML report + PDF report]
  N --> O[Optional WhatsApp report through WAQueen API]
```

The runner is deliberately strict: it only marks `PASS` when it can verify the expected result through browser/UI assertions. If credentials, OTP, Gmail, DNS, payment, or send-ready WhatsApp access is missing, it marks the section `SKIP` with a human-required reason.

## Run Locally

```bash
cd /root/abdullah/hiringcat-qa
cp .env.example .env
npm install
npm test
npm run qa:ai
```

Fast smoke run:

```bash
npm run qa:ai:smoke
```

Functional human-style E2E run:

```bash
npm run qa:ai:deep
```

Deep mode creates real QA data in the configured HiringCat test workspace:

- logs in and reuses the same browser session
- shows a visible proof panel in every video with the current step, request, response, and assertion
- captures step-by-step screenshots and merges them into a storyboard page for each QA section
- creates a unique active job through the visible job wizard when `QA_HUMAN_UI=1`
- verifies the job in dashboard and public careers/apply pages
- submits a unique candidate application through the visible public form with CV upload and consent
- answers screening questions through the visible candidate UI when the product exposes them; if the UI skips configured questions, the screening section fails with the exact reason
- opens the HR candidate detail page and verifies the submitted candidate appears
- checks scheduling, emails, automation, integrations, SMTP, tracking, branding, team, analytics, billing/activity, and mobile public pages
- marks only DNS/Gmail/payment/custom-domain items as `SKIP` when external access is missing

Set `QA_HUMAN_UI=0` only when you intentionally want the older API-heavy fallback mode.

To repeat the destructive core flow more than once in one run:

```bash
DEEP_TEST_REPEAT=2 npm run qa:ai:deep
```

Optional H Company review:

```bash
HAI_REVIEW_EVIDENCE=1 HAI_API_KEY=<private Portal-H key> npm run qa:ai:deep
```

This keeps Playwright as the deterministic QA runner and uses H Company only as an independent evidence reviewer in the final report. Do not commit `HAI_API_KEY`.

Localhost dashboard E2E:

```bash
# In the HiringCat app repo, start the local web/API with real dev env first.
# Required there: VITE_CLERK_PUBLISHABLE_KEY, Clerk backend keys, API URL, DATABASE_URL.

cd /root/abdullah/hiringcat-qa
HIRINGCAT_URL=http://localhost:5173 npm run qa:ai
```

If Clerk asks for an email/OTP code:

```bash
QA_HEADLESS=0 HIRINGCAT_LOGIN_INTERACTIVE=1 HIRINGCAT_URL=http://localhost:5173 npm run qa:ai
```

The browser will stay open long enough for a human to enter the code, then the AI runner continues the dashboard checks.
If the code is already available, pass it once with `HIRINGCAT_LOGIN_CODE=123456`; the runner saves the authenticated browser state for that run and reuses it across dashboard sections.
To reuse a saved session from a previous run:

```bash
HIRINGCAT_AUTH_STATE_PATH=runs/<previous-run>/auth-state.json npm run qa:ai:deep
```

Run output is written to:

```text
runs/<timestamp>/
  report.html
  HiringCat-AI-QA-<timestamp>.pdf
  summary.json
  videos/*.webm
  screenshots/*.png
  captions/*.vtt
  step-images/*.jpg
  storyboards/*.html
```

Playwright trace zips are optional because they are large. Use `QA_SAVE_TRACES=1` only when trace debugging is needed.

## WhatsApp Delivery

The runner can send the final report link/PDF through WAQueen:

```text
SEND_WHATSAPP=1
QA_REPORT_PHONE=+923294049067
WAQUEEN_API_KEY=<private key with messages:send scope>
```

WAQueen endpoint used:

```text
POST https://waqueen.com/api/v1/messages
Authorization: Bearer $WAQUEEN_API_KEY
```

Keep `SEND_WHATSAPP=0` until the run files are pushed or hosted somewhere public. Otherwise the WhatsApp message may contain links that are not live yet.

## Video Upload Options

- `VIDEO_UPLOAD_PROVIDER=local`: videos are stored in the repo under `runs/<timestamp>/` and become public after commit/push to GitHub Pages.
- `VIDEO_UPLOAD_PROVIDER=moonpush`: videos upload to MoonPush API. Use only when temporary links are acceptable.
- For permanent evidence at scale, use Cloudflare R2/S3 and extend `uploadArtifacts()` with the bucket uploader.

## Deploy To GitHub Pages

```bash
cd /root/abdullah/hiringcat-qa
git init
git add index.html README.md
git commit -m "Create HiringCat QA checklist"
gh repo create hiringcat-qa --public --source=. --remote=origin --push
gh api -X POST repos/aamirmursleen/hiringcat-qa/pages -f source.branch=main -f source.path=/
```

Final URL:

```text
https://aamirmursleen.github.io/hiringcat-qa/
```

If GitHub Pages already exists, push updates to `main`; the same URL will update automatically.

## QA Rules

- Do not put passwords, API keys, SMTP passwords, license keys, or private tokens on the public page.
- Share test credentials privately.
- Mark `Fail` only when actual result does not match expected result.
- Mark `Skip` when feature is unavailable or test data is missing.
- Every `Fail` needs a screenshot/video link in notes.
- Rotate any API key that was pasted into chat or public tooling.

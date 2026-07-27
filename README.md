# HiringCat QA Checklist

Static GitHub Pages QA checklist for HiringCat.

## Files

- `index.html` - complete QA page with sections, checkboxes, Pass/Fail/Skip, notes, localStorage progress, copy report, and PDF download.

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

# MaiUp

MaiUp is a local-first score analysis and personalized song recommendation tool for **maimai DX International Version**. It currently focuses on traceable catalog data, version-aware Rating calculations, reviewable B50 image recognition, and explainable score-improvement recommendations.

## Current status

- **Catalog:** synchronizes International songs and charts from the public DXRating catalog, stores immutable source snapshots by content hash, validates them, and only publishes accepted snapshots to SQLite.
- **Rating engine:** uses `Decimal` arithmetic for coefficient boundaries, flooring, the 100.5% cap, AP/AP+ bonuses, and dynamic B35/B15 construction. The B15 window is derived from the configured current version rather than hard-coded version names.
- **Two explicit import modes:** a PNG/JPEG B50 image provides a fast B50-only workflow, while a complete DX NET JSON preserves the full score history, imports the official B35/B15 list, and enables full-history recommendation evidence.
- **B50 image import:** runs RapidOCR locally. It matches title, Achievement, rank, displayed chart constant, chart Rating, FC/FC+, chart type, difficulty, and B35/B15 position. Blue Sync markers are intentionally ignored.
- **Review workflow:** low-confidence fields remain editable and all 50 entries must be confirmed before analysis. Confirmed imports are immutable.
- **Experimental recommendations:** `full-history-personal-fit-v0.8.1` uses a reachable Achievement ladder, keeps played quick wins separate from new-chart exploration, and retains the current score for played charts outside B50. Strengths and a clearly labeled all-history weakness preview remain visible even when recent dates are unavailable; only the conservative weakness-risk filter pauses after a long break or while return-to-play evidence is sparse. Official B35/B15 still determines replacement thresholds and total Rating.
- **Community difficulty tags:** DXRating `Overrated` is treated as a positive “water chart” signal. `Underrated` is treated as a risky or deceptively difficult chart signal and excluded from ordinary score-improvement recommendations.
- **Recommendation focus:** the page prioritizes charts outside the current B50, orders the selected set by empirical attainment evidence before conditional gain, caps community “water chart” exceptions near a demonstrated target ceiling, and allocates additional candidates to B15. Missing full-history records are labeled as absent from the export rather than definitively unplayed.
- **Complete-score foundation:** the local API accepts a versioned International score JSON, matches song/chart identities against the active catalog, safely corrects an incorrect DX/STD source label only when the title and difficulty identify one unique chart, keeps the highest Achievement for duplicate charts, reports unmatched records, and builds a confirmed B35/B15 recommendation input when 50 eligible charts are available.
- **DX NET user-side export:** an opt-in bookmarklet reads played charts across all five difficulty pages plus the official `Rating Target Music` B35/B15 inside the authenticated International DX NET session and downloads a local JSON file. It also makes a capped, throttled best-effort pass over score-detail pages near the player's B50 level range to attach last-play dates. A complete 35+15 official list is used directly; local B50 reconstruction is only a visibly labeled fallback. The exporter does not read or transmit account credentials or session cookies.
- **Visual B50 report:** matched B35/B15 entries include cover thumbnails, exact four-decimal Achievement, chart constant, single-chart Rating, and FC status. The report can render a five-column B35/B15 PNG locally in the browser without storing the generated image.

Calibrated success probabilities, objective chart-difficulty ordering, and dynamic `+10 Rating` plans remain disabled until a larger real-world validation set is available. The displayed attainment percentage is an empirical ratio from comparable personal scores, not a predicted probability.

## Data snapshot and limitations

The local catalog snapshot synchronized on 2026-09-21 contains 1,791 source songs, including 1,538 International songs and 6,321 International charts, with zero validation errors and zero warnings. The current configured version is CiRCLE PLUS, so the B15 window is `CiRCLE + CiRCLE PLUS`. Future version changes require updating the active version and its matching constant snapshot in `data/config/international.json`.

Chart constants use this priority: locally verified, version-scoped International overrides; positive exact constants from the configured mai-tools CiRCLE PLUS snapshot; then the generic DXRating base value as a lower-confidence fallback. Negative estimates are ignored. A zero International override falls back to the positive value from that same version snapshot, and same-title songs are separated by debut version. DXRating `serverOverrides.intl.levelValue` is not treated as an exact hidden constant because it may only encode the displayed level. The version snapshot, local overrides, and ingestion policy all participate in the catalog fingerprint, so corrections create a new local snapshot even when the main DXRating payload is unchanged. These remain community values and must not be presented as official SEGA International constants.

Community tags are weak evidence supplied by DXRating users. They are useful for explanation and ranking, but they are not objective chart classifications or guaranteed difficulty labels.

## Privacy

- Image processing and OCR run locally.
- Uploaded images have EXIF metadata and original filenames removed after decoding.
- Temporary imports use random IDs under `data/imports/` and are excluded from Git.
- Local databases, raw catalog snapshots, uploaded images, OCR output, and environment files are excluded by `.gitignore`.
- The current application does not accept or store SEGA IDs, passwords, or session cookies.

## Run locally

Backend, in PowerShell:

```powershell
cd apps/api
.\.venv\Scripts\python.exe -m app.jobs.sync_catalog
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Frontend, in another PowerShell window:

```powershell
cd apps/web
npm.cmd run dev
```

Open `http://localhost:3000/`. API documentation is available at `http://127.0.0.1:8000/docs`.

## Validation

```powershell
cd apps/api
.\.venv\Scripts\python.exe -m ruff check app tests
.\.venv\Scripts\python.exe -m pytest

cd ..\web
npx.cmd oxlint app types
npm.cmd run build
```

Current automated validation: **77 backend tests pass**, the application-owned frontend code passes targeted linting, and the production frontend build succeeds. The scaffold still contains unused shadcn components with upstream accessibility lint findings, so a full-directory `npm run lint` is not yet green.

## Real-image validation

The saved JiETNG International B50 fixture currently matches all 50 entries, reproduces the displayed total Rating of 15,150, and identifies 25 green FC markers. This validates one known template only; it does not yet establish compatibility with every resolution, template variant, or AP/AP+ case.

Recommended manual checks for a new image:

1. Prepare a current International B50 overview image and optionally redact the player name and avatar.
2. Upload it from the home page and wait for the local OCR review page.
3. Verify the automatic-read count, all 50 chart matches, and green FC/FC+ markers.
4. Report repeated low-confidence patterns with a review-page screenshot so the relevant OCR region can be calibrated.

## Documentation

- [`docs/research.en.md`](docs/research.en.md): source evaluation, International rules, data-access constraints, and recommendation research.
- [`docs/architecture.en.md`](docs/architecture.en.md): system boundaries, data model, OCR workflow, recommendation model, privacy, and validation gates.
- [`docs/public-hosting-research.en.md`](docs/public-hosting-research.en.md): evidence-based public-hosting architecture, costs, browser constraints, isolation requirements, and phased release gates.
- [`docs/free-hosting-mvp.en.md`](docs/free-hosting-mvp.en.md): free-hosted friends-pilot layout, access-key isolation, required secrets, and deployment validation gates.
- [`docs/score-import-v1.example.json`](docs/score-import-v1.example.json): minimal complete-score import example.

## Project scope

MaiUp is an independent community project and is not affiliated with or endorsed by SEGA. Catalog constants and chart tags are community-maintained unless explicitly identified otherwise.

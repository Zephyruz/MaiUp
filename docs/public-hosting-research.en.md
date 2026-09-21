# MaiUp Public Hosting Research

Last reviewed: 2026-09-21.

## Decision summary

MaiUp should **not** be published in its current form. The lowest-risk path is an incremental split deployment, not a rewrite:

```text
Browser
  -> Cloudflare Worker running the existing vinext UI
       -> same-origin /v1 gateway
            -> hosted FastAPI container
                 -> managed PostgreSQL
                 -> R2 only for short-lived blobs and catalog snapshots
```

The first hosted pilot should support complete-score JSON import, official B35/B15 handling, reports, and recommendations. Remote image OCR should remain disabled until it has an isolated worker, bounded concurrency, explicit retention/deletion, and real memory measurements. The existing local application remains the privacy-preserving OCR/desktop option.

There are two release blockers before any public deployment:

1. Player records have no owner or anonymous-session key. Every current read, update, confirm, delete, and recommendation endpoint authorizes solely by a public `importId`, so the current API is not multi-user safe.
2. The current maimai DX NET Terms of Service prohibit unapproved automated tools/programs/macros and restrict use of service information beyond private use. A public automatic exporter therefore needs a separate terms/legal decision or permission; a bookmarklet is not evidence of authorization.

No service purchase, account binding, public deployment, custom domain, commit, or push is part of this research.

## Verified Git baseline

- Experiment branch: `codex/public-hosting-experiment`
- Base: `ce83b32dc2d987cab17ca63adeb86f96bce5e22c`
- Base subject: `Merge pull request #3 from Zephyruz/codex/automatic-dxnet-import`
- Merge parents: recommendation merge `46af8d4` and automatic-import branch `22a752a`
- Remote verification used `git ls-remote` followed by a fetch of `origin/main`; the experiment branch tracks that exact remote commit.

## Current component assessment

| Component | Current assumption | Hosting assessment | Recommended change |
| --- | --- | --- | --- |
| vinext UI | Worker-compatible App Router build | Hostable with low migration risk. Cloudflare currently recommends vinext for Next.js-style apps on Workers, but vinext still describes itself as under active development with possible compatibility gaps. | Keep the UI and styling. Deploy only to a preview environment first and run the production build plus route smoke tests. |
| OpenAI Sites configuration | The repository has the Sites Vite plugin, but `.openai/hosting.json` currently binds neither D1 nor R2. | Sites can host compatible web applications and offers D1, R2, and optional sign-in. It is in public beta with plan-specific usage limits, a 10 GB D1 limit, no fixed R2 storage limit, and no data or inference residency at launch. The current Python/ONNX backend is not proven compatible with the supported Sites runtime. | Treat Sites as a preview/hosting candidate only after compatibility and privacy review. Do not assume the present configuration supplies persistence, tenant isolation, or a FastAPI runtime. |
| FastAPI API | Long-running Python process | Hostable in a Python/container platform. It cannot run unchanged in the Workers JavaScript runtime. | Keep FastAPI for the first pilot. Put it behind a same-origin Worker gateway instead of exposing broad CORS. |
| SQLite | One trusted local user and durable local disk | Unsafe on free/ephemeral web-service disks and unsuitable for concurrent public users. | Change the production database URL to PostgreSQL, add Alembic migrations, and stop using `Base.metadata.create_all()` as the production migration mechanism. |
| Catalog sync | Writes normalized rows to SQLite and raw JSON to `data/catalog/raw` | Database rows can move to PostgreSQL; raw snapshot and cover lookup currently depend on local files. | Use one scheduled sync writer. Put immutable raw snapshots in R2 or persist the required cover metadata in SQL. Keep the previous accepted snapshot on fetch/validation failure. |
| Complete DX NET score import | JSON -> SQLAlchemy -> official B50 or calculated fallback | Technically hostable and does not need OCR. | Make this the first hosted feature, after adding ownership, quotas, deletion, and retention. Keep the exact 35 B35 + 15 B15 acceptance rule. |
| Recommendations and Rating | Pure Python plus SQL queries | Hostable in the FastAPI container. | Keep the algorithms and evidence labels. Add tenant predicates to every player-data query and indexes beginning with `owner_id`. |
| RapidOCR / ONNX | In-process CPU and memory work; source and OCR JSON on local disk | Not suitable for Workers. A 512 MB free container may be tight and cold initialization can be slow; this requires measurement, not assumption. | Keep local-only for phase 1. Later isolate it as a bounded worker/job and delete the source quickly. Never run unbounded OCR in the web request pool. |
| Uploaded images | Normalized PNG and OCR JSON under `data/imports` | Ephemeral disks lose them; shared public storage increases privacy risk. | If remote OCR is enabled, use private R2 objects with random keys, no public bucket, short lifecycle, and application-level authorization. Prefer deletion immediately after review/confirmation. |
| Automatic browser handoff | `window.open` + exact-origin `postMessage`, with JSON download fallback | Reasonable as an experiment, not a guaranteed mobile transport. Popup policy, COOP, bookmarklet support, and SEGA page changes can break it. | Serve a dedicated handoff route without COOP isolation that severs the opener. Preserve file download/upload as a first-class fallback. Do not transmit credentials, cookies, or session tokens. |

## Recommended public architecture

### Edge/UI layer

Run the existing vinext application on Cloudflare Workers. Static asset requests are free and unlimited under current Workers pricing; dynamic Worker requests on the Free plan are limited to 100,000/day and 10 ms CPU per invocation. The Paid plan has a USD 5/month account minimum, includes 10 million requests and 30 million CPU-ms per month, and then meters overage. Workers always cap an isolate at 128 MB, so OCR must not move into this layer.

The Worker should own the public origin and proxy `/v1/*` to FastAPI. Benefits:

- the browser uses one HTTPS origin;
- anonymous cookies remain first-party;
- CORS can be denied by default at FastAPI;
- edge rate limits and request-size checks run before Python;
- API host changes do not leak into the client bundle;
- the DX NET page only sends a structured `postMessage` to the already-open MaiUp receiver; it never sends SEGA cookies or credentials to MaiUp.

The `/dxnet-import` receiver must be reviewed separately from general security headers. `Cross-Origin-Opener-Policy: same-origin` would sever the cross-origin opener relationship that the handoff requires. This narrow route should use the least-permissive policy that still preserves the tested opener flow, while all messages continue to verify exact origin, source window, protocol version, one-time handoff ID, schema, count, and byte size.

### API/compute layer

Keep FastAPI in a container for the pilot. This preserves SQLAlchemy, Decimal Rating logic, catalog validation, and recommendation behavior. It also avoids porting the application to TypeScript/D1 before public behavior is validated.

The container should have:

- a non-root runtime user;
- explicit CPU/memory/concurrency limits;
- a health endpoint that does not query sensitive data;
- structured logs with request IDs, stage, status, latency, and aggregate counts only;
- no payload bodies, song lists, filenames, cookies, bearer tokens, full import IDs, or image data in logs;
- separate web and OCR process pools if remote OCR is later enabled;
- a scheduled catalog-sync job with a single-writer lock.

### Database layer

PostgreSQL is the smallest migration from the existing SQLAlchemy code. D1 is SQLite-compatible at the SQL level, but using it directly would still require replacing the Python runtime, SQLAlchemy session layer, migrations, job execution, and OCR boundary. D1 is attractive only after a deliberate backend rewrite, not for the minimum experiment.

Required schema/security additions before any public test:

- `anonymous_sessions(id, token_hash, created_at, last_seen_at, expires_at, deleted_at)`;
- `owner_id` on `player_imports` and `player_score_snapshots`, with ownership propagated through foreign keys;
- owner-first indexes for every lookup of imports, scores, entries, and recommendation inputs;
- database constraints/cascades for complete deletion;
- a hashed owner token only; never store the raw anonymous token;
- every player-data service function requires `owner_id`; an unscoped lookup by `import_id` is forbidden;
- opaque public IDs are identifiers, not authorization credentials;
- Alembic migrations and a rollback/backup procedure.

For the pilot, use an anonymous first-party session in a `Secure`, `HttpOnly`, `SameSite=Lax` cookie. The API should validate `Origin`/`Host` for state-changing requests and reject cross-origin credentialed traffic. Account login can be added later; it is not required to achieve safe isolation.

### Blob and catalog storage

R2 is appropriate for immutable catalog JSON and, only if remote OCR is approved, short-lived private image objects. Current pricing includes 10 GB-month, 1 million Class A operations, and 10 million Class B operations per month; standard overage is USD 0.015/GB-month, USD 4.50/million Class A, and USD 0.36/million Class B, with no Internet egress charge.

Do not make player image buckets public. Do not put user-identifying data in object keys. Signed URLs should be short-lived and owner-bound. Lifecycle expiry is defense in depth; successful user deletion must actively delete the object and its database rows.

## Hosting option comparison

Prices and limits below were checked against official pages on 2026-09-21 and can change.

| Option | Current cost/limits relevant to MaiUp | Cold start/persistence | Migration and maintenance | Fit |
| --- | --- | --- | --- | --- |
| OpenAI Sites + D1/R2 | Public beta on eligible ChatGPT plans with plan-specific usage limits shown in ChatGPT. Sites documents a 10 GB D1 limit and no fixed R2 storage limit. It does not support data or inference residency at launch. | D1/R2 are durable, but only supported Sites runtime shapes can be deployed; the current FastAPI/ONNX backend is not established as compatible. | Potentially low-friction for a compatible frontend or deliberate TypeScript/D1 rewrite, but it is not a drop-in host for the present Python API. | Useful preview candidate. Not the default recommendation for sensitive score data or the current backend. |
| Cloudflare Workers + D1 + R2 only | Workers Free: 100k requests/day, 10 ms CPU/request, 128 MB. Paid: USD 5/month minimum. D1 Free: 5M rows read/day, 100k written/day, 5 GB. R2 free allowances above. | Scale-to-zero; D1/R2 persistent. Workers cannot run current Python/ONNX. | Highest migration: rewrite FastAPI/SQLAlchemy jobs and keep OCR elsewhere. | Not recommended for the first pilot. |
| Cloudflare Worker UI + Render FastAPI + managed Postgres | Render free web service: 750 hours/month, sleeps after 15 idle minutes, roughly one-minute wake, ephemeral disk. Free Render Postgres expires after 30 days. Paid web starts at USD 7/month; paid Postgres compute starts at USD 6/month plus storage. | Free cold start is user-visible and local files disappear on restart/spin-down. Paid compute stays awake. | Low application migration; add PostgreSQL, object storage, and migrations. | Good for a private/synthetic experiment. Free database is not acceptable for production data. |
| Cloudflare Worker UI + Railway service/Postgres | One-time USD 5 trial credit expires after 30 days. Hobby has USD 5 minimum usage and includes USD 5 usage credit; usage beyond it is metered. | Persistent volumes/database are available; cost follows resource use. | Low migration and convenient all-in-one operations, but usage billing and a paid account need explicit approval. | Strong paid pilot candidate after measurement. |
| Cloudflare Worker UI + Cloud Run + external Postgres | Cloud Run request/instance billing has monthly free allowances; minimum instances cost money. Internet egress is separately billed. | Can scale to zero, so ONNX cold start must be measured; setting minimum instances removes most cold-start benefit and adds fixed cost. | Moderate: container registry, IAM, billing account, logs, and separate PostgreSQL/object storage. | Operationally robust, but more setup than the first experiment needs. |
| Cloudflare Worker UI + Render/Cloud Run + Supabase Postgres | Supabase Free: 500 MB DB, 5 GB egress, two projects; free projects pause after one week of inactivity. Pro starts at USD 25/month and includes 8 GB disk and 7-day backups. | Free pause/wake is unsuitable for a reliability claim; paid removes inactivity pause. | PostgreSQL-compatible and adds optional auth, but MaiUp should not expose Supabase directly to the browser. | Viable managed Postgres; use through FastAPI and keep ownership checks server-side. |

Recommendation: use Cloudflare Workers for the UI/gateway and keep FastAPI + PostgreSQL as the authoritative backend. For a no-purchase experiment, validate locally with PostgreSQL and synthetic data, then optionally use a free preview knowing that it is not production-grade. A paid hosting choice requires the user's explicit budget/account decision.

## Mobile and DX NET browser boundary

### What the web platform permits

- `window.open()` must occur directly in a user activation. Modern popup blockers can return `null`; opening after the asynchronous five-page crawl is unreliable.
- Cross-origin pages cannot inspect each other's DOM, but `postMessage` can send structured data. Both sides must use an exact `targetOrigin`, validate `event.origin` and `event.source`, and validate the message schema.
- COOP can place the popup in another browsing-context group and sever `window.opener`.
- A CSP `connect-src` directive controls `fetch`, XHR, WebSocket, EventSource, and `sendBeacon`. This is why the exporter should not depend on fetching the MaiUp API directly from the DX NET page.
- A public HTTPS site that calls localhost/private addresses triggers Chrome Local Network Access controls. A fully hosted MaiUp avoids that permission boundary; a hosted page must not quietly fall back to a local API.

### Platform assessment

| Platform | Bookmarklet/userscript reality | Automatic handoff status |
| --- | --- | --- |
| Desktop Chrome/Edge/Firefox | Bookmarklets can be installed, but copied `javascript:` URLs are user-managed and stale after source changes. Userscripts require an extension and explicit host permissions. | Most promising, but still dependent on popup policy, DX NET DOM/routes, CSP, and COOP. Requires a real authenticated smoke test. |
| Android Chrome | Google documents installing extensions from a phone as “Add to Desktop,” not running desktop extensions in mobile Chrome. Bookmarklet installation/execution has no stable first-party support contract. | Treat as unsupported until real-device tests pass. JSON download/upload must remain available. |
| iOS/iPadOS Safari | Safari Web Extensions exist on iOS/iPadOS, but distribution/testing is an app-extension workflow with permissions and packaging. That is a separate product, not a zero-install website feature. Bookmarklet behavior has no reliable first-party guarantee for this workflow. | Treat as experimental. Test popup creation, background tab behavior, memory, downloads, and return navigation on real devices. |

The public website can be zero-CMD, but a universally reliable zero-install automatic DX NET import cannot currently be promised. The safe product wording is “automatic import where supported, JSON fallback everywhere tested,” and even that must wait for the terms gate.

## Privacy, isolation, and abuse controls

### Proposed pilot retention

These values are recommendations for review, not silently adopted policy:

- anonymous session cookie: 30 days of inactivity;
- unconfirmed imports: 24 hours;
- confirmed complete-score imports: 30 days by default, user-deletable immediately;
- source image: delete immediately after OCR when possible, otherwise at confirmation/manual deletion and never later than 1 hour;
- OCR intermediate JSON: same lifetime as the source image;
- application security logs: 7 days, with no payload bodies or stable player identifiers;
- backups: document the provider's delayed deletion window and ensure expired records are not restored into the live system.

The UI must explain what is uploaded, why it is needed, retention time, deletion behavior, and that MaiUp is unofficial before the first upload/import. Provide a visible “Delete my data” action that deletes scores, B50 rows, recommendations/cache, image objects, and the anonymous session where requested.

### Abuse controls

- retain the 5 MB JSON and 10,000-score bounds; keep image size and pixel bounds;
- per-IP edge limits plus stricter per-anonymous-session limits on imports, OCR, corrections, and catalog search;
- one concurrent OCR job per anonymous session and a small global queue/concurrency cap;
- Turnstile only on expensive/suspicious actions, with mandatory server-side Siteverify validation; never treat a client widget alone as enforcement;
- idempotency keys for imports and delete operations;
- hard provider spend alerts/limits and an OCR kill switch;
- WAF/rate-limit rules at the edge plus application quotas, because IP-only limits are weak behind carrier NAT and can punish mobile users;
- no public listing or sequential IDs; do not log full capability URLs;
- dependency scanning, secret scanning, and restore drills before public release.

## Licensing, source, and unofficial-product boundary

- The MaiUp repository currently has no root license file. GitHub notes that without a license, default copyright applies. The owner must choose the project's public license and attribution before presenting it as open source; no license should be added on the owner's behalf without that decision.
- DXRating's repository is MIT-licensed, but its game data, cover artwork, trademarks, and other third-party material can retain separate rights. The current code already records this distinction; a public deployment needs an attribution page and permission/provenance review for each redistributed field.
- `mai-tools` is GPL-3.0. MaiUp must not copy its implementation. The tracked/remote “version snapshot” is data, but its redistribution and upstream rights still need a documented permission/provenance decision. A code license alone does not settle rights in SEGA data or artwork.
- Current cover URLs are reconstructed from an upstream raw snapshot and hotlink a third-party CloudFront host. Reliability and permission to use those covers publicly are unresolved. The public pilot should omit covers unless the source terms are confirmed.
- SEGA's maimai DX NET Terms of Service, revised 2025-10-17, expressly list unapproved automated tools/programs/macros and use beyond permitted/private scope among prohibited/restricted conduct. Public distribution of the exporter is therefore a release blocker, not merely a disclaimer issue.
- Every public page must clearly say that MaiUp is an independent, unofficial community project not affiliated with or endorsed by SEGA, and that community constants/tags are not official International values.

This is an engineering risk assessment, not legal advice.

## Phased route and gates

### Phase 0 - architecture hardening, local only

1. Add anonymous-session ownership to every player row and query.
2. Add complete deletion, retention cleanup, log redaction, and rate-limit interfaces.
3. Add PostgreSQL support and Alembic migrations while retaining SQLite for local desktop use.
4. Replace raw local-file assumptions with an asset-store interface; keep a local implementation and add an R2-compatible implementation behind configuration.
5. Add synthetic two-user isolation tests proving that user A cannot read, update, confirm, delete, or recommend from user B's import.
6. Decide repository license, attribution, cover policy, data-source permissions, and the DX NET terms boundary.

Exit gate: all ownership tests pass, a full delete is verified, and no player payload reaches logs.

### Phase 1 - hosted synthetic/private pilot, no OCR and no real DX NET

1. Build the vinext Worker preview and route `/v1` through the same-origin gateway.
2. Run FastAPI against a temporary PostgreSQL database using only generated fixtures.
3. Exercise complete-score import, official/fallback B50, report, recommendation, retention cleanup, and deletion.
4. Load-test import and recommendation endpoints with hard resource caps.
5. Verify provider restart/scale-to-zero behavior and database restore.

Exit gate: no cross-user access, acceptable cold start, bounded cost, successful restore/delete, and no public URL advertised.

### Phase 2 - limited human beta after policy approval

1. Obtain an explicit decision on DX NET exporter distribution and source/artwork permissions.
2. Test desktop Chrome/Edge/Firefox and real Android Chrome/iOS Safari with consenting accounts.
3. Clearly distinguish automatic handoff success from JSON fallback and record browser/version evidence.
4. Keep remote OCR disabled unless its separate threat model, retention, and resource measurements pass.

Exit gate: terms boundary accepted by the owner, privacy notice published, device matrix recorded, abuse controls live, and deletion tested on real beta data.

### Phase 3 - optional remote OCR

1. Run OCR in an isolated queued worker, not the API request process.
2. Store only normalized short-lived images in private object storage.
3. Measure model download, memory, CPU time, queue delay, and cold start on the chosen paid/free plan.
4. Validate multiple real International image templates; mocked fixtures do not prove mobile camera/screenshot compatibility.

Exit gate: bounded concurrency/cost, immediate deletion, and real-template accuracy evidence.

## Validation matrix

Automated validation can prove schema checks, tenant isolation, transport message validation, exact B35/B15 rules, and build compatibility. It cannot prove SEGA authorization, authenticated DX NET headers, popup behavior on a user's browser, iOS/Android bookmarklet support, real OCR accuracy, or provider reliability.

Required evidence before a public claim:

- backend unit/integration tests on both SQLite and PostgreSQL;
- frontend lint/build and a production Worker preview smoke test;
- hostile-origin `postMessage` tests, opener/COOP failure tests, and JSON fallback tests;
- cross-tenant read/write/delete tests for every player endpoint;
- rate-limit, oversized payload, decompression/pixel bomb, and concurrent OCR tests;
- real Android Chrome and iOS Safari runs recorded separately from desktop and mocks;
- a deletion audit covering database rows, R2 objects, logs, and backup policy.

## Official references

- [OpenAI Sites hosting, storage, identity, and beta limits](https://learn.chatgpt.com/docs/sites)
- [Cloudflare: vinext/Next.js on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)
- [vinext project status and deployment](https://github.com/cloudflare/vinext)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
- [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare storage selection](https://developers.cloudflare.com/workers/platform/storage-options/)
- [Cloudflare multi-tenant data isolation](https://developers.cloudflare.com/use-cases/saas/data-isolation/)
- [Cloudflare rate limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/)
- [Cloudflare Turnstile server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Render free-service limitations](https://render.com/docs/free)
- [Render pricing](https://render.com/pricing)
- [Railway pricing](https://railway.com/pricing)
- [Cloud Run pricing](https://cloud.google.com/run/pricing)
- [Supabase pricing](https://supabase.com/pricing)
- [MDN: `window.open`](https://developer.mozilla.org/en-US/docs/Web/API/Window/open)
- [MDN: `window.postMessage`](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)
- [MDN: Cross-Origin-Opener-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy)
- [MDN: CSP `connect-src`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src)
- [Chrome: Local Network Access](https://developer.chrome.com/blog/local-network-access)
- [Apple: Safari extensions](https://developer.apple.com/safari/extensions/)
- [GitHub: licensing a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)
- [DXRating repository and MIT license](https://github.com/gekichumai/dxrating)
- [mai-tools repository and GPL-3.0 license](https://github.com/myjian/mai-tools)
- [maimai DX NET Terms of Service](https://maimaidx-eng.com/maimai-mobile/termsOfService/)
- [maimai DX NET Privacy Policy](https://maimaidx-eng.com/maimai-mobile/privacyPolicy/)

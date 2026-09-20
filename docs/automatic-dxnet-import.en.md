# Automatic DX NET import experiment

## Scope

This experiment removes the required “download JSON, then upload JSON” step while preserving that file flow as a fallback. It only runs after the player has logged in to International DX NET and deliberately activates the MaiUp bookmarklet.

It does not perform network interception, collect credentials, read cookies, or copy session tokens. The exporter reads rendered score pages and same-origin DX NET responses inside the player's existing browser session, as the existing JSON exporter already does.

## Browser boundary findings

- `window.open()` must run synchronously from the bookmarklet activation. Browsers may block a popup created after the asynchronous score crawl has finished. A blocked popup returns `null`.
- Cross-origin pages cannot inspect each other's DOM, but an opener and its popup may exchange structured data with `postMessage`. Both sides must use an exact target origin and validate both `MessageEvent.origin` and `MessageEvent.source`.
- A `Cross-Origin-Opener-Policy` response can sever `window.opener`. The anonymous DX NET response inspected on 2026-09-21 did not include COOP, but the authenticated response was not inspected. The implementation therefore treats a missing/severed opener as a transport failure.
- Navigating a new top-level window from HTTPS DX NET to `http://localhost` is not an active mixed-content fetch. DX NET never fetches the MaiUp API directly: the local receiver performs its own same-origin `/v1/imports/scores` request, so the API CORS allowlist does not need to trust DX NET and no Local Network Access permission is required for the data transfer.
- The one-time handoff ID is placed in the URL fragment, which is not sent to the local HTTP server. It binds the ready, payload, success, and failure messages to one receiver window.

References:

- [MDN: `window.open()`](https://developer.mozilla.org/en-US/docs/Web/API/Window/open)
- [MDN: `window.postMessage()`](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)
- [MDN: Cross-Origin-Opener-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy)
- [MDN: Mixed content](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content)
- [MDN: URI fragment](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment)

## Minimal protocol

1. The bookmarklet validates that it is running on `https://maimaidx-eng.com` and synchronously opens `/dxnet-import#<handoff-id>` on the configured loopback MaiUp origin.
2. The receiver installs its message listener, confirms that it has an opener, and sends `receiver-ready` only to the exact DX NET origin.
3. The exporter reads scores. It sends the payload only after validating the receiver's exact origin, window reference, channel, version, and handoff ID.
4. The receiver repeats those checks, validates the payload shape and 5 MB size limit, then posts it to the existing local API.
5. On success the receiver acknowledges and navigates to `/scores/<import-id>`. On popup, opener, timeout, validation, or API failure, the exporter downloads the same JSON payload.

## Known limits

- Authenticated DX NET COOP behavior and mobile-browser popup behavior still need a real-account browser smoke test.
- A user must replace an already-saved bookmarklet with the newly copied code; refreshing MaiUp does not update a browser bookmark.
- This is an unofficial user-side tool and is not evidence of SEGA authorization. A terms and operational review remains necessary before wider release.

# CouchLock architecture and performance handoff

Reviewed 2026-11-11. The media layout has been implemented; the performance work below is deferred for the next agent. Findings are based on this checkout, not the outdated implementation description in `CLAUDE.md`. No production traffic, device battery usage, or real streaming-account sessions were profiled.

## How the project is wired

```text
Phone: index.html (UI, pairing, input, themes, notifications)
  -> transport.js: MQTT over WSS, AES-GCM encrypted session messages
  -> external MQTT broker
  -> extension/transport.js
  -> extension/background.js: session, active tab/frame, routing, fullscreen
  -> extension/content.js: player strategies, DOM input, cursor, status
  <- media snapshots, command results, artwork, notifications

Pairing: extension popup <-> discovery.js <-> phone
Offline app shell and push display: sw.js
Background push sending: extension/webpush.js
```

| Component | Responsibilities and relevant constraints |
| --- | --- |
| `index.html` | Buildless PWA with inline CSS and a large application IIFE. Media UI consumes `media_status`, `media_poster`, and `skip_ad_available`; buttons send existing `cmd` actions. Progress interpolates for at most two seconds between authoritative snapshots. |
| `transport.js`, `extension/transport.js` | Minimal MQTT client, encryption, ordered asynchronous send/receive queues, presence, reconnect and ping handling. Transport parity is already tested. Default broker: `wss://broker.hivemq.com:8884/mqtt`. |
| `discovery.js`, `extension/discovery.js` | Public-IP or six-digit-code rendezvous, ECDH exchange, nonce commitment, user-confirmed matching code. IP discovery calls `api.ipify.org`; session transfer is encrypted. |
| `extension/background.js` | Persists pairing, selects the active player frame, forwards commands/status, manages browser fullscreen, derives notifications, fetches and reduces artwork. A 30-second alarm checks transport health. |
| `extension/content.js` | Runs in all matching frames on all URLs. Selects a visible player, tries platform control strategies with fallbacks, reports status, renders the remote cursor, and handles input focus. |
| `sw.js`, `manifest.json` | Network-first navigation and cache-first assets; standalone PWA with rotation allowed. Navigation refreshes cached HTML on successful same-origin requests. Script URLs must be versioned when scripts change. The landscape update bumps the cache to v11 to refresh the cached manifest. |
| `extension/popup.*`, `success.html` | Pairing/settings entry point and a separate public-facing page. The popup also consumes shared transport/discovery code. |
| `tests/` | Node test runner, VM-based browser/extension stubs, an in-memory MQTT broker, and a real headless Chrome smoke test with synthetic players. No package installation is required. |

The product is **not currently local-network-only**. Encrypted command traffic leaves the LAN through the broker; discovery, Google Fonts, and optional Web Push also involve external services. Existing local-only claims in project notes and the extension description need reconciliation. Encryption and local-only networking are different properties. Changing the networking architecture is a separate product decision.

## Baseline evidence

- Before the layout edit, `index.html` was 174,570 bytes. Other source sizes: background 48,843 B; content script 40,466 B; transport 16,843 B per copy; discovery 12,965 B per copy. These are source sizes, not compressed transfer or runtime heap measurements.
- Every injected content-script frame schedules `reportMediaStatus` every 1,000 ms. Media events also schedule a coalesced report after 40 ms.
- An unchanged status is suppressed for up to 10 seconds, **after** player selection, strategy queries, geometry/style reads, title lookup, and serialization have run. A playing video's changing time usually defeats snapshot equality.
- The background reselects the player and sends its snapshot for each accepted active-tab frame report. It does not deduplicate the selected outbound snapshot across reports from different frames.
- Artwork is reduced to a 160-pixel-wide JPEG and cached in memory. A single delayed lookup retries after four seconds. The 5 MB input check occurs after `response.blob()` has downloaded the body.
- Transport preserves message order, but `send()` starts encryption for every message and does not check `WebSocket.bufferedAmount` or cap queued work.
- The phone already batches trackpad movement through animation frames and skips media rendering when hidden or on another tab. Preserve these protections.

## Prioritized follow-up work

### 1. Reduce unnecessary frame polling and duplicate status traffic

Start in `extension/content.js`: `reportMediaStatus`, `activeVideo`, `strategyControl`, `scheduleMediaStatus`. Trace routing through `extension/background.js`: the `mediaStatus` handler and `relayMediaStatus`.

Measure a 60-second capture for each of: unpaired browser with 20 tabs; paired paused video; paired playing video; embedded player with multiple frames; phone hidden. Record content-script timer callbacks, time spent in selectors/layout reads, runtime messages, encrypted publications, and bytes. Use synthetic pages first; verify at least one real player afterward. Avoid logging session tokens, private titles, or typed input.

Then introduce explicit monitoring eligibility for the active tab and its relevant frames. Use a slower discovery cadence for inactive/no-video frames and immediate reporting on activation/request. Consider caching the selected video and invalidating on removal/source changes, with a periodic fallback for SPA players. Deduplicate outgoing selected-frame snapshots in the background, while preserving explicit refresh requests and liveness heartbeats.

Acceptance: inactive tabs do not continuously run the full player/strategy scan; repeated reports from irrelevant frames do not republish identical selected-player snapshots; tab switches, late iframe players, pause/seek/ended events, phone wake, and notification moments still update promptly. Do not stop background monitoring solely because the phone is hidden: notification detection depends on it. Preserve the existing stale-frame expiration and player scoring behavior.

### 2. Bound transport work under congestion

Start in `transport.js`: `send`, `sendQueue`, reconnect lifecycle; inspect the phone's `flushMove` and air-mouse send paths. Apply any transport edit to both copies.

Instrument queue depth, encryption latency, socket buffered bytes, and input-to-action latency under a slow fake broker and delayed crypto. Introduce bounded handling for expendable movement/status traffic. Accumulate relative movement deltas rather than simply retaining the latest delta. Keep discrete clicks, keystrokes, seeks, and session commands ordered; never replay stale work after reconnect. Use the existing delayed-encryption/decryption tests as invariants.

Acceptance: buffered work stays bounded during sustained movement; control commands are not trapped behind obsolete movement; reconnect cannot deliver a previous connection's commands. Record before/after p50 and p95 command latency rather than claiming improvement from code structure alone.

### 3. Make artwork fetching resource-bounded

Start in `extension/background.js`: `updatePoster`, `resolvePoster`, `shrinkImage`. Add a timeout and cancellation when the selected media changes; check length headers when present and enforce a streamed byte limit. Bound both decoded/output dimensions, including unusually tall artwork. A compressed file's byte size does not bound decoded pixels.

Acceptance: oversized, stalled, malformed, and superseded artwork requests terminate without delaying remote commands; old artwork cannot replace new media; ordinary artwork still fetches once per source and uses the existing delayed retry.

### 4. Profile rendering and make motion optional

Inspect the phone's blurred poster, animated `width` progress fill, repeating glow animations, and the content script's cursor `left`/`top` updates. Capture a low-end phone or CPU-throttled browser trace during playback and trackpad movement. Only replace positioning/progress animation with transforms where traces justify it, preserving fullscreen/top-layer cursor behavior.

Add `prefers-reduced-motion` support and explicitly suspend decorative animation on hidden views. Cached DOM references and changed-field rendering can simplify `updateMediaUI`, but the existing once-per-second updates are not evidence of a serious bottleneck by themselves.

Acceptance: no regression in scrubbing, theme contrast, or cursor placement; reduced-motion mode has no decorative looping animation; measured layout/paint time improves in the chosen scenario.

### 5. Improve maintenance and app-shell behavior

- Establish one source/copy step for transport and discovery; preserve the existing transport parity test and add discovery parity coverage. Keep the buildless distribution if introducing a framework offers no concrete benefit.
- Extract the large PWA's CSS and cohesive modules incrementally. Several tests slice inline source using string markers, so migrate tests alongside extraction rather than silently breaking the harness. Update asset versions and service-worker precache entries together.
- Add a concise current README with launch, extension-loading, test, cache/versioning, and actual network-topology instructions. `CLAUDE.md` still describes an early design-only phase.
- Cap desktop navigation sizing and improve landscape behavior outside Media in a separate UI change. `.topbar-nav` uses viewport width and `.nav-btn` uses a square aspect ratio. At 1280 × 800, the current shell leaves only about 243 px for content. Media now scrolls safely in that area. The requested phone landscape layout is implemented: while Media is active at landscape heights up to 600 px, navigation becomes compact and the media controls fit in a two-column grid.
- Audit keyboard accessibility separately: the timeline is a touch/click `div`, inactive mode views are hidden through opacity/pointer events rather than `inert`, and the viewport disables user scaling. Media buttons now have labels, visible focus, and actual disabled states.
- Consider reporting actual volume/muted state through the protocol before adding a volume slider or a persistent mute indicator. The current protocol does not expose those values; the redesigned Mute button remains a command, not a claimed state.

## Media layout delivered

`index.html` now has a constrained, centered remote layout, rounded now-playing card, 96 px primary playback control (80 px on short portrait screens), labeled seek buttons, grouped volume controls, a platform-specific skip row, and separate next/fullscreen actions. Landscape uses now-playing and playback boxes on the left and volume/skip/viewing boxes on the right, with a 72 × 64 px play/pause button. All supported actions fit without scrolling in the tested phone landscape sizes; navigation and action targets remain at least 44 px. Existing theme tokens, button IDs, and command names remain in use. Skip/next controls use native disabled states when unavailable. Short portrait and desktop content areas can still scroll instead of clipping controls.

`tests/browser-smoke.cjs` verifies geometry at 320 × 568, 390 × 844, 430 × 932, 568 × 320, 740 × 300, 667 × 375, 812 × 375, 844 × 390, 932 × 430, and 1280 × 800. Checks cover minimum target sizes, button overlap, portrait/desktop scrolling, landscape visibility without scrolling, long titles, platform changes, command routing, labels/icons, and idle/unavailable states. The 812 × 375 fixture reserves a 21 px bottom safe area. Optional `COUCHLOCK_SCREENSHOT` and `COUCHLOCK_LANDSCAPE_SCREENSHOT` save PNGs from the synthetic phone fixture. Local previews are `docs/media-layout.png` and `docs/media-landscape.png` (the existing `/docs/` ignore rule excludes them from Git).

Validation: `node --test tests/*.test.cjs tests/browser-smoke.cjs` passed **70 tests, 0 failures, 0 skips**, including real headless Chrome and all 14 palette contrast checks. Chrome uses synthetic media and a mocked phone transport; live streaming providers, touch scrolling on physical iOS/Android, and real broker latency remain unverified. The browser fixture omits external fonts, so the screenshot uses installed fallback fonts.

## Instructions for the next agent

1. Run the baseline suite above. Chrome is detected at the existing Windows path; use `CHROME_PATH` to override it. Confirm the browser test actually ran rather than skipped.
2. Measure the scenarios in priority 1 before editing. Save timing/message/byte results with hardware, browser, tab/frame count, and scenario duration.
3. Implement one focused improvement at a time, starting with frame eligibility and duplicate status forwarding. Retain pairing, reconnection, notification, and cross-origin fullscreen tests.
4. Keep both shared script copies synchronized and bump `?v=` references plus `sw.js` entries if shared PWA scripts change. HTML-only layout edits use the existing network-first navigation behavior.
5. Deliver measured before/after results and any remaining device-validation gaps. Do not replace the networking model or expand this work into a framework migration without a separate requirement.

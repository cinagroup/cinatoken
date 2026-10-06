# Reference notes for real BFCache acceptance

This supplement records browser observations against the current f9 production Web deployment and offline analysis of already captured source downloads. It does not complete the full migration checklist, authenticate a user, select a workspace, create or revoke keys, or approve the pending production OAuth association.

Playwright's current API documentation explicitly warns that BFCache testing is unsupported and that its back/forward helpers can time out after real restoration. The harness therefore uses CDP navigation history and observes the actual document, persisted pageshow event, and node/controller identity. The installed runtime has a default --disable-back-forward-cache switch; only that default switch is removed for the dedicated fresh test browser. [Playwright Page](https://playwright.dev/docs/api/class-page#page-go-back), [BrowserType](https://playwright.dev/docs/api/class-browsertype#browser-type-launch).

Chrome documents conditional BFCache support for no-store pages, with eviction conditions including cookie/auth changes and no-store fetch/XHR responses. This is reference context, not proof of this browser's eligibility or the reason for any observed failure. The actual persisted events and browser NotRestoredReasons take precedence. [Chrome no-store BFCache](https://developer.chrome.com/docs/web-platform/bfcache-ccns), updated September 9, 2025.

CDP exposes navigation history and BFCache non-restoration events. The harness preserves the production caching/security policies and product listeners. [Chrome DevTools Protocol Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/).

Static review found that public preferences have a document-lived owner and restore theme/controls on pageshow. TanStack History registers beforeunload and scroll restoration registers pagehide; no blanket claim that the entire page has no such listeners is made. Existing VM tests use simulated events and cannot prove real BFCache restoration.

Download collector timestamps follow raw writes/hash and precede progress JSONL writes. Their intervals mix reader waiting, scheduling and local operations. Offline replays use preloaded captured bytes and do not reproduce the historical network or asynchronous reader. Original 30/60-second failures and performance gates stay pending.


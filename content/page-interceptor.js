/**
 * Page Interceptor — MAIN world
 *
 * Strategy:
 * Injected into the page's MAIN JavaScript context via `chrome.scripting.executeScript`
 * with `world: "MAIN"`. Intercepts `console.log` calls, which are invisible to ISOLATED-world
 * content scripts, and forwards them via `window.postMessage` to recorder.js.
 *
 * Network calls (XHR/fetch) are captured independently by the service worker using
 * `chrome.webRequest`, which works at the browser level regardless of injection timing.
 *
 * The `window.__wfRecording` flag gates whether captured events are actually posted.
 * The `window.__wfInterceptorsInstalled` guard prevents double-patching on re-injection.
 */

(function () {
  "use strict";

  // Mark recording active immediately — this script is only injected while recording.
  window.__wfRecording = true;

  // Skip patching if already done on this page lifecycle.
  if (window.__wfInterceptorsInstalled) return;
  window.__wfInterceptorsInstalled = true;

  // ─── console.log interception ───────────────────────────────────────────────

  const _origLog = console.log;
  console.log = function (...args) {
    _origLog.apply(console, args);
    if (!window.__wfRecording) return;
    const message = args
      .map((a) => {
        try {
          return typeof a === "string" ? a : JSON.stringify(a);
        } catch (_) {
          return String(a);
        }
      })
      .join(" ");
    window.postMessage(
      {
        __wfSrc: "__wf_interceptor__",
        type: "console_log",
        message,
        timestamp: Date.now(),
      },
      "*"
    );
  };

  // Network calls are now captured via chrome.webRequest in the service worker,
  // which intercepts at the browser level regardless of injection timing.
  // XHR/fetch prototype patching is no longer needed here.
})();

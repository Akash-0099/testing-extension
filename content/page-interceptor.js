/**
 * Page Interceptor — MAIN world
 *
 * Strategy:
 * Injected into the page's MAIN JavaScript context (not the isolated content-script
 * sandbox) via `chrome.scripting.executeScript` with `world: "MAIN"`. This allows
 * the script to intercept the page's own `console.log` calls and `fetch` / XHR
 * network requests, which are invisible to ISOLATED-world content scripts.
 *
 * Captured events are forwarded to the ISOLATED world (recorder.js) via
 * `window.postMessage` using the sentinel key `__wfSrc: '__wf_interceptor__'`.
 * recorder.js then relays them to the service worker.
 *
 * The `window.__wfRecording` flag controls whether events are actually posted;
 * it is set to `true` on injection and `false` when recording stops.
 *
 * A `window.__wfInterceptorsInstalled` guard prevents double-patching on
 * re-injection (e.g. when `activateTabRecorder` fires again after a SPA
 * navigation that didn't trigger a full page reload).
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

  // ─── fetch interception ─────────────────────────────────────────────────────

  const _origFetch = window.fetch;
  if (typeof _origFetch === "function") {
    window.fetch = function (input, init) {
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
          ? input.url
          : String(input);
      const method = (
        (init && init.method) ||
        (input instanceof Request && input.method) ||
        "GET"
      ).toUpperCase();

      const promise = _origFetch.apply(window, [input, init]);

      promise
        .then((response) => {
          if (!window.__wfRecording) return;
          window.postMessage(
            {
              __wfSrc: "__wf_interceptor__",
              type: "network_call",
              url,
              method,
              status: response.status,
              timestamp: Date.now(),
            },
            "*"
          );
        })
        .catch(() => {});

      return promise;
    };
  }

  // ─── XMLHttpRequest interception ────────────────────────────────────────────

  const _origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__wfMethod = (method || "GET").toUpperCase();
    this.__wfUrl = url || "";
    return _origOpen.apply(this, arguments);
  };

  const _origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", () => {
      if (!window.__wfRecording) return;
      window.postMessage(
        {
          __wfSrc: "__wf_interceptor__",
          type: "network_call",
          url: this.__wfUrl,
          method: this.__wfMethod,
          status: this.status,
          timestamp: Date.now(),
        },
        "*"
      );
    });
    return _origSend.apply(this, arguments);
  };
})();

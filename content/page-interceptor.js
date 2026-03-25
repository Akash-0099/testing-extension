/**
 * Page Interceptor — MAIN world
 *
 * Strategy:
 * Injected into the page's MAIN JavaScript context via `chrome.scripting.executeScript`
 * with `world: "MAIN"`. Intercepts `console.log` calls and network requests (fetch/XHR)
 * which are invisible to ISOLATED-world content scripts, and forwards them via
 * `window.postMessage` to recorder.js.
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

  // ─── Helper: Serialize request body ─────────────────────────────────────────

  function serializeBody(body) {
    if (!body) return null;
    try {
      if (typeof body === "string") return body.slice(0, 4000);
      if (body instanceof URLSearchParams) return body.toString().slice(0, 4000);
      if (body instanceof FormData) {
        const obj = {};
        body.forEach((v, k) => { obj[k] = v; });
        return JSON.stringify(obj).slice(0, 4000);
      }
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return "<binary>";
      return String(body).slice(0, 4000);
    } catch (_) {
      return null;
    }
  }

  // ─── Helper: post a network_call message ────────────────────────────────────

  function postNetworkCall(url, method, status, requestBody) {
    if (!window.__wfRecording) return;
    window.postMessage({
      __wfSrc: "__wf_interceptor__",
      type: "network_call",
      url,
      method: (method || "GET").toUpperCase(),
      status,
      requestBody: requestBody || null,
      timestamp: Date.now(),
    }, "*");
  }

  // ─── fetch interception ──────────────────────────────────────────────────────

  const _origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
    const method = ((init && init.method) || (input instanceof Request && input.method) || "GET").toUpperCase();
    const requestBody = serializeBody((init && init.body) || (input instanceof Request ? null : null));
    const p = _origFetch.apply(this, arguments);
    p.then((resp) => {
      postNetworkCall(url, method, resp.status, requestBody);
    }).catch(() => {});
    return p;
  };

  // ─── XHR interception ───────────────────────────────────────────────────────

  const _origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__wfMethod = (method || "GET").toUpperCase();
    this.__wfUrl = url || "";
    return _origOpen.apply(this, arguments);
  };

  const _origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    const requestBody = serializeBody(body);
    this.addEventListener("load", () => {
      postNetworkCall(this.__wfUrl, this.__wfMethod, this.status, requestBody);
    });
    return _origSend.apply(this, arguments);
  };

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
})();

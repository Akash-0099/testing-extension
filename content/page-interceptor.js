/**
 * Page Interceptor — MAIN world (Recording)
 *
 * Strategy:
 * Injected into the page's MAIN JavaScript context during recording via
 * `chrome.scripting.executeScript` with `world: "MAIN"`. Intercepts console
 * methods and network requests (fetch/XHR) which are invisible to ISOLATED-world
 * content scripts.
 *
 * Cross-world delivery:
 *   window.postMessage(...)     → received by logs-dialog.js (ISOLATED world) for live UI updates
 *   CustomEvent (same window)  → received by playback-capture.js checkpoint watchers (MAIN world)
 *
 * Buffers maintained on the page:
 *   window.__wfConsoleLogs[]  — ring-buffer of console entries (max 1000)
 *   window.__wfNetCalls[]     — ring-buffer of full network calls (max 500)
 *
 * Guard: window.__wfInterceptorsInstalled prevents double-patching on re-injection.
 */

(function () {
  "use strict";

  // Mark recording active immediately.
  window.__wfRecording = true;

  if (window.__wfInterceptorsInstalled) return;
  window.__wfInterceptorsInstalled = true;

  const MAX_LOGS = 1000;
  const MAX_NET  = 500;
  const MAX_BODY = 64 * 1024; // 64 KB

  window.__wfConsoleLogs = window.__wfConsoleLogs || [];
  window.__wfNetCalls    = window.__wfNetCalls    || [];

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function pushLog(entry) {
    window.__wfConsoleLogs.push(entry);
    if (window.__wfConsoleLogs.length > MAX_LOGS) window.__wfConsoleLogs.shift();
    // postMessage → crosses to ISOLATED world (logs-dialog.js)
    window.postMessage({ __wfSrc: "__wf_interceptor__", type: "console_log", ...entry }, "*");
    // CustomEvent → stays in MAIN world (playback checkpoint watchers)
    window.dispatchEvent(new CustomEvent("__wf_console_log__", { detail: entry }));
  }

  function pushNet(entry) {
    window.__wfNetCalls.push(entry);
    if (window.__wfNetCalls.length > MAX_NET) window.__wfNetCalls.shift();
    // postMessage → crosses to ISOLATED world (logs-dialog.js)
    window.postMessage({ __wfSrc: "__wf_interceptor__", type: "network_call", ...entry }, "*");
    // CustomEvent → stays in MAIN world (playback checkpoint watchers)
    window.dispatchEvent(new CustomEvent("__wf_network_call__", { detail: entry }));
  }

  // ─── Clear commands from isolated world (logs-dialog.js clear button) ────────
  // The dialog runs in the ISOLATED world and cannot directly assign to MAIN world
  // variables, so it sends a postMessage that we receive here and act on.
  window.addEventListener("message", (e) => {
    if (!e.data || e.data.__wfSrc !== "__wf_dialog__") return;
    if (e.data.type === "clear_console") {
      window.__wfConsoleLogs = [];
    } else if (e.data.type === "clear_network") {
      window.__wfNetCalls = [];
    }
  });

  function serializeBody(body) {
    if (!body) return null;
    try {
      if (typeof body === "string") return body.slice(0, MAX_BODY);
      if (body instanceof URLSearchParams) return body.toString().slice(0, MAX_BODY);
      if (body instanceof FormData) {
        const obj = {};
        body.forEach((v, k) => { obj[k] = typeof v === "string" ? v : "<file>"; });
        return JSON.stringify(obj).slice(0, MAX_BODY);
      }
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return "<binary>";
      return String(body).slice(0, MAX_BODY);
    } catch (_) { return null; }
  }

  function headersToObj(headers) {
    if (!headers) return {};
    const obj = {};
    try {
      if (typeof headers.forEach === "function") {
        headers.forEach((v, k) => { obj[k] = v; });
      } else if (Array.isArray(headers)) {
        headers.forEach(([k, v]) => { obj[k] = v; });
      } else if (typeof headers === "object") {
        Object.assign(obj, headers);
      }
    } catch (_) {}
    return obj;
  }

  // ─── Console interception ────────────────────────────────────────────────────

  // Re-entrancy guard: prevents the extension's own capture/serialization code
  // from triggering another capture if it calls console.* internally.
  let __wfCapturing = false;

  const LEVELS = ["log", "warn", "error", "info", "debug"];
  LEVELS.forEach(level => {
    const _orig = console[level];
    console[level] = function (...args) {
      _orig.apply(console, args);
      if (!window.__wfRecording || __wfCapturing) return;
      __wfCapturing = true;
      try {
        const message = args.map(a => {
          try { return typeof a === "string" ? a : JSON.stringify(a); } catch (_) { return String(a); }
        }).join(" ");
        pushLog({ message, level, timestamp: Date.now(), url: location.href });
      } finally {
        __wfCapturing = false;
      }
    };
  });

  // ─── fetch interception ──────────────────────────────────────────────────────

  const _origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url    = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
    const method = ((init && init.method) || (input instanceof Request && input.method) || "GET").toUpperCase();
    const requestHeaders = headersToObj((init && init.headers) || (input instanceof Request ? input.headers : null));
    const requestBody    = serializeBody((init && init.body) || null);

    return _origFetch.apply(this, arguments).then((response) => {
      if (!window.__wfRecording) return response;

      const resHeaders = headersToObj(response.headers);
      const resStatus = response.status;
      const resStatusText = response.statusText;

      // Create a skeleton entry immediately so it's visible even if body parsing hangs
      const entry = {
        url,
        method,
        requestHeaders,
        requestBody,
        status: resStatus,
        statusText: resStatusText,
        responseHeaders: resHeaders,
        responseBody: null,
        timestamp: Date.now(),
      };

      // Push it to the UI immediately
      pushNet(entry);

      // Try to backfill the body asynchronously
      try {
        const cloned = response.clone();
        setTimeout(() => {
          cloned.text().then((text) => {
            if (text) {
              entry.responseBody = text.slice(0, MAX_BODY);
              // Fire an update event specifically for the body if needed, 
              // or just rely on the in-page buffer being updated by reference.
              // For simplicity, we just update the entry in the buffer.
            }
          }).catch(() => {});
        }, 0);
      } catch (_) {}

      return response;
    }).catch((err) => {
      if (window.__wfRecording) {
        pushNet({ url, method, requestHeaders, requestBody, status: 0, statusText: "NetworkError", responseHeaders: {}, responseBody: null, timestamp: Date.now() });
      }
      throw err;
    });
  };

  // ─── XHR interception ───────────────────────────────────────────────────────

  const _origOpen      = XMLHttpRequest.prototype.open;
  const _origSend      = XMLHttpRequest.prototype.send;
  const _origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__wfMethod  = (method || "GET").toUpperCase();
    this.__wfUrl     = url || "";
    this.__wfReqHdrs = {};
    return _origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__wfReqHdrs) this.__wfReqHdrs[name] = value;
    return _origSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const requestBody = serializeBody(body);
    this.addEventListener("loadend", () => {
      if (!window.__wfRecording) return;

      let responseBody = null;
      try {
        if (!this.responseType || this.responseType === "text" || this.responseType === "") {
          responseBody = (this.responseText || "").slice(0, MAX_BODY);
        } else if (this.responseType === "json" && this.response) {
          responseBody = JSON.stringify(this.response).slice(0, MAX_BODY);
        }
      } catch (_) {}

      const responseHeaders = {};
      try {
        (this.getAllResponseHeaders() || "").trim().split(/\r?\n/).forEach(line => {
          const idx = line.indexOf(":");
          if (idx > 0) responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        });
      } catch (_) {}

      pushNet({
        url: this.__wfUrl || "",
        method: this.__wfMethod || "GET",
        requestHeaders: this.__wfReqHdrs || {},
        requestBody,
        status: this.status,
        statusText: this.statusText,
        responseHeaders,
        responseBody,
        timestamp: Date.now(),
      });
    });
    return _origSend.apply(this, arguments);
  };
})();

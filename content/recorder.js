/**
 * Content Script - Recorder
 *
 * This script is injected into web pages to listen for user interactions
 * and record them as discrete events. It communicates with the background
 * service worker to toggle recording state and send captured events.
 */

(function () {
  "use strict";

  // Prevent double-injection on same page load.
  // Re-initializes if the extension context was invalidated (e.g., after an update).
  let runtimeConnected = false;
  try {
    runtimeConnected = !!(chrome.runtime && chrome.runtime.id);
  } catch (e) {
    // Context invalidated
  }
  if (window.__workflowRecorderLoaded && runtimeConnected) {
    return;
  }
  window.__workflowRecorderLoaded = true;

  let isRecording = false;

  /**
   * Generates a robust CSS selector for a given DOM element.
   *
   * Strategy:
   * 1. Prioritizes stable, framework-agnostic data attributes (data-testid, data-cy, etc.)
   *    which are highly resistant to structural or style changes.
   * 2. Falls back to the element ID if it exists and appears non-dynamic 
   *    (rejects auto-generated IDs from frameworks like React/Ember).
   * 3. For interactive elements (buttons, inputs), attempts to use accessibility 
   *    or form attributes (aria-label, name) if they uniquely identify the element.
   * 4. As a last resort, delegates to `buildSelectorPath` for a complete structural hierarchy.
   *
   * @param {Element} element - The target DOM element.
   * @returns {string} - A unique CSS selector string.
   */
  function generateSelector(element) {
    if (!element || element === document.body) return "body";

    const testAttrs = ["data-testid", "data-cy", "data-qa", "data-id", "data-automation"];
    for (const attr of testAttrs) {
      const val = element.getAttribute(attr);
      if (val) return `[${attr}="${CSS.escape(val)}"]`;
    }

    if (element.id) {
      const id = element.id;
      if (!/^[\d]/.test(id) && !/^(ember|react-|__)\d/.test(id)) {
        const sel = `#${CSS.escape(id)}`;
        try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (_) {}
      }
    }

    const interactiveTags = ["button", "a", "input", "select", "textarea"];
    if (interactiveTags.includes(element.tagName.toLowerCase())) {
      const ariaLabel = element.getAttribute("aria-label");
      if (ariaLabel) {
        const sel = `${element.tagName.toLowerCase()}[aria-label="${CSS.escape(ariaLabel)}"]`;
        try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (_) {}
      }
      const name = element.getAttribute("name");
      if (name) {
        const sel = `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
        try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (_) {}
      }
    }

    return buildSelectorPath(element);
  }

  /**
   * Builds a structural DOM path selector for an element.
   *
   * Strategy:
   * Traverses up the DOM tree from the target element to the body, recording the 
   * tag name, up to two stable class names (filtering out dynamic state classes 
   * like 'active' or 'hover'), and the element's index among identical siblings 
   * (`:nth-of-type`) to ensure specificity. At each level of traversal, it tests 
   * if the current constructed path uniquely identifies the target element in the DOM; 
   * if so, it short-circuits and returns the path early to keep the selector as 
   * short as possible.
   *
   * @param {Element} element - The target DOM element.
   * @returns {string} - A structural CSS selector string.
   */
  function buildSelectorPath(element) {
    const parts = [];
    let current = element;
    while (current && current !== document.body && current.nodeType === Node.ELEMENT_NODE) {
      let part = current.tagName.toLowerCase();
      const classes = Array.from(current.classList)
        .filter(c => c.length > 1 && !/^(active|hover|focus|disabled|selected|is-|has-|ng-|v-|js-)/.test(c))
        .slice(0, 2);
      if (classes.length) part += "." + classes.map(c => CSS.escape(c)).join(".");
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter(s => s.tagName === current.tagName)
        : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
      const candidate = parts.join(" > ");
      try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch (_) {}
      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  /**
   * Sends a recorded event to the background service worker.
   *
   * Strategy:
   * Acts as a gatekeeper that silently drops events if recording is currently toggled 
   * off. Valid events are routed through the standard Chrome extensions messaging API 
   * (`chrome.runtime.sendMessage`). Since the response is not critical to the 
   * recording flow, it catches and ignores any extension context errors (such as 
   * disconnects) to prevent console spam.
   *
   * @param {Object} eventObj - The recorded event data.
   */
  function sendEvent(eventObj) {
    if (!isRecording) return;
    try {
      chrome.runtime.sendMessage({ type: "RECORD_EVENT", event: eventObj }, () => {
        // Ignore response or connection errors
        if (chrome.runtime.lastError) {}
      });
    } catch (e) {
      // Ignore extension context invalidated errors
    }
  }

  /**
   * DOM Event Handlers
   * Each handler captures relevant data for specific user actions
   * and formats them into standardized event objects.
   */

  /**
   * Handles click interactions on the page.
   *
   * Strategy:
   * Evaluates standard left-clicks while explicitly ignoring clicks on the extension's 
   * own recording UI indicator. It also intercepts and cancels clicks that were part 
   * of a long-press interaction to prevent duplicate event registration. Captures 
   * detailed coordinate data, element payload (text content, form state), and standardizes 
   * the event object before dispatching.
   *
   * @param {MouseEvent} e - The native mouse click event.
   */
  function onMouseClick(e) {
    if (e.target.closest?.("#__workflow_rec_indicator__")) return;
    if (longPressFired) {
      longPressFired = false;
      return;
    }
    const el = e.target;
    sendEvent({
      type: "click",
      selector: generateSelector(el),
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
      pageX: Math.round(e.pageX),
      pageY: Math.round(e.pageY),
      tagName: el.tagName.toLowerCase(),
      textContent: el.textContent?.trim().slice(0, 100) || "",
      inputType: el.getAttribute?.("type") || null,
      placeholder: el.getAttribute?.("placeholder") || null,
      label: el.getAttribute?.("aria-label") || el.getAttribute?.("title") || null,
      timestamp: Date.now(),
      url: location.href,
    });
  }

  let longPressTimer = null;
  let longPressFired = false;
  let startX = 0;
  let startY = 0;

  /**
   * Initiates tracking for potential long-press interactions.
   *
   * Strategy:
   * Filters for left-clicks (button 0) and records the initial X/Y coordinates. 
   * Starts a 600ms timer; if the timer concludes without being cleared by mouse 
   * movement or release, it characterizes the interaction as a 'long_press' and 
   * fires the event, flagging `longPressFired` to block the subsequent click event.
   *
   * @param {MouseEvent} e - The native mousedown event.
   */
  function onMouseDown(e) {
    if (e.button !== 0) return;
    longPressFired = false;
    startX = e.clientX;
    startY = e.clientY;
    
    longPressTimer = setTimeout(() => {
      longPressFired = true;
      const el = e.target;
      sendEvent({
        type: "long_press",
        selector: generateSelector(el),
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        pageX: Math.round(e.pageX),
        pageY: Math.round(e.pageY),
        tagName: el.tagName.toLowerCase(),
        timestamp: Date.now(),
        url: location.href,
      });
    }, 600);
  }

  /**
   * Evaluates pointer movement to invalidate long-press interactions.
   *
   * Strategy:
   * If a long-press tracking timer is active, measures the pixel delta between the 
   * cursor's current position and its starting position. If the user drags the mouse 
   * beyond a 5px threshold (indicating a drag/select rather than a hold), the timer 
   * is cleared to abort the long-press event.
   *
   * @param {MouseEvent} e - The native mousemove event.
   */
  function onMouseMove(e) {
    if (longPressTimer) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    }
  }

  /**
   * Concludes long-press tracking.
   *
   * Strategy:
   * Clears any active long-press timer if the user releases the mouse button before 
   * the 600ms threshold is reached, effectively preventing the long-press event.
   *
   * @param {MouseEvent} e - The native mouseup event.
   */
  function onMouseUp(e) {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  /**
   * Handles right-click / context menu interactions.
   *
   * Strategy:
   * Captures the specific element interacted with alongside the coordinates. 
   * Since native context menus do not yield a click event, this uniquely registers 
   * intent to access secondary actions (i.e. 'right_click').
   *
   * @param {MouseEvent} e - The native contextmenu event.
   */
  function onContextMenu(e) {
    const el = e.target;
    sendEvent({
      type: "right_click",
      selector: generateSelector(el),
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
      pageX: Math.round(e.pageX),
      pageY: Math.round(e.pageY),
      tagName: el.tagName.toLowerCase(),
      textContent: el.textContent?.trim().slice(0, 100) || "",
      timestamp: Date.now(),
      url: location.href,
    });
  }

  /**
   * Records native toggle interactions (like expanding `<details>` elements).
   *
   * Strategy:
   * Captures the resulting `isOpen` state of the element immediately after the toggle 
   * action fires, allowing the replay mechanism to definitively assert the element's 
   * visual state.
   *
   * @param {Event} e - The native toggle event.
   */
  function onToggle(e) {
    const el = e.target;
    sendEvent({
      type: "toggle",
      selector: generateSelector(el),
      isOpen: el.open !== undefined ? el.open : undefined,
      tagName: el.tagName.toLowerCase(),
      timestamp: Date.now(),
      url: location.href,
    });
  }

  let scrollTimer = null;
  /**
   * Records viewport and inner-element scroll interactions.
   *
   * Strategy:
   * Employs a 150ms debounce layer to prevent flooding the background script with 
   * hundreds of events during a single scroll motion. Once scrolling ceases, it 
   * determines if the scroll occurred on the main window or a nested scrollable 
   * container, capturing the final X/Y scroll coordinates.
   *
   * @param {Event} e - The native scroll event.
   */
  function onScroll(e) {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const el = e.target;
      const isWin = el === document || el === document.documentElement || el === document.body;
      sendEvent({
        type: "scroll",
        selector: isWin ? null : generateSelector(el),
        scrollX: isWin ? window.scrollX : el.scrollLeft,
        scrollY: isWin ? window.scrollY : el.scrollTop,
        timestamp: Date.now(),
        url: location.href,
      });
    }, 150);
  }

  /**
   * Records critical keystrokes and shortcuts.
   *
   * Strategy:
   * Filters out standard typing character keys to avoid noise, as form input is 
   * handled separately via `onInput` / `onChange`. Solely captures structural navigation 
   * keys (Enter, Esc, Arrows, F1-F12) and key combos involving modifier keys 
   * (Ctrl, Meta, Alt, Shift), associating them with the currently focused element.
   *
   * @param {KeyboardEvent} e - The native keydown event.
   */
  function onKeyDown(e) {
    const special = ["Enter","Escape","Tab","Backspace","Delete",
      "ArrowUp","ArrowDown","ArrowLeft","ArrowRight",
      "F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12"];
    if (!special.includes(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) return;
    sendEvent({
      type: "keydown",
      key: e.key, code: e.code, keyCode: e.keyCode,
      ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey,
      selector: generateSelector(e.target),
      timestamp: Date.now(), url: location.href,
    });
  }

  const inputDebounce = new Map();
  /**
   * Tracks real-time value changes in text inputs and textareas.
   *
   * Strategy:
   * Ignores immediate input events for checkboxes and radio buttons (deferring to `onChange`).
   * Implements a 400ms debounce grouped specifically by the element's CSS selector, 
   * ensuring that rapid continuous typing only emits a single event with the final 
   * grouped value once the user pauses.
   *
   * @param {Event} e - The native input event.
   */
  function onInput(e) {
    const el = e.target;
    if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) return;
    
    const key = generateSelector(el);
    clearTimeout(inputDebounce.get(key));
    
    inputDebounce.set(key, setTimeout(() => {
      sendEvent({
        type: "input", selector: key, value: el.value,
        tagName: el.tagName.toLowerCase(), inputType: el.getAttribute("type") || null,
        timestamp: Date.now(), url: location.href,
      });
      inputDebounce.delete(key);
    }, 400));
  }

  /**
   * Captures committed value updates and boolean component states.
   *
   * Strategy:
   * Ignores standard text inputs since they are more reliably captured by `onInput`. 
   * Specifically targets dropdowns (`<select>`), checkboxes, and radio buttons, 
   * properly extracting `.checked` boolean values for toggles vs `.value` for options, 
   * ensuring accurate replay state.
   *
   * @param {Event} e - The native change event.
   */
  function onChange(e) {
    const el = e.target;
    if (el.tagName === "INPUT" && el.type === "text") return;
    
    const isCheckOrRadio = el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio");
    sendEvent({
      type: "change", selector: generateSelector(el),
      value: isCheckOrRadio ? el.checked : (el.value !== undefined ? el.value : el.checked),
      checked: isCheckOrRadio ? el.checked : undefined,
      tagName: el.tagName.toLowerCase(),
      inputType: el.getAttribute?.("type") || null,
      timestamp: Date.now(), url: location.href,
    });
  }

  /**
   * Recording Lifecycle Management
   */

  /**
   * Activates global event interception.
   *
   * Strategy:
   * Sets the `isRecording` flag and binds capture-phase (`true`) event listeners 
   * to the root document. Capture-phase ensures events are recorded before page-level 
   * components can call `stopPropagation()`, guaranteeing visibility into all interactions.
   * Invokes the persistent UI overlay to alert the user.
   */
  function startListening() {
    if (isRecording) return;
    isRecording = true;
    document.addEventListener("click", onMouseClick, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("mouseup", onMouseUp, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("toggle", onToggle, true);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("change", onChange, true);
    showRecordingIndicator();
  }

  /**
   * Deactivates event interception.
   *
   * Strategy:
   * Clears the `isRecording` flag and unbinds all exact match capture-phase listeners 
   * from the root document, safely returning the webpage to normal operational overhead. 
   * Removes the persistent UI overlay.
   */
  function stopListening() {
    if (!isRecording) return;
    isRecording = false;
    document.removeEventListener("click", onMouseClick, true);
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("mouseup", onMouseUp, true);
    document.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("toggle", onToggle, true);
    document.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("change", onChange, true);
    hideRecordingIndicator();
  }

  // Expose API for execution context injection (e.g. chrome.scripting.executeScript)
  window.__wfRecorder = { start: startListening, stop: stopListening };

  /**
   * UI Indicator
   */

  const INDICATOR_ID = "__workflow_rec_indicator__";

  /**
   * Renders the visual recording indicator badge.
   *
   * Strategy:
   * Injects a fixed, unclickable (`pointer-events: none`) DOM element into the page 
   * using isolated inline CSS to prevent page stylesheets from mutating its appearance. 
   * It appends an intermittent CSS animation (`__wf_blink__`) directly inside a 
   * `<style>` tag to visually simulate a pulsing 'REC' state.
   */
  function showRecordingIndicator() {
    if (document.getElementById(INDICATOR_ID)) return;
    const el = document.createElement("div");
    el.id = INDICATOR_ID;
    el.style.cssText = `
      position:fixed;top:12px;right:12px;z-index:2147483647;
      background:rgba(220,38,38,0.92);color:#fff;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      font-size:12px;font-weight:600;padding:5px 10px 5px 8px;
      border-radius:20px;display:flex;align-items:center;gap:6px;
      box-shadow:0 2px 8px rgba(0,0,0,0.3);pointer-events:none;letter-spacing:0.3px;
    `;
    const dot = document.createElement("span");
    dot.style.cssText = `
      width:8px;height:8px;background:#fff;border-radius:50%;
      animation:__wf_blink__ 1s infinite;flex-shrink:0;
    `;
    if (!document.getElementById("__wf_blink_style__")) {
      const s = document.createElement("style");
      s.id = "__wf_blink_style__";
      s.textContent = `@keyframes __wf_blink__{0%,100%{opacity:1}50%{opacity:0.2}}`;
      document.head.appendChild(s);
    }
    el.appendChild(dot);
    el.appendChild(document.createTextNode("REC"));
    document.body.appendChild(el);
  }

  /**
   * Removes the visual recording indicator badge.
   *
   * Strategy:
   * Safely searches for the badge by identical ID and removes it from the DOM.
   */
  function hideRecordingIndicator() {
    document.getElementById(INDICATOR_ID)?.remove();
  }

  /**
   * Extension Event Listeners
   * Handle incoming state synchronization signals from background worker and local storage.
   */

  // Strategy: Subscribes to changes in local storage key 'wfMode' across all pages, ensuring 
  // that a change from the extension popup or background script propagates immediately 
  // to toggle the listeners on this specific active page.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      try {
        if (area !== "local" || !changes.wfMode) return;
        if (changes.wfMode.newValue === "recording") {
          startListening();
        } else {
          stopListening();
        }
      } catch (err) {}
    });
  } catch (e) {}

  // Strategy: Permits direct point-to-point orchestration from the background worker 
  // without relying on storage sync lag. Useful for direct action triggers.
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      try {
        if (msg.type === "RECORDER_START") { 
          startListening(); 
          sendResponse({ ok: true }); 
        } else if (msg.type === "RECORDER_STOP") { 
          stopListening(); 
          sendResponse({ ok: true }); 
        }
      } catch (err) {}
      return false;
    });
  } catch (e) {}

  /**
   * Initialization
   * Checks the starting wfMode when script initially executes.
   */

  // Strategy: Ensures if a tab is refreshed or newly opened while a recording session 
  // is globally active, the script instantly resumes recording by fetching the global state.
  try {
    chrome.storage.local.get("wfMode").then(data => {
      if (data.wfMode === "recording") {
        startListening();
      }
    }).catch(() => {
      // Graceful silent failure on init storage fetch
    });
  } catch (e) {}

  /**
   * MAIN-world → ISOLATED-world bridge
   *
   * Strategy:
   * `page-interceptor.js` runs in the page's MAIN JavaScript context and posts
   * structured messages via `window.postMessage`. This listener, running in the
   * ISOLATED world, picks them up and forwards them to the service worker only
   * while recording is active. The sentinel `__wfSrc: '__wf_interceptor__'`
   * prevents cross-talk with unrelated postMessage traffic on the page.
   */
  window.addEventListener("message", (e) => {
    if (!isRecording) return;
    if (!e.data || e.data.__wfSrc !== "__wf_interceptor__") return;

    try {
      if (e.data.type === "console_log") {
        chrome.runtime.sendMessage({
          type: "RECORD_CONSOLE_LOG",
          log: {
            message: e.data.message,
            timestamp: e.data.timestamp,
            url: window.location.href,
          },
        });
      } else if (e.data.type === "network_call") {
        chrome.runtime.sendMessage({
          type: "RECORD_NETWORK_CALL",
          call: {
            url: e.data.url,
            method: e.data.method,
            status: e.data.status,
            timestamp: e.data.timestamp,
          },
        });
      }
    } catch (_) {}
  });

})();

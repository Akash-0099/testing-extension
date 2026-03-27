/**
 * Service Worker — Orchestrator
 *
 * Strategy:
 * Acts as the centralized state machine for the entire extension. It manages the global 
 * 'mode' (idle | recording | playing), orchestrates the injection of content scripts across 
 * all tabs, routes messages between the popup and content frames, and handles all external 
 * backend communications (saving to the dashboard). The SW is designed to be ephemeral 
 * (it may go dormant), so it aggressively stores critical state to `chrome.storage.local`.
 */

// ─── State ────────────────────────────────────────────────────────────────────

// Dashboard API base URL — update this if deploying the dashboard elsewhere
const DASHBOARD_URL = 'http://localhost:3000';

const state = {
  mode: "idle",       // 'idle' | 'recording' | 'playing'

  // Recording
  workflowName: "",
  events: [],
  screenshots: {},    // stepIndex -> dataUrl (both rec & play)
  screenshotCount: 0,
  recordingTabId: null,

  // Console / network interception (populated during recording)
  consoleLogs: {},    // { [tabId]: [{ message, timestamp, url }] }
  networkCalls: {},   // { [tabId]: [{ url, method, status, timestamp }] }
  dialogState: { consoleOpen: false, networkOpen: false },

  // Playing
  workflowsToPlay: [],
  workflowToPlay: null,
  playbackIndex: 0,
  playbackTabId: null,
};

// ─── Storage helpers (chrome.storage.LOCAL) ───────────────────────────────────

/**
 * Persists the recording active state.
 *
 * Strategy:
 * Writes 'recording' to `chrome.storage.local` alongside initializing empty event arrays.
 * Because it uses `local` (instead of `session`), this write triggers `chrome.storage.onChanged` 
 * inside every injected content script globally, allowing all tabs to immediately start 
 * capturing DOM events without needing direct message dispatches to each one.
 */
async function setRecordingActive() {
  try {
    await chrome.storage.local.set({
      wfMode: "recording",
      wfEvents: [],
      wfScreenshotCount: 0,
    });
  } catch (e) {
    console.error("[WFRec] setRecordingActive failed:", e);
  }
}

/**
 * Clears the recording active state.
 *
 * Strategy:
 * Forces `wfMode` to 'idle', prompting the same global `onChanged` broadcast to all 
 * content scripts to deactivate their listeners. Also cleans up heavy arrays (wfEvents, 
 * wfScreenshotCount) from storage to free up disk space.
 */
async function setRecordingIdle() {
  try {
    await chrome.storage.local.set({ wfMode: "idle" });
    await chrome.storage.local.remove(["wfEvents", "wfScreenshotCount"]);
  } catch (_) {}
}

/**
 * Periodically backs up the recorded events array.
 *
 * Strategy:
 * Service workers can be terminated by Chrome at any time. By regularly saving the active 
 * `state.events` memory array to local storage, the extension ensures no data is lost 
 * if the user takes too long between clicks and the SW goes to sleep.
 */
async function persistEvents() {
  try {
    await chrome.storage.local.set({
      wfEvents: state.events,
      wfScreenshotCount: state.screenshotCount,
    });
  } catch (_) {}
}

// ─── SW wake-up: restore in-memory state from local storage ──────────────────

/**
 * Initialize on SW Wake-up
 *
 * Strategy:
 * Uses a global `readyPromise` to block incoming message handling until the SW successfully 
 * pulls its saved state back from `chrome.storage.local`. This prevents race conditions 
 * where a content script sends an event immediately after waking the SW, but before the 
 * SW realizes it is supposed to be in 'recording' mode, thereby dropping the event.
 */
let _readyResolve;
const readyPromise = new Promise(r => { _readyResolve = r; });

(async () => {
  try {
    const stored = await chrome.storage.local.get(["wfMode", "wfEvents", "wfScreenshotCount"]);
    if (stored.wfMode === "recording") {
      state.mode = "recording";
      state.events = stored.wfEvents || [];
      state.screenshotCount = stored.wfScreenshotCount || 0;
    }
  } catch (_) {}

  // Restore network calls from session storage (survives SW restarts within the browser session).
  try {
    const session = await chrome.storage.session.get("wfNetworkCalls");
    if (session.wfNetworkCalls) {
      state.networkCalls = session.wfNetworkCalls;
    }
  } catch (_) {}

  _readyResolve();
})();

// ─── Message routing ──────────────────────────────────────────────────────────

/**
 * Core Message Router
 *
 * Strategy:
 * Central dispatch for all extension communications. Evaluates the `msg.type` and routes 
 * it to the appropriate async handler. Returns `true` for asynchronous operations to keep 
 * the Chrome messaging channel open until `sendResponse` is called. For recording events, 
 * explicitly awaits `readyPromise` first to guarantee state stability before processing.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "START_RECORDING":
      handleStartRecording(msg, sendResponse);
      return true;

    case "STOP_RECORDING":
      handleStopRecording(sendResponse);
      return true;

    case "RECORD_EVENT":
      readyPromise.then(() => {
        handleRecordEvent(msg.event);
        sendResponse({ ok: true });
      });
      return true; // async response — keep message channel open

    case "RESTART_RECORDING":
      handleRestartRecording(sendResponse);
      return true;

    case "DISCARD_RECORDING":
      handleDiscardRecording(sendResponse);
      return true;

    case "ADD_CHECKPOINT":
      handleAddCheckpoint(msg.label, sendResponse);
      return true;

    case "RECORD_CONSOLE_LOG":
      readyPromise.then(() => {
        if (state.mode === "recording") {
          const tid = sender.tab?.id;
          if (tid) {
            state.consoleLogs[tid] = state.consoleLogs[tid] || [];
            if (state.consoleLogs[tid].length < 500) state.consoleLogs[tid].push(msg.log);
          }
        }
        sendResponse({ ok: true });
      });
      return true;

    case "RECORD_NETWORK_CALL":
      // Network calls are now captured via chrome.webRequest (recordNetworkCall).
      // This handler is kept as a no-op fallback for any legacy callers.
      sendResponse({ ok: true });
      return false;

    case "RECORD_NETWORK_CALL_WITH_BODY":
      // Enriches the network call record from chrome.webRequest with request/response
      // body data that only the MAIN world fetch/XHR interceptor can see.
      readyPromise.then(() => {
        if (state.mode === "recording") {
          const tid = sender.tab?.id;
          if (tid) {
            const call = msg.call;
            state.networkCalls[tid] = state.networkCalls[tid] || [];
            // Try to find the matching webRequest entry and back-fill the body.
            // Match on URL + method; use the most recent matching call if multiple exist.
            const existing = state.networkCalls[tid];
            let merged = false;
            for (let i = existing.length - 1; i >= 0; i--) {
              if (existing[i].url === call.url && existing[i].method === call.method) {
                existing[i].requestBody = call.requestBody || null;
                merged = true;
                break;
              }
            }
            if (!merged && existing.length < 500) {
              existing.push(call);
            }
            chrome.storage.session.set({ wfNetworkCalls: state.networkCalls }).catch(() => {});
          }
        }
        sendResponse({ ok: true });
      });
      return true;

    case "GET_CONSOLE_LOGS":
      sendResponse({ logs: state.consoleLogs[sender.tab?.id] || [] });
      return false;

    case "GET_NETWORK_CALLS":
      sendResponse({ calls: state.networkCalls[sender.tab?.id] || [] });
      return false;

    case "CLEAR_CONSOLE_LOGS":
      if (sender.tab?.id) {
        state.consoleLogs[sender.tab.id] = [];
      }
      sendResponse({ ok: true });
      return false;

    case "CLEAR_NETWORK_CALLS":
      if (sender.tab?.id) {
        state.networkCalls[sender.tab.id] = [];
        chrome.storage.session.set({ wfNetworkCalls: state.networkCalls }).catch(() => {});
      }
      sendResponse({ ok: true });
      return false;

    case "TOGGLE_CONSOLE_DIALOG":
      state.dialogState.consoleOpen = !state.dialogState.consoleOpen;
      broadcastDialogStateToActiveTab();
      sendResponse({ ok: true });
      return false;

    case "TOGGLE_NETWORK_DIALOG":
      state.dialogState.networkOpen = !state.dialogState.networkOpen;
      broadcastDialogStateToActiveTab();
      sendResponse({ ok: true });
      return false;

    case "CLOSE_CONSOLE_DIALOG":
      state.dialogState.consoleOpen = false;
      broadcastDialogStateToActiveTab();
      sendResponse({ ok: true });
      return false;

    case "CLOSE_NETWORK_DIALOG":
      state.dialogState.networkOpen = false;
      broadcastDialogStateToActiveTab();
      sendResponse({ ok: true });
      return false;

    case "ADD_CONSOLE_CHECKPOINT":
      handleAddConsoleCheckpoint(msg.logMessage, msg.label, sendResponse);
      return true;

    case "ADD_NETWORK_CHECKPOINT":
      handleAddNetworkCheckpoint(
        msg.networkUrl,
        msg.networkMethod,
        msg.networkStatus,
        msg.networkStatusText || null,
        msg.networkRequestHeaders || null,
        msg.networkResponseHeaders || null,
        msg.networkRequestBody || null,
        msg.networkResponseBody || null,
        msg.label,
        sendResponse,
      );
      return true;

    case "START_PLAYBACK":
      handleStartPlayback(msg.workflows, sendResponse);
      return true;

    case "STOP_PLAYBACK":
      state.mode = "idle";
      state.workflowsToPlay = [];
      state.workflowToPlay = null;
      chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab) chrome.tabs.sendMessage(tab.id, { type: 'PLAYBACK_HUD_HIDE' }).catch(() => {});
      }).catch(() => {});
      broadcastToPopup({ type: "PLAYBACK_STOPPED" });
      sendResponse({ mode: state.mode, eventCount: state.events.length });
      return false;

    case "GET_STATE":
      sendResponse({ mode: state.mode, eventCount: state.events.length });
      return false;

    case "EXPORT_WORKFLOW":
      handleExportWorkflow(sendResponse);
      return true;

    default:
      sendResponse({ error: "Unknown message type" });
      return false;
  }
});

// ─── Recording ────────────────────────────────────────────────────────────────

/**
 * Begins a new recording session.
 *
 * Strategy:
 * Resets local state, updates storage to broadcast the flag globally, and then actively 
 * queries every open tab in the browser to inject and execute the recorder content script. 
 * This ensures even tabs that were open before the extension was installed can immediately 
 * participate in the recording.
 */
async function handleStartRecording(msg, sendResponse) {
  if (state.mode !== "idle") {
    sendResponse({ error: "Already in " + state.mode + " mode" });
    return;
  }

  resetState();
  state.mode = "recording";
  state.recordingTabId = msg.tabId ?? null;
  state.workflowName = msg.name || "";
  state.dialogState = { consoleOpen: false, networkOpen: false };

  // 1. Write wfMode="recording" to local storage.
  await setRecordingActive();

  // 2. Ensure content scripts are injected and activated on all tabs.
  await activateRecorderOnAllTabs();

  sendResponse({ ok: true, mode: state.mode });
}

/**
 * Terminates the current recording session.
 *
 * Strategy:
 * Reverts the system to 'idle' mode. It triggers a global teardown by updating storage, 
 * but also explicitly messages all tabs to deactivate their DOM listeners. Finally, 
 * it packages all captured events and screenshots for the popup and asynchronously 
 * initiates an auto-save to the external dashboard.
 */
async function handleStopRecording(sendResponse) {
  if (state.mode !== "recording") {
    sendResponse({ error: "Not recording" });
    return;
  }

  state.mode = "idle";

  await setRecordingIdle();
  await deactivateRecorderOnAllTabs();
  chrome.storage.session.remove("wfNetworkCalls").catch(() => {});

  sendResponse({ ok: true, events: state.events, screenshots: state.screenshots });

  // Auto-save to dashboard (fire-and-forget)
  saveToDashboard(state.events, state.screenshots).catch(e => console.warn('[WFRec] Dashboard save failed:', e));
}

/**
 * Restarts the current recording session.
 *
 * Strategy:
 * Clears the currently accumulated events and screenshots, keeping the active 
 * mode as 'recording' and maintaining the workflow name, so the user can start fresh.
 */
async function handleRestartRecording(sendResponse) {
  if (state.mode !== "recording") {
    sendResponse({ error: "Not recording" });
    return;
  }

  state.events = [];
  state.screenshots = {};
  state.screenshotCount = 0;
  state.consoleLogs = {};
  state.networkCalls = {};
  state.dialogState = { consoleOpen: false, networkOpen: false };
  broadcastDialogStateToActiveTab();

  await persistEvents();
  chrome.storage.session.remove("wfNetworkCalls").catch(() => {});

  sendResponse({ ok: true });
}

/**
 * Discards the current recording session without saving.
 *
 * Strategy:
 * Reverts the system to 'idle' mode. Triggers a global teardown by updating storage, 
 * explicitly messaging all tabs to deactivate their DOM listeners, and skipping the 
 * dashboard save step.
 */
async function handleDiscardRecording(sendResponse) {
  if (state.mode !== "recording") {
    sendResponse({ error: "Not recording" });
    return;
  }

  state.mode = "idle";
  state.workflowName = "";

  await setRecordingIdle();
  await deactivateRecorderOnAllTabs();
  chrome.storage.session.remove("wfNetworkCalls").catch(() => {});

  sendResponse({ ok: true });
}

/**
 * Processes an incoming DOM event from a content script.
 *
 * Strategy:
 * Pushes the verified event to the in-memory array. Implementing a pacing mechanic, 
 * it strictly persists the array to `chrome.storage` every 5 events to balance I/O 
 * overhead with data safety against SW dormancy. Finally, it broadcasts the new count 
 * to refresh the Popup UI.
 *
 * @param {Object} event - The recorded DOM interaction event.
 */
function handleRecordEvent(event) {
  if (state.mode !== "recording") {
    return;
  }
  state.events.push(event);

  if (state.events.length % 5 === 0) persistEvents();

  broadcastToPopup({ type: "EVENT_RECORDED", count: state.events.length });
}

/**
 * Captures a visual checkpoint of the active tab.
 *
 * Strategy:
 * Validates the active tab, invokes `chrome.tabs.captureVisibleTab` to generate a base64 
 * image, and appends a specialized 'checkpoint' event to the events array. It immediately 
 * persists to storage because checkpoints are critical, high-value data points.
 *
 * @param {string} label - Human-readable name for the checkpoint.
 * @param {Function} sendResponse - Callback to resolve the extension message.
 */
async function handleAddCheckpoint(label, sendResponse) {
  await readyPromise;
  if (state.mode !== "recording") {
    sendResponse({ error: "Not recording" });
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    sendResponse({ error: "No active tab" });
    return;
  }

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const index = state.screenshotCount++;
    state.screenshots[index] = dataUrl;

    const checkpointEvent = {
      type: "checkpoint",
      label: label || `Checkpoint ${index + 1}`,
      screenshotIndex: index,
      url: tab.url,
      timestamp: Date.now(),
    };
    state.events.push(checkpointEvent);

    persistEvents();

    broadcastToPopup({
      type: "CHECKPOINT_ADDED",
      index,
      label: checkpointEvent.label,
      screenshotDataUrl: dataUrl,
    });

    sendResponse({ ok: true, index, label: checkpointEvent.label });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

/**
 * Records a console-log-based checkpoint.
 *
 * Strategy:
 * Creates a specialized checkpoint event whose trigger condition is a console.log
 * message that matches `logMessage` (substring). During playback the service worker
 * will inject a MAIN-world watcher that resolves when that message appears.
 *
 * @param {string} logMessage - The console message substring to watch for.
 * @param {string} label - Human-readable name shown in the UI.
 * @param {Function} sendResponse
 */
async function handleAddConsoleCheckpoint(logMessage, label, sendResponse) {
  await readyPromise;
  if (state.mode !== "recording") {
    sendResponse({ error: "Not recording" });
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    sendResponse({ error: "No active tab" });
    return;
  }

  const autoLabel = label || `Console: ${logMessage.slice(0, 40)}`;
  const checkpointEvent = {
    type: "console_checkpoint",
    label: autoLabel,
    logMessage,
    url: tab.url,
    timestamp: Date.now(),
  };
  state.events.push(checkpointEvent);
  persistEvents();

  broadcastToPopup({ type: "CONSOLE_CHECKPOINT_ADDED", label: autoLabel });
  sendResponse({ ok: true, label: autoLabel });
}

/**
 * Records a network-call-based checkpoint.
 *
 * Strategy:
 * Creates a checkpoint event whose trigger condition is a network request matching
 * the given URL pattern and HTTP method. During playback the service worker injects
 * a MAIN-world fetch/XHR watcher that resolves when a matching call completes.
 *
 * @param {string} networkUrl - URL substring to match.
 * @param {string} networkMethod - HTTP method (e.g. "GET", "POST").
 * @param {number} networkStatus - HTTP status code captured during recording.
 * @param {string} label - Human-readable name.
 * @param {Function} sendResponse
 */
async function handleAddNetworkCheckpoint(networkUrl, networkMethod, networkStatus, networkStatusText, networkRequestHeaders, networkResponseHeaders, networkRequestBody, networkResponseBody, label, sendResponse) {
  await readyPromise;
  if (state.mode !== "recording") {
    sendResponse({ error: "Not recording" });
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    sendResponse({ error: "No active tab" });
    return;
  }

  const autoLabel = label || `Network: ${networkMethod} ${networkUrl.slice(0, 35)}`;
  const checkpointEvent = {
    type: "network_checkpoint",
    label: autoLabel,
    networkUrl,
    networkMethod,
    networkStatus,
    networkStatusText: networkStatusText || null,
    networkRequestHeaders: networkRequestHeaders || null,
    networkResponseHeaders: networkResponseHeaders || null,
    networkRequestBody: networkRequestBody || null,
    networkResponseBody: networkResponseBody || null,
    url: tab.url,
    timestamp: Date.now(),
  };
  state.events.push(checkpointEvent);
  persistEvents();

  broadcastToPopup({ type: "NETWORK_CHECKPOINT_ADDED", label: autoLabel });
  sendResponse({ ok: true, label: autoLabel });
}

// ─── Activate / deactivate recorder on all open tabs ─────────────────────────

/**
 * Broadcasts recorder activation to all open tabs.
 *
 * Strategy:
 * Queries all tabs and executes `activateTabRecorder` concurrently via `Promise.allSettled`, 
 * which guarantees that a failure on standard restricted URLs (like chrome:// settings pages) 
 * won't throw an unhandled rejection that blocks injection on valid web pages.
 */
async function activateRecorderOnAllTabs() {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const results = await Promise.allSettled(
    tabs.map(tab => activateTabRecorder(tab.id, "start"))
  );
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.warn("[WorkflowRec] Could not activate tab", tabs[i]?.id, r.reason?.message);
    }
  });
}

/**
 * Broadcasts recorder deactivation to all open tabs.
 *
 * Strategy:
 * Queries every tab and calls `activateTabRecorder(tabId, "stop")` in parallel via
 * `Promise.allSettled` so restricted URLs do not block cleanup on normal pages.
 */
async function deactivateRecorderOnAllTabs() {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  await Promise.allSettled(tabs.map(tab => activateTabRecorder(tab.id, "stop")));
}

/**
 * Syncs the global dialog state (which log dialog is open) to the currently active tab.
 */
async function broadcastDialogStateToActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: "SYNC_DIALOG_STATE",
        consoleOpen: state.dialogState.consoleOpen,
        networkOpen: state.dialogState.networkOpen
      }).catch(() => {});
    }
  } catch (e) {}
}

/**
 * Connects a specific tab to the recording loop.
 *
 * Strategy:
 * Employs a belt-and-suspenders methodology. First, it forces script injection via `chrome.scripting`. 
 * Even if the script is already there, it's necessary in case the context is stale. Following 
 * a brief initialization delay, it blasts a direct message to the tab to engage the listeners.
 *
 * @param {number} tabId - Target tab ID.
 * @param {string} action - 'start' or 'stop'.
 */
async function activateTabRecorder(tabId, action) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/recorder.js", "content/logs-dialog.js"],
    });
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content/logs-dialog.css"],
    });
  } catch (err) {
    return;
  }

  if (action === "start") {
    // Activate the isolated-world listener before patching the MAIN world so that
    // isRecording is true before __wfRecording is set to true. This closes the race
    // window where network calls could be posted by the interceptor before recorder.js
    // is ready to forward them.
    try {
      await chrome.tabs.sendMessage(tabId, { type: "RECORDER_START" });
    } catch (err) {
      // Expected on restricted pages
    }

    // Inject page-interceptor.js into the MAIN world so it can patch console.log,
    // fetch, and XHR on the page itself (invisible to the ISOLATED content script).
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/page-interceptor.js"],
        world: "MAIN",
      });
    } catch (_) {
      // Restricted pages (chrome://, extensions) will silently fail — that's fine.
    }
  } else {
    // Flip the recording flag in MAIN world so ongoing interceptors stop posting.
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => { window.__wfRecording = false; },
      });
    } catch (_) {}

    await new Promise(r => setTimeout(r, 100));

    try {
      await chrome.tabs.sendMessage(tabId, { type: "RECORDER_STOP" });
    } catch (err) {
      // Expected on restricted pages
    }
  }

  if (action === "start") {
    // Determine if this is the active tab and trigger its dialog if it should be open
    try {
      const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTabs.length && activeTabs[0].id === tabId) {
        broadcastDialogStateToActiveTab();
      }
    } catch (_) {}
  }
}

// ─── Network capture via webRequest ──────────────────────────────────────────

/**
 * Stores a captured network call and notifies the active tab's UI overlay.
 *
 * Strategy:
 * Called from both onCompleted and onErrorOccurred webRequest listeners. Waits
 * for readyPromise so state.mode is accurate even after a SW restart. Persists to
 * session storage on every write so data survives SW dormancy. Sends NETWORK_CALL_LIVE
 * to the tab so the Network Calls panel updates in real-time when it is open.
 */
function recordNetworkCall(tabId, call) {
  readyPromise.then(() => {
    if (state.mode !== "recording") return;
    if (!tabId || tabId < 0) return;
    state.networkCalls[tabId] = state.networkCalls[tabId] || [];
    if (state.networkCalls[tabId].length < 500) {
      state.networkCalls[tabId].push(call);
      chrome.storage.session.set({ wfNetworkCalls: state.networkCalls }).catch(() => {});
    }
    chrome.tabs.sendMessage(tabId, { type: "NETWORK_CALL_LIVE", call }).catch(() => {});
  });
}

chrome.webRequest.onCompleted.addListener(
  (details) => {
    recordNetworkCall(details.tabId, {
      url: details.url,
      method: details.method,
      status: details.statusCode,
      timestamp: details.timeStamp,
    });
  },
  { urls: ["*://*/*", "http://*/*", "https://*/*", "<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    recordNetworkCall(details.tabId, {
      url: details.url,
      method: details.method,
      status: 0,
      timestamp: details.timeStamp,
    });
  },
  { urls: ["*://*/*", "http://*/*", "https://*/*", "<all_urls>"] }
);

// ─── Tab switch tracking ──────────────────────────────────────────────────────

/**
 * On Tab Switch listener
 *
 * Strategy:
 * Intercepts when the user clicks between Chrome tabs. If recording, it logs a specialized 
 * 'tab_switch' event ensuring playback knows when to navigate. It immediately triggers injection/activation 
 * on the new tab, guaranteeing the tab is primed to capture the very next click.
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (state.mode !== "recording") return;

  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    state.events.push({
      type: "tab_switch",
      tabId: activeInfo.tabId,
      url: tab.url,
      title: tab.title,
      timestamp: Date.now(),
    });
    broadcastToPopup({ type: "EVENT_RECORDED", count: state.events.length });

    await activateTabRecorder(activeInfo.tabId, "start");
  } catch (_) {}
});

/**
 * On Tab Updated listener
 *
 * Strategy:
 * Captures standard page loads and SPAs. Whenever a tab finishes loading (`changeInfo.status === "complete"`),
 * the original injected script content is purged by the browser. This listener detects that purge and 
 * synchronously reactivates the recorder to resume tracking.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (state.mode !== "recording") return;
  if (changeInfo.status !== "complete") return;

  await activateTabRecorder(tabId, "start");
});

/**
 * On Frame Navigation listener
 *
 * Strategy:
 * Specifically targets top-level (frameId 0) hard reloads or URL bar commits. It logs a 'reload' 
 * event so the playback sequence knows it must explicitly refresh the page to maintain an accurate DOM state.
 */
chrome.webNavigation.onCommitted.addListener((details) => {
  if (state.mode !== "recording") return;
  if (details.frameId !== 0) return;
  if (details.transitionType === "reload") {
     state.events.push({
       type: "reload",
       url: details.url,
       timestamp: Date.now()
     });
     persistEvents();
     broadcastToPopup({ type: "EVENT_RECORDED", count: state.events.length });
  }
});

// ─── Playback ─────────────────────────────────────────────────────────────────

/**
 * Initializes the playback sequence across a queue of workflows.
 *
 * Strategy:
 * Validates the queue, sets up internal memory tracking for screenshots/progress, and switches mode 
 * to 'playing'. Passes execution immediately to `runPlaybackQueue()` allowing the async loops to process 
 * independently.
 */
async function handleStartPlayback(workflows, sendResponse) {
  if (state.mode !== "idle") {
    sendResponse({ error: "Already in " + state.mode + " mode" });
    return;
  }
  if (!Array.isArray(workflows) || workflows.length === 0) {
    sendResponse({ error: "Invalid workflow queue" });
    return;
  }

  state.mode = "playing";
  state.workflowsToPlay = workflows;
  state.playbackIndex = 0;
  state.screenshots = {};
  state.screenshotCount = 0;

  const config = await chrome.storage.local.get(["playBufferSeconds"]);
  state.playBufferMs = (config.playBufferSeconds !== undefined ? parseInt(config.playBufferSeconds) : 8) * 1000;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.playbackTabId = tab?.id ?? null;

  // Inject player.js dynamically into the active tab to ensure the HUD is ready,
  // especially if the extension was just reloaded and the tab's old context is dead.
  if (state.playbackTabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: state.playbackTabId },
        files: ["content/player.js"]
      });
    } catch (e) {}

    // Inject the playback capture accumulator into MAIN world BEFORE any steps run.
    // This ensures console logs and network calls fired by step-1's actions are already
    // captured in window.__wfPlayLogs / window.__wfPlayNet when later checkpoint steps run.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: state.playbackTabId },
        files: ["content/playback-capture.js"],
        world: "MAIN",
      });
    } catch (e) {}
  }

  sendResponse({ ok: true });
  runPlaybackQueue();
}

/**
 * Iterates through the queue of queued workflows.
 *
 * Strategy:
 * Executes each workflow fully sequentially via `runSinglePlayback()`. When the loop terminates (either 
 * gracefully or via user stop), resets the state to 'idle', clears the HUD from the active tab, and signals 
 * completion to the popup UI.
 */
async function runPlaybackQueue() {
  let anyFailed = false;
  for (let q = 0; q < state.workflowsToPlay.length; q++) {
    state.workflowToPlay = state.workflowsToPlay[q];
    if (state.mode !== "playing") break;
    const runStatus = await runSinglePlayback();
    // Stop the queue on first failure — subsequent workflows would be meaningless.
    if (runStatus === "failed") {
      anyFailed = true;
      break;
    }
  }
  
  if (state.mode === "playing") {
    state.mode = "idle";
    if (!anyFailed) {
      try {
        const [finalTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (finalTab) chrome.tabs.sendMessage(finalTab.id, { type: 'PLAYBACK_HUD_HIDE' }).catch(() => {});
      } catch (_) {}
      // Only tell the popup the queue finished cleanly when nothing failed.
      // WORKFLOW_PLAYBACK_FAILED was already broadcast for the failing workflow,
      // so the popup already knows — sending QUEUE_COMPLETE on top would overwrite
      // the error state with a false-success message.
      broadcastToPopup({ type: 'QUEUE_COMPLETE' });
    }
  }
}

/**
 * Replays a single recorded workflow's events.
 *
 * Strategy:
 * Iterates over the chronologically sorted event array. For each event, it updates the visual HUD on 
 * the active tab and dispatches the action via `dispatchPlaybackEvent`. It intentionally respects the 
 * recorded time deltas between events (capped at 3 seconds) to emulate human behavior and give SPAs 
 * enough time to resolve async state changes before the next click. Upon completion, uploads the 
 * run's telemetry to the dashboard.
 */
async function runSinglePlayback() {
  const workflow = state.workflowToPlay;
  if (!workflow) return "aborted";

  const events = workflow.events;
  const results = { checkpoints: {} };
  let runStatus = "passed";
  let failedStep = null;

  for (let i = 0; i < events.length; i++) {
    if (state.mode !== "playing") {
      runStatus = "aborted";
      break;
    }

    const event = events[i];
    const nextEvent = events[i + 1];

    broadcastToPopup({ type: "PLAYBACK_PROGRESS", index: i, total: events.length, event });

    const label = event.type === "checkpoint"
      ? `Screenshot: ${event.label}`
      : event.type === "console_checkpoint"
      ? `Console: ${event.label}`
      : event.type === "network_checkpoint"
      ? `Network: ${event.label}`
      : `Step ${i + 1}/${events.length}: ${event.type}${event.selector ? " — " + event.selector.slice(0, 40) : ""}`;

    try {
      const [hudTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (hudTab) {
        if (event.type === "tab_switch") {
          chrome.tabs.sendMessage(hudTab.id, { type: "PLAYBACK_HUD_HIDE" }).catch(() => {});
        } else {
          chrome.tabs.sendMessage(hudTab.id, {
            type: "PLAYBACK_HUD_UPDATE",
            label,
            progress: i + 1,
            total: events.length,
          }).catch(() => {});
        }
      }
    } catch (_) {}

    let dispatchResult = { ok: true };
    try {
      dispatchResult = await dispatchPlaybackEvent(event, results, {
        label,
        progress: i + 1,
        total: events.length
      });
    } catch (err) {
      dispatchResult = { ok: false, reason: "exception" };
      console.warn("Error dispatching playback event:", event.type, err);
    }

    if (!dispatchResult.ok) {
      runStatus = "failed";
      failedStep = {
        index: i,
        type: event.type,
        selector: event.selector || null,
        reason: dispatchResult.reason || "unknown",
      };
      broadcastToPopup({
        type: "WORKFLOW_PLAYBACK_FAILED",
        name: workflow.name || "workflow",
        failedStep,
      });

      try {
        const [hudTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (hudTab) {
          chrome.tabs.sendMessage(hudTab.id, {
            type: "PLAYBACK_HUD_FAIL",
            reason: `Action failed: ${dispatchResult.reason || "unknown error"}`
          }).catch(() => {});
        }
      } catch (_) {}

      break;
    }

    if (nextEvent && event.timestamp && nextEvent.timestamp) {
      const delta = Math.min(nextEvent.timestamp - event.timestamp, 3000);
      if (delta > 50) await sleep(delta);
    } else {
      await sleep(200);
    }
  }

  const playedAt = Date.now();
  const workflowName = workflow.name || "workflow";

  if (runStatus === "passed") {
    broadcastToPopup({ type: "WORKFLOW_PLAYBACK_COMPLETE", name: workflowName });
  }

  if (workflow._dashboardId && runStatus !== "aborted") {
    saveRunToDashboard(
      workflow._dashboardId,
      workflow.events || [],
      results.checkpoints,
      playedAt,
      runStatus,
      failedStep,
    ).catch(e => console.warn("[WFRec] Playback run save failed:", e));
  }

  return runStatus;
}

// ─── Dashboard sync helpers ───────────────────────────────────────────────────

/**
 * Saves a completed recording to the remote Dashboard.
 *
 * Strategy:
 * Packages the array of events and maps out screenshot data into a unified JSON blob, dispatching it to 
 * the `DASHBOARD_URL` via POST. It records the newly minted remote ID on the local workflow instance 
 * to correlate future playback runs to this master template.
 */
async function saveToDashboard(events, screenshots) {
  const name = state.workflowName || ('recorded-workflow-' + new Date().toISOString().slice(0, 16).replace('T', ' '));
  const screenshotMap = {};
  if (screenshots) {
    for (const [k, v] of Object.entries(screenshots)) {
      screenshotMap[k] = v;
    }
  }
  const res = await fetch(`${DASHBOARD_URL}/api/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, events, screenshots: screenshotMap }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (state.workflowToPlay) state.workflowToPlay._dashboardId = data.id;
  return data.id;
}

/**
 * Saves a completed playback run (execution) to the remote Dashboard.
 *
 * Strategy:
 * Bundles the checkpoints validated during the automated run and posts them against the `workflowId` 
 * to serve as proof-of-work/QA artifacts on the dashboard.
 */
async function saveRunToDashboard(workflowId, events, checkpointsByIndex, playedAt, status = 'passed', failedStep = null) {
  // Derive labels from the actual checkpoint events so the run reflects what was recorded.
  const checkpointEvents = (events || []).filter(e =>
    e.type === 'checkpoint' || e.type === 'console_checkpoint' || e.type === 'network_checkpoint'
  );
  const checkpoints = {};
  for (const [k, entry] of Object.entries(checkpointsByIndex || {})) {
    const cp = checkpointEvents[parseInt(k)];
    const checkpointType =
      entry?.checkpointType ||
      (cp?.type === "console_checkpoint" ? "console" :
      cp?.type === "network_checkpoint" ? "network" : "screenshot");
    checkpoints[k] = {
      dataUrl: entry?.dataUrl ?? null,
      label: entry?.label ?? cp?.label ?? `Checkpoint ${parseInt(k) + 1}`,
      checkpointType,
      capturedData: entry?.capturedData ?? null,
    };
  }
  const body = {
    workflowId,
    playedAt,
    checkpoints,
    status,
    failedEventIndex: failedStep?.index ?? null,
    failedEventType: failedStep?.type ?? null,
    failedEventSelector: failedStep?.selector ?? null,
  };
  const res = await fetch(`${DASHBOARD_URL}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.id;
}

/**
 * Routes individual playback events to the correct execution layer.
 *
 * Strategy:
 * Distinguishes between browser-level events (tabs switching, reloading) and page-level DOM events. 
 * Browser events invoke standard Chrome extension APIs. DOM events (clicks, inputs) inject `replayEventInPage` 
 * directly into the target tab's execution context. Checkpoint events halt playback briefly to snap and 
 * store a fresh screenshot before pinging the UI to flash.
 *
 * @param {Object} event - The single event to execute.
 * @param {Object} results - Accumulator for the session's generated metadata (screenshots).
 */
async function dispatchPlaybackEvent(event, results, meta) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  switch (event.type) {
    case "click":
    case "right_click":
    case "long_press":
    case "toggle":
    case "scroll":
    case "keydown":
    case "input":
    case "change": {
      if (!activeTab) return { ok: false, reason: "no_active_tab" };
      try {
        const injectionResults = await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: replayEventInPage,
          args: [event, state.playBufferMs || 8000],
        });
        const result = injectionResults?.[0]?.result;
        if (result && result.ok === false) {
          return { ok: false, reason: result.reason ?? "element_not_found" };
        }
      } catch (err) {
        return { ok: false, reason: "script_error" };
      }
      return { ok: true };
    }

    case "tab_switch":
      try {
        await handlePlaybackTabSwitch(event, meta);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err.message || "tab_switch_failed" };
      }

    case "reload":
      if (activeTab) {
        await chrome.tabs.reload(activeTab.id);
        await waitForTabLoad(activeTab.id);
        await sleep(800);
      }
      return { ok: true };

    case "checkpoint": {
      await sleep(300);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
          const idx = state.screenshotCount++;
          results.checkpoints[idx] = {
            label: event.label,
            checkpointType: "screenshot",
            dataUrl,
            capturedData: null,
          };
          state.screenshots[idx] = dataUrl;
          broadcastToPopup({
            type: "CHECKPOINT_REACHED",
            index: idx,
            label: event.label,
            screenshotDataUrl: dataUrl,
          });
          chrome.tabs.sendMessage(tab.id, { type: "PLAYBACK_CHECKPOINT_FLASH", label: event.label }).catch(() => {});
        } catch (err) {}
      }
      return { ok: true };
    }

    case "console_checkpoint": {
      const [cpTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!cpTab) return { ok: true }; // soft-pass if no tab

      // Notify HUD we are checking for this log.
      chrome.tabs.sendMessage(cpTab.id, {
        type: "PLAYBACK_WAITING_CHECKPOINT",
        checkpointType: "console",
        label: event.label,
        detail: event.logMessage,
      }).catch(() => {});

      let matchedEntry = null;
      try {
        // Strategy: First check the retroactive buffer (window.__wfPlayLogs) accumulated
        // since playback start. If the message was already logged by an earlier action,
        // we find it immediately instead of timing out waiting for a future event.
        const found = await chrome.scripting.executeScript({
          target: { tabId: cpTab.id },
          world: "MAIN",
          func: (targetMsg, timeoutMs) => {
            // 1. Retroactive check — did this log appear before this checkpoint step?
            const logs = window.__wfPlayLogs || [];
            const match = logs.find(e => e.message && e.message.includes(targetMsg));
            if (match) return match;

            // 2. Live watcher — wait for a future matching event (short window).
            return new Promise((resolve) => {
              const timer = setTimeout(() => {
                window.removeEventListener("__wf_log_capture__", handler);
                resolve(null);
              }, timeoutMs);
              function handler(ev) {
                if (ev.detail && ev.detail.message && ev.detail.message.includes(targetMsg)) {
                  clearTimeout(timer);
                  window.removeEventListener("__wf_log_capture__", handler);
                  resolve(ev.detail);
                }
              }
              window.addEventListener("__wf_log_capture__", handler);
            });
          },
          args: [event.logMessage, Math.min(state.playBufferMs || 8000, 5000)],
        });

        matchedEntry = found?.[0]?.result || null;
        if (!matchedEntry) {
          console.warn("[WFPlay] console_checkpoint not matched:", event.logMessage);
          // Soft-pass: do not fail the workflow for a missed log checkpoint —
          // take the screenshot anyway so the run has some evidence.
        }
      } catch (err) {
        console.warn("[WFPlay] console_checkpoint error:", err);
      }

      // Capture screenshot as evidence regardless of match result.
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(cpTab.windowId, { format: "png" });
        const idx = state.screenshotCount++;
        results.checkpoints[idx] = {
          label: event.label,
          checkpointType: "console",
          dataUrl,
          capturedData: JSON.stringify({
            matched: !!matchedEntry,
            expectedMessage: event.logMessage ?? null,
            capturedMessage: matchedEntry?.message ?? null,
            capturedLevel: matchedEntry?.level ?? null,
            capturedUrl: matchedEntry?.url ?? null,
            capturedTimestamp: matchedEntry?.timestamp ?? null,
          }),
        };
        state.screenshots[idx] = dataUrl;
        broadcastToPopup({ type: "CHECKPOINT_REACHED", index: idx, label: event.label, screenshotDataUrl: dataUrl });
        chrome.tabs.sendMessage(cpTab.id, { type: "PLAYBACK_CHECKPOINT_FLASH", label: event.label }).catch(() => {});
      } catch (_) {}

      return { ok: true };
    }

    case "network_checkpoint": {
      const [netTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!netTab) return { ok: true };

      // Notify HUD we are checking for this network call.
      chrome.tabs.sendMessage(netTab.id, {
        type: "PLAYBACK_WAITING_CHECKPOINT",
        checkpointType: "network",
        label: event.label,
        detail: `${event.networkMethod} ${event.networkUrl}`,
      }).catch(() => {});

      let matchedCall = null;
      try {
        // Strategy: First check window.__wfPlayNet for calls already captured before
        // this checkpoint step. Only arm a live watcher if not yet found.
        const found = await chrome.scripting.executeScript({
          target: { tabId: netTab.id },
          world: "MAIN",
          func: (targetUrl, targetMethod, timeoutMs) => {
            // 1. Retroactive check
            const calls = window.__wfPlayNet || [];
            const past = calls.find(c =>
              c.url && c.url.includes(targetUrl) &&
              (!targetMethod || c.method === targetMethod)
            );
            if (past) return past;

            // 2. Live watcher
            return new Promise((resolve) => {
              const timer = setTimeout(() => {
                window.removeEventListener("__wf_net_capture__", handler);
                resolve(null);
              }, timeoutMs);
              function handler(ev) {
                const c = ev.detail;
                if (c && c.url && c.url.includes(targetUrl) &&
                    (!targetMethod || c.method === targetMethod)) {
                  clearTimeout(timer);
                  window.removeEventListener("__wf_net_capture__", handler);
                  resolve(c);
                }
              }
              window.addEventListener("__wf_net_capture__", handler);
            });
          },
          args: [event.networkUrl, event.networkMethod, Math.min(state.playBufferMs || 8000, 5000)],
        });
        matchedCall = found?.[0]?.result || null;
        if (!matchedCall) {
          console.warn("[WFPlay] network_checkpoint not matched:", event.networkMethod, event.networkUrl);
        }
      } catch (err) {
        console.warn("[WFPlay] network_checkpoint error:", err);
      }

      // Capture screenshot as evidence.
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(netTab.windowId, { format: "png" });
        const idx = state.screenshotCount++;
        results.checkpoints[idx] = {
          label: event.label,
          checkpointType: "network",
          dataUrl,
          capturedData: JSON.stringify({
            matched: !!matchedCall,
            expectedUrl: event.networkUrl ?? null,
            expectedMethod: event.networkMethod ?? null,
            expectedStatus: event.networkStatus ?? null,
            capturedUrl: matchedCall?.url ?? null,
            capturedMethod: matchedCall?.method ?? null,
            capturedStatus: matchedCall?.status ?? null,
            capturedStatusText: matchedCall?.statusText ?? null,
            requestHeaders: matchedCall?.requestHeaders ?? null,
            responseHeaders: matchedCall?.responseHeaders ?? null,
            requestBody: matchedCall?.requestBody ?? null,
            responseBody: matchedCall?.responseBody ?? null,
            capturedTimestamp: matchedCall?.timestamp ?? null,
          }),
        };
        state.screenshots[idx] = dataUrl;
        broadcastToPopup({ type: "CHECKPOINT_REACHED", index: idx, label: event.label, screenshotDataUrl: dataUrl });
        chrome.tabs.sendMessage(netTab.id, { type: "PLAYBACK_CHECKPOINT_FLASH", label: event.label }).catch(() => {});
      } catch (_) {}

      return { ok: true };
    }

    default:
      return { ok: true };
  }
}

/**
 * Handles cross-tab navigation during playback.
 *
 * Strategy:
 * Checks all open tabs to find if a tab matching the target URL already exists. If yes, it activates 
 * that tab. If no, it opens a new tab. It then strictly blocks playback via `waitForTabLoad` until 
 * the new/switched tab reports `status === "complete"`, preventing race conditions where events trigger 
 * on an empty DOM.
 */
async function handlePlaybackTabSwitch(event, meta) {
  if (!event.url) throw new Error("No URL provided for tab_switch");

  const tabs = await chrome.tabs.query({});
  let targetTabId;
  const match = tabs.find(t => t.url && t.url.startsWith(event.url.split("?")[0]));

  if (match) {
    await chrome.tabs.update(match.id, { active: true });
    if (match.windowId) {
      await chrome.windows.update(match.windowId, { focused: true });
    }
    targetTabId = match.id;
  } else {
    const newTab = await chrome.tabs.create({ url: event.url });
    targetTabId = newTab.id;
  }

  const tabInfo = await chrome.tabs.get(targetTabId);
  if (tabInfo && tabInfo.status !== "complete") {
    await waitForTabLoad(targetTabId);
  }
  await sleep(800);

  // Inject player.js dynamically into the newly switched tab to ensure the HUD renders
  try {
    await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      files: ["content/player.js"]
    });
    if (meta) {
      chrome.tabs.sendMessage(targetTabId, {
        type: "PLAYBACK_HUD_UPDATE",
        label: meta.label,
        progress: meta.progress,
        total: meta.total,
      }).catch(() => {});
    }
  } catch (e) {
    console.warn("Could not inject player.js after tab switch:", e);
  }

  // Re-inject the capture accumulator into MAIN world so it continues buffering
  // console logs and network calls after the navigation.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      files: ["content/playback-capture.js"],
      world: "MAIN",
    });
  } catch (_) {}
}

/**
 * Blocks execution until a target tab finishes loading.
 *
 * Strategy:
 * Returns a Promise that resolves when `chrome.tabs.onUpdated` signals the tab is 'complete'. Applies a 
 * hard 10-second timeout guarantee to ensure the queue doesn't lock permanently if a site hangs.
 *
 * @param {number} tabId - Target tab identifier.
 */
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    let timeoutId;
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeoutId);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 10000);
  });
}

/**
 * Sets playback mode to idle and notifies the popup (helper for a minimal stop response).
 *
 * Strategy:
 * The main `STOP_PLAYBACK` branch in the message listener performs fuller cleanup; this
 * function matches a narrow stop contract (mode + popup broadcast + `sendResponse`).
 */
function handleStopPlayback(sendResponse) {
  state.mode = "idle";
  broadcastToPopup({ type: "PLAYBACK_STOPPED" });
  sendResponse({ ok: true });
}

// ─── Export ───────────────────────────────────────────────────────────────────

/**
 * Returns the in-memory recording as a serializable workflow payload for download.
 *
 * Strategy:
 * Builds a plain object with name, timestamp, events, and screenshot count, then responds
 * with the parallel `screenshots` map for the popup to package as JSON.
 */
async function handleExportWorkflow(sendResponse) {
  const workflow = {
    name: state.workflowName || ("recorded-workflow-" + Date.now()),
    recordedAt: Date.now(),
    events: state.events,
    screenshotCount: state.screenshotCount,
  };
  sendResponse({ ok: true, workflow, screenshots: state.screenshots });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Clears all mutable session fields before a new recording or after discarding state.
 *
 * Strategy:
 * Resets arrays, maps, counters, and playback pointers while leaving `mode` to callers.
 */
function resetState() {
  state.events = [];
  state.screenshots = {};
  state.screenshotCount = 0;
  state.consoleLogs = [];
  state.networkCalls = [];
  state.playbackIndex = 0;
  state.playbackTabId = null;
  state.workflowToPlay = null;
  state.recordingTabId = null;
  state.workflowName = "";
}

/**
 * Promise-based delay helper for playback pacing and post-navigation waits.
 *
 * Strategy:
 * Wraps `setTimeout` in a Promise for use with `await` in async playback loops.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sends a one-way message to the extension popup if it is open.
 *
 * Strategy:
 * Uses `chrome.runtime.sendMessage` and swallows errors when no receiver exists.
 */
async function broadcastToPopup(msg) {
  try {
    await chrome.runtime.sendMessage(msg);
  } catch (_) {}
}

/**
 * Injected into page context during playback to replay DOM events.
 *
 * Strategy:
 * Operates completely hermetically — it receives its arguments serialized as JSON by the chrome API 
 * and cannot rely on SW scope. For clicks, it dispatches the complete `mousedown -> mouseup -> click` 
 * triplet to fool thick client frameworks (React/Angular) into triggering their synthetic event handlers. 
 * For inputs, it utilizes native property descriptors `Object.getOwnPropertyDescriptor().set` to bypass 
 * framework value hijackers, directly mutating the DOM node and explicitly raising `input` and `change` 
 * events to force state binding updates.
 *
 * @param {Object} event - The serialized playback instruction object.
 */
async function replayEventInPage(event, timeoutMs = 8000) {
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  // Interactive event types that require a target element to succeed.
  const interactiveTypes = ["click", "right_click", "long_press", "toggle", "input", "change", "keydown"];

  // Use the CSS selector as the authoritative element signal.
  // elementFromPoint() is intentionally NOT used as a selector fallback — it always
  // returns the topmost element at those pixel coordinates (body, container, overlay)
  // even when the intended target is absent, producing silent false-positives that
  // mark runs as "passed" even though nothing was actually clicked.
  //
  // When a selector is recorded but fails after the full timeout, a relaxed version
  // is tried by stripping positional :nth-of-type() qualifiers (common cause of
  // breakage in AngularJS ng-repeat lists after re-renders). If multiple candidates
  // match the relaxed selector, the one whose centre is closest to the recorded
  // x/y coordinates is chosen.
  let resolvedEl = null;

  if (interactiveTypes.includes(event.type)) {
    if (event.selector) {
      let isWaiting = false;
      const startTime = Date.now();

      // Phase 1 — wait for the exact recorded selector.
      // Uses querySelectorAll so that when multiple elements match (e.g. a selector
      // without nth-of-type), the one whose centre is closest to the recorded
      // click coordinates is chosen rather than blindly taking the first DOM match.
      while (Date.now() - startTime < timeoutMs) {
        try {
          const matches = Array.from(document.querySelectorAll(event.selector));
          if (matches.length === 1) {
            resolvedEl = matches[0];
            break;
          } else if (matches.length > 1) {
            if (event.x !== undefined && event.y !== undefined) {
              resolvedEl = matches.reduce((best, c) => {
                const r = c.getBoundingClientRect();
                const dist = Math.hypot(r.left + r.width / 2 - event.x, r.top + r.height / 2 - event.y);
                const rb = best.getBoundingClientRect();
                return dist < Math.hypot(rb.left + rb.width / 2 - event.x, rb.top + rb.height / 2 - event.y) ? c : best;
              });
            } else {
              resolvedEl = matches[0];
            }
            break;
          }
        } catch (_) {}

        isWaiting = true;
        const stepEl = document.getElementById("__wf_hud_step__");
        if (stepEl) {
          if (!stepEl.dataset.originalText) stepEl.dataset.originalText = stepEl.textContent;
          const remaining = Math.ceil((timeoutMs - (Date.now() - startTime)) / 1000);
          stepEl.textContent = `Waiting for element... (${remaining}s)`;
        }
        await wait(250);
      }

      if (isWaiting) {
        const stepEl = document.getElementById("__wf_hud_step__");
        if (stepEl && stepEl.dataset.originalText) stepEl.textContent = stepEl.dataset.originalText;
      }

      // Phase 2 — if the exact selector timed out, try a relaxed version that
      // strips :nth-of-type() qualifiers. This recovers from ng-repeat / v-for
      // re-renders where the element class is stable but its list position changed.
      if (!resolvedEl) {
        const relaxed = event.selector.replace(/:nth-of-type\(\d+\)/g, "");
        if (relaxed !== event.selector) {
          try {
            const stepEl = document.getElementById("__wf_hud_step__");
            if (stepEl) stepEl.textContent = "Trying relaxed selector\u2026";

            const candidates = Array.from(document.querySelectorAll(relaxed));
            if (candidates.length === 1) {
              resolvedEl = candidates[0];
            } else if (candidates.length > 1 && event.x !== undefined && event.y !== undefined) {
              // Pick the candidate whose centre is closest to the recorded click point.
              resolvedEl = candidates.reduce((best, c) => {
                const r = c.getBoundingClientRect();
                const cx = r.left + r.width / 2;
                const cy = r.top + r.height / 2;
                const dist = Math.hypot(cx - event.x, cy - event.y);
                const rb = best.getBoundingClientRect();
                const bx = rb.left + rb.width / 2;
                const by = rb.top + rb.height / 2;
                return dist < Math.hypot(bx - event.x, by - event.y) ? c : best;
              });
            }
          } catch (_) {}
        }
      }

      // Phase 3 — last-resort coordinate hit-test.
      // Only reached when both Phase 1 (exact selector) and Phase 2 (relaxed selector)
      // produced zero DOM candidates. elementFromPoint() is used deliberately here:
      // a coordinate hit is strictly better than an immediate hard failure.
      //
      // Two pitfalls handled explicitly:
      //  a) The player HUD is fixed to the viewport and can sit on top of the target
      //     coordinates, causing elementFromPoint to return a HUD element instead of
      //     the page element. The HUD is temporarily hidden for the hit-test.
      //  b) pageX/pageY (scroll-adjusted) are used so the target is always addressed
      //     in document space. If the target is currently scrolled off-screen the page
      //     is scrolled to bring it into the viewport before the hit-test.
      if (!resolvedEl && event.x !== undefined && event.y !== undefined &&
          (event.type === "click" || event.type === "right_click")) {
        try {
          const stepEl = document.getElementById("__wf_hud_step__");
          if (stepEl) stepEl.textContent = "Trying coordinates\u2026";

          // Hide extension overlays so they don't intercept the hit-test.
          const hud    = document.getElementById("__workflow_player_hud__");
          const recInd = document.getElementById("__workflow_rec_indicator__");
          const prevHudPE    = hud?.style.pointerEvents;
          const prevRecIndPE = recInd?.style.pointerEvents;
          if (hud)    hud.style.pointerEvents    = "none";
          if (recInd) recInd.style.pointerEvents = "none";

          // Prefer page-space coordinates so scroll position at playback time
          // doesn't affect the result. Fall back to client coords if not recorded.
          const pageX = event.pageX !== undefined ? event.pageX : event.x;
          const pageY = event.pageY !== undefined ? event.pageY : event.y;
          let vpX = pageX - window.scrollX;
          let vpY = pageY - window.scrollY;

          // If the target is outside the current viewport, scroll it into view first.
          if (vpY < 0 || vpY > window.innerHeight || vpX < 0 || vpX > window.innerWidth) {
            window.scrollTo(
              Math.max(0, pageX - window.innerWidth  / 2),
              Math.max(0, pageY - window.innerHeight / 2)
            );
            await wait(100);
            vpX = pageX - window.scrollX;
            vpY = pageY - window.scrollY;
          }

          const hit = document.elementFromPoint(vpX, vpY);

          // Restore overlays.
          if (hud)    hud.style.pointerEvents    = prevHudPE    ?? "";
          if (recInd) recInd.style.pointerEvents = prevRecIndPE ?? "";

          if (hit && hit !== document.body && hit !== document.documentElement) {
            // Walk up to the element the selector targets (not a child dot/span).
            // e.g. "p.billingtext5:nth-of-type(4)" → leaf "p.billingtext5"
            const leafRaw = event.selector.split(/\s*>\s*/).pop() || "";
            const leafSel = leafRaw.replace(/:nth-of-type\(\d+\)/g, "").trim();
            let candidate = hit;
            if (leafSel) {
              try { candidate = hit.closest(leafSel) || hit; } catch (_) {}
            }
            resolvedEl = candidate;
          }
        } catch (_) {}
      }

      if (!resolvedEl) return { ok: false, reason: "element_not_found" };
    }
    // No selector recorded → fall through; resolvedEl stays null and the
    // coordinate path below handles it.
  }

  // Element resolution for the actual event dispatch.
  // Coordinates are only used when no selector was recorded at all.
  function getElement(selector, x, y) {
    if (resolvedEl) return resolvedEl;
    if (selector) {
      try {
        const el = document.querySelector(selector);
        if (el) return el;
      } catch (_) {}
    }
    if (x !== undefined && y !== undefined) {
      return document.elementFromPoint(x, y);
    }
    return null;
  }

  const el = getElement(event.selector, event.x, event.y);

  // Guard: no element resolved by any strategy → genuine missing element.
  if (interactiveTypes.includes(event.type) && !el) {
    return { ok: false, reason: "element_not_found" };
  }

  if (event.type === "click") {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y }));
    el.focus?.();
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y }));

    const isCheckbox = el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio");
    if (isCheckbox) {
      const nativeCheckedSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "checked"
      )?.set;
      if (nativeCheckedSetter) {
        nativeCheckedSetter.call(el, el.type === "radio" ? true : !el.checked);
      } else {
        el.checked = el.type === "radio" ? true : !el.checked;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  } else if (event.type === "right_click") {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y, button: 2 }));
    el.focus?.();
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y, button: 2 }));
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y, button: 2 }));
  } else if (event.type === "long_press") {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y, button: 0 }));
    el.focus?.();
    await new Promise(r => setTimeout(r, 600));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y, button: 0 }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y, button: 0 }));
  } else if (event.type === "toggle") {
    if (el.tagName === "DETAILS") {
      el.open = event.isOpen !== undefined ? event.isOpen : !el.open;
      el.dispatchEvent(new Event("toggle", { bubbles: true }));
    } else {
      el.dispatchEvent(new Event("toggle", { bubbles: true }));
    }
  } else if (event.type === "scroll") {
    const target = el || window;
    if (target === window) {
      window.scrollTo({ left: event.scrollX, top: event.scrollY, behavior: "instant" });
    } else {
      target.scrollTop = event.scrollY;
      target.scrollLeft = event.scrollX;
    }
  } else if (event.type === "keydown") {
    const target = el || document.activeElement;
    if (target) {
      target.dispatchEvent(new KeyboardEvent("keydown", {
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        bubbles: true,
        cancelable: true,
      }));
      target.dispatchEvent(new KeyboardEvent("keyup", {
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        bubbles: true,
        cancelable: true,
      }));
    }
  } else if (event.type === "input" || event.type === "change") {
    if (typeof event.value === "boolean" || (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio"))) {
      const nativeCheckedSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "checked"
      )?.set;
      const newChecked = typeof event.value === "boolean" ? event.value : !el.checked;
      if (nativeCheckedSetter) {
        nativeCheckedSetter.call(el, newChecked);
      } else {
        el.checked = newChecked;
      }
    } else if ("value" in el) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, event.value);
      } else {
        el.value = event.value;
      }
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  return { ok: true };
}

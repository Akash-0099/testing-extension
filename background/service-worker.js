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

    case "ADD_CHECKPOINT":
      handleAddCheckpoint(msg.label, sendResponse);
      return true;

    case "START_PLAYBACK":
      handleStartPlayback(msg.workflows, sendResponse);
      return true;

    case "STOP_PLAYBACK":
      state.mode = "idle";
      state.workflowsToPlay = [];
      state.workflowToPlay = null;
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

  sendResponse({ ok: true, events: state.events, screenshots: state.screenshots });

  // Auto-save to dashboard (fire-and-forget)
  saveToDashboard(state.events, state.screenshots).catch(e => console.warn('[WFRec] Dashboard save failed:', e));
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
 */
async function deactivateRecorderOnAllTabs() {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  await Promise.allSettled(tabs.map(tab => activateTabRecorder(tab.id, "stop")));
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
      files: ["content/recorder.js"],
    });
  } catch (err) {
    return;
  }

  await new Promise(r => setTimeout(r, 100));

  const msgType = action === "start" ? "RECORDER_START" : "RECORDER_STOP";
  try {
    await chrome.tabs.sendMessage(tabId, { type: msgType });
  } catch (err) {
    // Expected on restricted pages
  }
}

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

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.playbackTabId = tab?.id ?? null;

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
  for (let q = 0; q < state.workflowsToPlay.length; q++) {
    state.workflowToPlay = state.workflowsToPlay[q];
    if (state.mode !== "playing") break;
    await runSinglePlayback();
  }
  
  if (state.mode === "playing") {
    state.mode = "idle";
    try {
      const [finalTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (finalTab) chrome.tabs.sendMessage(finalTab.id, { type: 'PLAYBACK_HUD_HIDE' }).catch(() => {});
    } catch (_) {}
    broadcastToPopup({ type: 'QUEUE_COMPLETE' });
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
  const events = state.workflowToPlay.events;
  const results = { screenshots: {} };

  for (let i = 0; i < events.length; i++) {
    if (state.mode !== "playing") break;

    const event = events[i];
    const nextEvent = events[i + 1];

    broadcastToPopup({ type: "PLAYBACK_PROGRESS", index: i, total: events.length, event });

    try {
      const [hudTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (hudTab) {
        const label = event.type === "checkpoint"
          ? `📸 ${event.label}`
          : `Step ${i + 1}/${events.length}: ${event.type}${event.selector ? " — " + event.selector.slice(0, 40) : ""}`;
        chrome.tabs.sendMessage(hudTab.id, {
          type: "PLAYBACK_HUD_UPDATE",
          label,
          progress: i + 1,
          total: events.length,
        }).catch(() => {});
      }
    } catch (_) {}

    try {
      await dispatchPlaybackEvent(event, results);
    } catch (err) {
      console.warn("Error dispatching playback event:", event.type, err);
    }

    if (nextEvent && event.timestamp && nextEvent.timestamp) {
      const delta = Math.min(nextEvent.timestamp - event.timestamp, 3000);
      if (delta > 50) await sleep(delta);
    } else {
      await sleep(200);
    }
  }

  if (state.mode === 'playing') {
    const exportData = {
      events: state.workflowToPlay.events,
      screenshots: results.screenshots,
      name: state.workflowToPlay.name || 'workflow',
      playedAt: Date.now(),
    };
    
    broadcastToPopup({ type: 'WORKFLOW_PLAYBACK_COMPLETE', name: exportData.name });

    if (state.workflowToPlay._dashboardId) {
      saveRunToDashboard(state.workflowToPlay._dashboardId, results.screenshots, exportData.playedAt)
        .catch(e => console.warn('[WFRec] Playback run save failed:', e));
    }
  }
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
  const name = 'recorded-workflow-' + new Date().toISOString().slice(0, 16).replace('T', ' ');
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
async function saveRunToDashboard(workflowId, screenshots, playedAt) {
  const checkpoints = {};
  for (const [k, v] of Object.entries(screenshots || {})) {
    checkpoints[k] = { dataUrl: v, label: `Checkpoint ${parseInt(k) + 1}` };
  }
  const res = await fetch(`${DASHBOARD_URL}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflowId, playedAt, checkpoints }),
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
async function dispatchPlaybackEvent(event, results) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  switch (event.type) {
    case "click":
    case "right_click":
    case "long_press":
    case "toggle":
    case "scroll":
    case "keydown":
    case "input":
    case "change":
      if (!activeTab) break;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: replayEventInPage,
          args: [event],
        });
      } catch (err) {}
      break;

    case "tab_switch":
      await handlePlaybackTabSwitch(event);
      break;

    case "reload":
      if (activeTab) {
        await chrome.tabs.reload(activeTab.id);
        await waitForTabLoad(activeTab.id);
        await sleep(800);
      }
      break;

    case "checkpoint": {
      await sleep(300);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
          const idx = state.screenshotCount++;
          results.screenshots[idx] = dataUrl;
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
      break;
    }

    default:
      break;
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
async function handlePlaybackTabSwitch(event) {
  if (!event.url) return;

  try {
    const tabs = await chrome.tabs.query({});
    let targetTabId;
    const match = tabs.find(t => t.url && t.url.startsWith(event.url.split("?")[0]));

    if (match) {
      await chrome.tabs.update(match.id, { active: true });
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
  } catch (err) {}
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

function handleStopPlayback(sendResponse) {
  state.mode = "idle";
  broadcastToPopup({ type: "PLAYBACK_STOPPED" });
  sendResponse({ ok: true });
}

// ─── Export ───────────────────────────────────────────────────────────────────

async function handleExportWorkflow(sendResponse) {
  const workflow = {
    name: "recorded-workflow-" + Date.now(),
    recordedAt: Date.now(),
    events: state.events,
    screenshotCount: state.screenshotCount,
  };
  sendResponse({ ok: true, workflow, screenshots: state.screenshots });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resetState() {
  state.events = [];
  state.screenshots = {};
  state.screenshotCount = 0;
  state.playbackIndex = 0;
  state.playbackTabId = null;
  state.workflowToPlay = null;
  state.recordingTabId = null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
async function replayEventInPage(event) {
  function getElement(selector, x, y) {
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

  if (event.type === "click") {
    if (el) {
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
    }
  } else if (event.type === "right_click") {
    if (el) {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y, button: 2 }));
      el.focus?.();
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y, button: 2 }));
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y, button: 2 }));
    }
  } else if (event.type === "long_press") {
    if (el) {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y, button: 0 }));
      el.focus?.();
      await new Promise(r => setTimeout(r, 600));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y, button: 0 }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y, button: 0 }));
    }
  } else if (event.type === "toggle") {
    if (el) {
       if (el.tagName === "DETAILS") {
         el.open = event.isOpen !== undefined ? event.isOpen : !el.open;
         el.dispatchEvent(new Event("toggle", { bubbles: true }));
       } else {
         el.dispatchEvent(new Event("toggle", { bubbles: true }));
       }
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
    if (el) {
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
  }
}

/**
 * Popup script — manages idle / recording / playing UI states and
 * communicates with the service worker.
 */

// Dashboard URL — keep in sync with service-worker.js
const DASHBOARD_URL = 'http://localhost:3000';

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const statusBadge       = document.getElementById("statusBadge");

// Panels
const panelIdle         = document.getElementById("panelIdle");
const panelRecording    = document.getElementById("panelRecording");
const panelPlaying      = document.getElementById("panelPlaying");

// Idle
const workflowName      = document.getElementById("workflowName");
const btnRecord         = document.getElementById("btnRecord");
const btnOpenDashboard  = document.getElementById("btnOpenDashboard");
const loadedWorkflowName = document.getElementById("loadedWorkflowName");
const btnPlay           = document.getElementById("btnPlay");

// Load source tabs
const tabFromFile       = document.getElementById("tabFromFile");
const tabFromDashboard  = document.getElementById("tabFromDashboard");
const paneFromFile      = document.getElementById("paneFromFile");
const paneFromDashboard = document.getElementById("paneFromDashboard");
const btnLoadLabel      = document.getElementById("btnLoadLabel");
const fileInput         = document.getElementById("fileInput");

// Dashboard load
const workflowSelect      = document.getElementById("workflowSelect");
const btnRefreshWorkflows = document.getElementById("btnRefreshWorkflows");
const dbLoadStatus        = document.getElementById("dbLoadStatus");
const btnAddQueueDb       = document.getElementById("btnAddQueueDb");

// Queue
const queueContainer      = document.getElementById("queueContainer");
const queueCount          = document.getElementById("queueCount");
const queueList           = document.getElementById("queueList");

// Recording
const recEventCount     = document.getElementById("recEventCount");
const recCheckpointCount = document.getElementById("recCheckpointCount");
const recDuration       = document.getElementById("recDuration");
const checkpointLabel   = document.getElementById("checkpointLabel");
const btnCheckpoint     = document.getElementById("btnCheckpoint");
const btnStopRecording  = document.getElementById("btnStopRecording");
const checkpointThumbsRec = document.getElementById("checkpointThumbsRec");

// Playing
const playProgressBar   = document.getElementById("playProgressBar");
const playProgressText  = document.getElementById("playProgressText");
const playCurrentEvent  = document.getElementById("playCurrentEvent");
const btnStopPlayback   = document.getElementById("btnStopPlayback");
const checkpointThumbsPlay = document.getElementById("checkpointThumbsPlay");
const noCheckpointsYet  = document.getElementById("noCheckpointsYet");

// Toast
const toast             = document.getElementById("toast");

// ─── Local state ──────────────────────────────────────────────────────────────

let recordingStartTime  = 0;
let durationTimer       = null;

// Playing state
let workflowQueue       = [];     // array of parsed workflow JSONs to play sequentially
let playScreenshots     = {};     // currently playing workflow's screenshots

// ─── Init: sync state from service worker ────────────────────────────────────

async function init() {
  const res = await sendToSW({ type: "GET_STATE" });
  if (!res) return;

  if (res.mode === "recording") {
    showPanel("recording");
    recEventCount.textContent = res.eventCount ?? 0;
    startDurationTimer();
  } else if (res.mode === "playing") {
    showPanel("playing");
  } else {
    showPanel("idle");
  }
}

init();

// ─── Panel switching ──────────────────────────────────────────────────────────

function showPanel(mode) {
  panelIdle.classList.toggle("hidden", mode !== "idle");
  panelRecording.classList.toggle("hidden", mode !== "recording");
  panelPlaying.classList.toggle("hidden", mode !== "playing");

  statusBadge.textContent = mode === "idle" ? "Idle" : mode === "recording" ? "Recording" : "Playing";
  statusBadge.className = "status-badge " + (mode !== "idle" ? mode : "");
}

// ─── Recording ────────────────────────────────────────────────────────────────

btnRecord.addEventListener("click", async () => {
  const name = workflowName.value.trim();

  // Resolve the active tab NOW while the popup window is open —
  // the SW cannot reliably resolve currentWindow from its own context.
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const res = await sendToSW({ type: "START_RECORDING", name, tabId: activeTab?.id ?? null });
  if (res?.ok) {
    recEventCount.textContent = "0";
    recCheckpointCount.textContent = "0";
    recDuration.textContent = "0s";
    checkpointThumbsRec.innerHTML = "";
    checkpointLabel.value = "";
    recordingStartTime = Date.now();
    startDurationTimer();
    showPanel("recording");
  } else {
    showToast("Could not start recording: " + (res?.error ?? "unknown"), "error");
  }
});

function startDurationTimer() {
  if (!recordingStartTime) recordingStartTime = Date.now();
  clearInterval(durationTimer);
  durationTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    recDuration.textContent = m > 0 ? `${m}m ${s}s` : `${s}s`;
  }, 1000);
}

btnCheckpoint.addEventListener("click", async () => {
  const label = checkpointLabel.value.trim() || null;
  btnCheckpoint.disabled = true;
  const res = await sendToSW({ type: "ADD_CHECKPOINT", label });
  btnCheckpoint.disabled = false;

  if (res?.ok) {
    checkpointLabel.value = "";
    // Thumbnail is added via the CHECKPOINT_ADDED runtime message below
  } else {
    showToast("Checkpoint failed: " + (res?.error ?? "unknown"), "error");
  }
});

btnStopRecording.addEventListener("click", async () => {
  clearInterval(durationTimer);
  btnStopRecording.disabled = true;

  const stopRes = await sendToSW({ type: "STOP_RECORDING" });
  btnStopRecording.disabled = false;

  if (!stopRes?.ok) {
    showToast("Stop failed: " + (stopRes?.error ?? "unknown"), "error");
    return;
  }

  // Service worker automatically calls saveToDashboard — just notify the user.
  showToast("✅ Workflow saved to Dashboard!", "success");
  showPanel("idle");
});

// ─── Load source tabs ────────────────────────────────────────────────────────

let dashboardWorkflowsFetched = false;

function switchLoadTab(tab) {
  const isFile = tab === 'file';
  tabFromFile.classList.toggle('active', isFile);
  tabFromDashboard.classList.toggle('active', !isFile);
  paneFromFile.classList.toggle('hidden', !isFile);
  paneFromDashboard.classList.toggle('hidden', isFile);
  if (!isFile && !dashboardWorkflowsFetched) {
    dashboardWorkflowsFetched = true;
    fetchDashboardWorkflows();
  }
}

tabFromFile.addEventListener('click', () => switchLoadTab('file'));
tabFromDashboard.addEventListener('click', () => switchLoadTab('dashboard'));

async function fetchDashboardWorkflows() {
  dbLoadStatus.textContent = 'Loading…';
  dbLoadStatus.className = 'db-status';
  workflowSelect.disabled = true;
  // Clear old options except placeholder
  workflowSelect.options.length = 1;

  try {
    const res = await fetch(`${DASHBOARD_URL}/api/workflows`, {
      headers: { 'X-Extension': 'true' },
    });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const workflows = await res.json();
    if (!Array.isArray(workflows) || workflows.length === 0) {
      dbLoadStatus.textContent = 'No workflows saved to dashboard yet.';
      return;
    }
    
    // Clear old options here to prevent duplicate appends on concurrent fetches
    workflowSelect.options.length = 1;

    for (const wf of workflows) {
      const opt = document.createElement('option');
      opt.value = wf.id;
      
      let name = wf.name || 'Workflow';
      // If it's a default generated name, replace 'recorded-workflow-' with 'Run '
      if (name.startsWith('recorded-workflow-')) {
        name = name.replace('recorded-workflow-', 'Run ');
      } else if (name.length > 25) {
        // Safe truncate for manually long names
        name = name.slice(0, 23) + '…';
      }
      
      const d = new Date(wf.recordedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      opt.textContent = `${name} (${d})`;
      workflowSelect.appendChild(opt);
    }
    dbLoadStatus.textContent = `${workflows.length} workflow${workflows.length === 1 ? '' : 's'} found`;
  } catch (err) {
    dbLoadStatus.textContent = `Error: ${err.message}`;
    dbLoadStatus.className = 'db-status error';
    dashboardWorkflowsFetched = false;
  } finally {
    workflowSelect.disabled = false;
  }
}

btnRefreshWorkflows.addEventListener('click', () => {
  workflowSelect.options.length = 1; // Clear UI immediately for feedback
  dashboardWorkflowsFetched = true;
  fetchDashboardWorkflows();
});

workflowSelect.addEventListener('change', () => {
  btnAddQueueDb.disabled = !workflowSelect.value;
});

btnAddQueueDb.addEventListener('click', async () => {
  const id = workflowSelect.value;
  if (!id) return;

  dbLoadStatus.textContent = 'Adding to queue…';
  btnAddQueueDb.disabled = true;
  workflowSelect.disabled = true;

  try {
    const res = await fetch(`${DASHBOARD_URL}/api/workflows/${id}`, {
      headers: { 'X-Extension': 'true' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const wf = await res.json();
    if (!Array.isArray(wf.events)) throw new Error('Workflow has no events');
    
    workflowQueue.push({ id: wf.id, _dashboardId: wf.id, name: wf.name, recordedAt: wf.recordedAt, events: wf.events });
    renderQueue();
    
    dbLoadStatus.textContent = `Added: ${wf.name}`;
    dbLoadStatus.className = 'db-status';
  } catch (err) {
    dbLoadStatus.textContent = `Failed to load: ${err.message}`;
    dbLoadStatus.className = 'db-status error';
  } finally {
    btnAddQueueDb.disabled = false;
    workflowSelect.disabled = false;
    workflowSelect.value = ''; // Reset UI
  }
});

function renderQueue() {
  queueList.innerHTML = '';
  if (workflowQueue.length === 0) {
    queueContainer.classList.add('hidden');
    btnPlay.disabled = true;
    btnPlay.innerHTML = '<span class="btn-icon">▶</span> Play Queue';
    return;
  }
  
  queueContainer.classList.remove('hidden');
  queueCount.textContent = workflowQueue.length;
  btnPlay.disabled = false;
  btnPlay.innerHTML = `<span class="btn-icon">▶</span> Play Queue (${workflowQueue.length})`;

  workflowQueue.forEach((wf, i) => {
    const item = document.createElement('div');
    item.className = 'queue-item';
    
    let displayName = wf.name || 'Workflow';
    if (displayName.startsWith('recorded-workflow-')) displayName = displayName.replace('recorded-workflow-', 'Run ');
    
    const nameEl = document.createElement('div');
    nameEl.className = 'queue-item-name';
    nameEl.textContent = `${i + 1}. ${displayName}`;
    
    const rmBtn = document.createElement('button');
    rmBtn.className = 'queue-item-remove';
    rmBtn.textContent = '✖';
    rmBtn.onclick = () => {
      workflowQueue.splice(i, 1);
      renderQueue();
    };
    
    item.appendChild(nameEl);
    item.appendChild(rmBtn);
    queueList.appendChild(item);
  });
}

// ─── File loading ─────────────────────────────────────────────────────────────

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);

    if (!Array.isArray(parsed.events)) throw new Error("Invalid workflow: missing events array");

    workflowQueue.push({ ...parsed, name: parsed.name || file.name });
    renderQueue();
    showToast("Added to queue!", "success");
  } catch (err) {
    showToast("Failed to parse: " + err.message, "error");
  }

  // Reset file input so same file can be re-loaded
  fileInput.value = "";
});

// ─── Playback ─────────────────────────────────────────────────────────────────

btnPlay.addEventListener("click", async () => {
  if (workflowQueue.length === 0) return;

  playScreenshots = {};
  playProgressBar.style.width = "0%";
  playProgressText.textContent = `0 / ${workflowQueue[0].events.length}`;
  playCurrentEvent.textContent = "Starting Queue…";
  checkpointThumbsPlay.innerHTML = "";
  noCheckpointsYet.style.display = "block";

  const res = await sendToSW({ type: "START_PLAYBACK", workflows: workflowQueue });
  if (res?.ok) {
    showPanel("playing");
  } else {
    showToast("Playback error: " + (res?.error ?? "unknown"), "error");
  }
});

btnStopPlayback.addEventListener("click", async () => {
  await sendToSW({ type: "STOP_PLAYBACK" });
  showPanel("idle");
  showToast("Playback stopped.", "");
});


// ─── Service worker message listener ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "EVENT_RECORDED":
      if (recEventCount) recEventCount.textContent = msg.count;
      break;

    case "CHECKPOINT_ADDED":
      if (recCheckpointCount) {
        recCheckpointCount.textContent = parseInt(recCheckpointCount.textContent || "0") + 1;
      }
      addThumbnail(checkpointThumbsRec, msg.screenshotDataUrl, msg.label, msg.index);
      break;

    case "PLAYBACK_PROGRESS": {
      const pct = msg.total > 0 ? Math.round((msg.index / msg.total) * 100) : 0;
      playProgressBar.style.width = pct + "%";
      playProgressText.textContent = `${msg.index} / ${msg.total}`;
      const ev = msg.event;
      const evDesc = ev.type === "checkpoint"
        ? `📸 Checkpoint: ${ev.label}`
        : ev.type === "tab_switch"
          ? `🔀 Tab: ${ev.url?.replace(/^https?:\/\//, "").slice(0, 40) ?? ""}`
          : `${ev.type}${ev.selector ? " → " + ev.selector.slice(0, 35) : ""}`;
      playCurrentEvent.textContent = evDesc;
      break;
    }

    case "CHECKPOINT_REACHED":
      noCheckpointsYet.style.display = "none";
      playScreenshots[msg.index] = msg.screenshotDataUrl;
      addThumbnail(checkpointThumbsPlay, msg.screenshotDataUrl, msg.label, msg.index);
      break;

    case "WORKFLOW_PLAYBACK_COMPLETE":
      showToast(`✅ Completed: ${msg.name}`, "success");
      break;

    case "QUEUE_COMPLETE":
      playProgressBar.style.width = "100%";
      handlePlaybackComplete();
      break;

    case "PLAYBACK_STOPPED":
      showPanel("idle");
      break;

    default:
      break;
  }
});

function handlePlaybackComplete() {
  showPanel("idle");
  showToast("✅ Entire queue completed!", "success");
}

// ─── Thumbnail helper ─────────────────────────────────────────────────────────

function addThumbnail(container, dataUrl, label, index) {
  const item = document.createElement("div");
  item.className = "thumb-item";
  item.title = label || `Checkpoint ${index + 1}`;

  const img = document.createElement("img");
  img.src = dataUrl;
  img.alt = label || `Checkpoint ${index + 1}`;

  const lbl = document.createElement("div");
  lbl.className = "thumb-label";
  lbl.textContent = label || `#${index + 1}`;

  item.appendChild(img);
  item.appendChild(lbl);

  // Click thumbnail to open full screenshot
  item.addEventListener("click", () => {
    const win = window.open();
    if (win) {
      win.document.write(`<img src="${dataUrl}" style="max-width:100%;display:block;" />`);
    }
  });

  container.appendChild(item);
}

// ─── Dashboard button ─────────────────────────────────────────────────────────

btnOpenDashboard.addEventListener("click", () => {
  chrome.tabs.create({ url: DASHBOARD_URL });
});

// ─── Utility: send message to service worker ──────────────────────────────────

function sendToSW(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          console.warn("SW error:", chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(res);
        }
      });
    } catch (err) {
      console.warn("sendToSW threw:", err.message);
      resolve(null);
    }
  });
}

// ─── Toast ────────────────────────────────────────────────────────────────────

let toastTimer = null;

function showToast(message, type = "") {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = "toast" + (type ? " " + type : "");
  toastTimer = setTimeout(() => {
    toast.className = "toast hidden";
  }, 3000);
}

/**
 * Popup script — manages idle / recording / playing UI states and
 * communicates with the service worker.
 */

// Dashboard URL — keep in sync with service-worker.js
const DASHBOARD_URL = 'http://localhost:3000';
const DASHBOARD_AUTH_STORAGE_KEYS = ['dashboardAuthToken', 'dashboardAuthUserId', 'dashboardAuthEmail'];
const USER_SETTINGS_STORAGE_KEYS = ['playBufferSeconds', 'promptScreenshotLabel'];
const DEFAULT_USER_SETTINGS = {
  playBufferSeconds: 8,
  promptScreenshotLabel: false,
};

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
const btnOpenSettings   = document.getElementById("btnOpenSettings");
const loadedWorkflowName = document.getElementById("loadedWorkflowName");
const btnPlay           = document.getElementById("btnPlay");
const playBufferSeconds = document.getElementById("playBufferSeconds");
const promptScreenshotLabelToggle = document.getElementById("promptScreenshotLabelToggle");
const authSignedOut     = document.getElementById("authSignedOut");
const authSignedIn      = document.getElementById("authSignedIn");
const authTabSignin     = document.getElementById("authTabSignin");
const authTabSignup     = document.getElementById("authTabSignup");
const authEmail         = document.getElementById("authEmail");
const authPassword      = document.getElementById("authPassword");
const authConfirmPassword = document.getElementById("authConfirmPassword");
const btnAuthSubmit     = document.getElementById("btnAuthSubmit");
const btnExtensionLogout = document.getElementById("btnExtensionLogout");
const authUserEmail     = document.getElementById("authUserEmail");
const authStatus        = document.getElementById("authStatus");
const authProtectedContent = document.getElementById("authProtectedContent");

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
const btnCheckpoint     = document.getElementById("btnCheckpoint");
const btnConsoleCheckpoint = document.getElementById("btnConsoleCheckpoint");
const btnNetworkCheckpoint = document.getElementById("btnNetworkCheckpoint");
const btnStopRecording  = document.getElementById("btnStopRecording");
const btnRestartRecording = document.getElementById("btnRestartRecording");
const btnDiscardRecording = document.getElementById("btnDiscardRecording");
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
let authMode            = 'signin';
let dashboardAuth       = {
  token: null,
  userId: null,
  email: null,
};
let dashboardWorkflowsFetched = false;
let userSettings        = { ...DEFAULT_USER_SETTINGS };

// Playing state
let workflowQueue       = [];     // array of parsed workflow JSONs to play sequentially
let playScreenshots     = {};     // currently playing workflow's screenshots

function renderCheckpointLabelMode() {
  btnCheckpoint.title = promptScreenshotLabelToggle.checked
    ? 'Take screenshot checkpoint and optionally enter a label'
    : 'Take screenshot checkpoint without a label';
}

// ─── Init: sync state from service worker ────────────────────────────────────

/**
 * Aligns the popup UI with the service worker mode on load.
 *
 * Strategy:
 * Sends `GET_STATE`, then calls `showPanel` and starts the duration timer when recording.
 */
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

async function boot() {
  await initUserSettings();
  await init();
  await initAuthState();
}

boot();

// ─── Panel switching ──────────────────────────────────────────────────────────

/**
 * Shows one of idle / recording / playing panels and updates the status badge.
 *
 * Strategy:
 * Toggles `hidden` on the three panel roots and applies badge text plus CSS class.
 */
function showPanel(mode) {
  panelIdle.classList.toggle("hidden", mode !== "idle");
  panelRecording.classList.toggle("hidden", mode !== "recording");
  panelPlaying.classList.toggle("hidden", mode !== "playing");

  statusBadge.textContent = mode === "idle" ? "Idle" : mode === "recording" ? "Recording" : "Playing";
  statusBadge.className = "status-badge " + (mode !== "idle" ? mode : "");
}

// ─── Extension auth ───────────────────────────────────────────────────────────

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

function normalizePlayBufferSeconds(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_USER_SETTINGS.playBufferSeconds), 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_USER_SETTINGS.playBufferSeconds;
  }
  return Math.min(60, Math.max(0, parsed));
}

function normalizeUserSettings(input = {}) {
  return {
    playBufferSeconds: normalizePlayBufferSeconds(input.playBufferSeconds),
    promptScreenshotLabel: Boolean(input.promptScreenshotLabel),
  };
}

function applyUserSettings(nextSettings = {}) {
  userSettings = normalizeUserSettings({
    ...userSettings,
    ...nextSettings,
  });
  playBufferSeconds.value = String(userSettings.playBufferSeconds);
  promptScreenshotLabelToggle.checked = userSettings.promptScreenshotLabel;
  renderCheckpointLabelMode();
  return userSettings;
}

async function persistUserSettingsLocally(nextSettings = {}) {
  const resolvedSettings = applyUserSettings(nextSettings);
  await storageSet({
    playBufferSeconds: resolvedSettings.playBufferSeconds,
    promptScreenshotLabel: resolvedSettings.promptScreenshotLabel,
  });
  return resolvedSettings;
}

async function initUserSettings() {
  const storedSettings = await storageGet(USER_SETTINGS_STORAGE_KEYS);
  await persistUserSettingsLocally(storedSettings);
}

async function syncUserSettingsFromDashboard() {
  if (!dashboardAuth.token) {
    return userSettings;
  }

  try {
    const res = await dashboardFetch('/api/settings', { method: 'GET' }, true);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data?.error || `Server returned ${res.status}`);
    }

    return persistUserSettingsLocally(data?.settings || {});
  } catch (error) {
    if (error.message !== 'Unauthorized') {
      console.warn('Could not sync settings from dashboard:', error);
    }
    return userSettings;
  }
}

async function saveUserSettings(nextSettings) {
  const resolvedSettings = await persistUserSettingsLocally(nextSettings);

  if (!dashboardAuth.token) {
    return resolvedSettings;
  }

  try {
    const res = await dashboardFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(resolvedSettings),
    }, true);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data?.error || `Server returned ${res.status}`);
    }

    return persistUserSettingsLocally(data?.settings || resolvedSettings);
  } catch (error) {
    if (error.message !== 'Unauthorized') {
      console.warn('Could not save settings to dashboard:', error);
    }
    return resolvedSettings;
  }
}

async function handlePlayBufferSettingsChange() {
  await saveUserSettings({
    playBufferSeconds: playBufferSeconds.value,
  });
}

async function handlePromptScreenshotSettingChange() {
  await saveUserSettings({
    promptScreenshotLabel: promptScreenshotLabelToggle.checked,
  });
}

playBufferSeconds.addEventListener('change', handlePlayBufferSettingsChange);
promptScreenshotLabelToggle.addEventListener('change', handlePromptScreenshotSettingChange);

function setAuthMode(mode) {
  authMode = mode;
  authTabSignin.classList.toggle('active', mode === 'signin');
  authTabSignup.classList.toggle('active', mode === 'signup');
  authConfirmPassword.classList.toggle('hidden', mode !== 'signup');
  authPassword.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  authConfirmPassword.autocomplete = mode === 'signup' ? 'new-password' : 'off';
  btnAuthSubmit.textContent = mode === 'signup' ? 'Create Account' : 'Sign In';
  authStatus.textContent = '';
  authStatus.className = 'db-status';
}

function setAuthStatus(message = '', type = '') {
  authStatus.textContent = message;
  authStatus.className = 'db-status' + (type ? ' ' + type : '');
}

function resetDashboardWorkflowState() {
  workflowSelect.options.length = 1;
  workflowSelect.value = '';
  workflowSelect.disabled = !dashboardAuth.token;
  btnAddQueueDb.disabled = true;
  dashboardWorkflowsFetched = false;
  dbLoadStatus.textContent = dashboardAuth.token
    ? 'Refresh to load your dashboard workflows.'
    : 'Sign in to access dashboard workflows.';
  dbLoadStatus.className = 'db-status';
  workflowQueue = workflowQueue.filter((workflow) => !workflow._dashboardId);
  renderQueue();
}

function renderAuthState() {
  const isSignedIn = Boolean(dashboardAuth.token && dashboardAuth.email);

  authSignedOut.classList.toggle('hidden', isSignedIn);
  authSignedIn.classList.toggle('hidden', !isSignedIn);
  authProtectedContent.classList.toggle('hidden', !isSignedIn);

  if (isSignedIn) {
    authUserEmail.textContent = dashboardAuth.email;
    btnRecord.disabled = false;
    setAuthStatus('');
  } else {
    authUserEmail.textContent = '';
    btnRecord.disabled = true;
    workflowSelect.disabled = true;
    btnAddQueueDb.disabled = true;
    if (tabFromDashboard.classList.contains('active')) {
      dbLoadStatus.textContent = 'Sign in to access dashboard workflows.';
      dbLoadStatus.className = 'db-status';
    }
  }
}

async function persistDashboardAuth(nextAuth) {
  dashboardAuth = {
    token: nextAuth.token || null,
    userId: nextAuth.userId || null,
    email: nextAuth.email || null,
  };

  await storageSet({
    dashboardAuthToken: dashboardAuth.token,
    dashboardAuthUserId: dashboardAuth.userId,
    dashboardAuthEmail: dashboardAuth.email,
  });
  renderAuthState();
}

async function clearDashboardAuth(message = '', type = '') {
  dashboardAuth = { token: null, userId: null, email: null };
  await storageRemove(DASHBOARD_AUTH_STORAGE_KEYS);
  resetDashboardWorkflowState();
  renderAuthState();
  if (message) {
    setAuthStatus(message, type);
  }
}

async function dashboardFetch(path, options = {}, requireAuth = false) {
  const headers = new Headers(options.headers || {});
  headers.set('X-Extension', 'true');

  if (dashboardAuth.token) {
    headers.set('Authorization', `Bearer ${dashboardAuth.token}`);
  } else if (requireAuth) {
    throw new Error('Please sign in to your dashboard account first.');
  }

  const response = await fetch(`${DASHBOARD_URL}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 401 && requireAuth) {
    await clearDashboardAuth('Session expired. Sign in again.', 'error');
    throw new Error('Unauthorized');
  }

  return response;
}

async function initAuthState() {
  setAuthMode('signin');
  renderAuthState();

  const stored = await storageGet(DASHBOARD_AUTH_STORAGE_KEYS);
  if (!stored.dashboardAuthToken) {
    resetDashboardWorkflowState();
    renderAuthState();
    return;
  }

  dashboardAuth = {
    token: stored.dashboardAuthToken || null,
    userId: stored.dashboardAuthUserId || null,
    email: stored.dashboardAuthEmail || null,
  };

  try {
    const res = await dashboardFetch('/api/auth/session', { method: 'GET' }, true);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();
    await persistDashboardAuth({
      token: dashboardAuth.token,
      userId: data?.user?.userId || null,
      email: data?.user?.email || null,
    });
    await syncUserSettingsFromDashboard();
    resetDashboardWorkflowState();
  } catch (error) {
    if (error.message !== 'Unauthorized') {
      await clearDashboardAuth('Could not restore session. Sign in again.', 'error');
    }
  }
}

async function submitExtensionAuth() {
  const email = authEmail.value.trim();
  const password = authPassword.value;
  const confirmPassword = authConfirmPassword.value;

  if (!email || !password) {
    setAuthStatus('Email and password are required.', 'error');
    return;
  }

  if (authMode === 'signup') {
    if (password.length < 8) {
      setAuthStatus('Password must be at least 8 characters.', 'error');
      return;
    }
    if (password !== confirmPassword) {
      setAuthStatus('Passwords do not match.', 'error');
      return;
    }
  }

  btnAuthSubmit.disabled = true;
  setAuthStatus(authMode === 'signup' ? 'Creating account…' : 'Signing in…');

  try {
    const endpoint = authMode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
    const res = await dashboardFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data?.error || `Server returned ${res.status}`);
    }

    await persistDashboardAuth({
      token: data?.token || null,
      userId: data?.user?.userId || null,
      email: data?.user?.email || email,
    });
    await syncUserSettingsFromDashboard();

    authPassword.value = '';
    authConfirmPassword.value = '';
    resetDashboardWorkflowState();
    setAuthStatus(authMode === 'signup' ? 'Account created.' : 'Signed in.');
    showToast(authMode === 'signup' ? 'Account created.' : 'Signed in.', 'success');

    if (tabFromDashboard.classList.contains('active')) {
      fetchDashboardWorkflows();
    }
  } catch (error) {
    setAuthStatus(error.message || 'Authentication failed.', 'error');
  } finally {
    btnAuthSubmit.disabled = false;
  }
}

async function logoutExtensionAuth() {
  btnExtensionLogout.disabled = true;

  try {
    await dashboardFetch('/api/auth/logout', { method: 'POST' });
  } catch (_) {
    // Best effort only. The extension primarily relies on bearer tokens.
  }

  await clearDashboardAuth('Signed out.');
  authPassword.value = '';
  authConfirmPassword.value = '';
  showToast('Signed out.', 'success');
  btnExtensionLogout.disabled = false;
}

authTabSignin.addEventListener('click', () => setAuthMode('signin'));
authTabSignup.addEventListener('click', () => setAuthMode('signup'));
btnAuthSubmit.addEventListener('click', submitExtensionAuth);
btnExtensionLogout.addEventListener('click', logoutExtensionAuth);

// ─── Recording ────────────────────────────────────────────────────────────────

btnRecord.addEventListener("click", async () => {
  if (!dashboardAuth.token) {
    showToast("Sign in to record workflows to your dashboard.", "error");
    return;
  }

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
    recordingStartTime = Date.now();
    startDurationTimer();
    showPanel("recording");
  } else {
    showToast("Could not start recording: " + (res?.error ?? "unknown"), "error");
  }
});

/**
 * Updates the recording duration label every second while recording.
 *
 * Strategy:
 * Uses `setInterval` from `recordingStartTime` to format minutes and seconds on the DOM.
 */
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
  let label = null;
  if (promptScreenshotLabelToggle.checked) {
    const promptedLabel = window.prompt("Screenshot checkpoint label (optional):");
    if (promptedLabel === null) {
      return;
    }
    label = promptedLabel.trim() || null;
  }

  btnCheckpoint.disabled = true;
  const res = await sendToSW({ type: "ADD_CHECKPOINT", label });
  btnCheckpoint.disabled = false;

  if (res?.ok) {
    // Thumbnail is added via the CHECKPOINT_ADDED runtime message below
  } else {
    showToast("Checkpoint failed: " + (res?.error ?? "unknown"), "error");
  }
});

// ─── Console Log Checkpoint dialog ────────────────────────────────────────────

btnConsoleCheckpoint.addEventListener("click", () => {
  sendToSW({ type: "TOGGLE_CONSOLE_DIALOG" }).then(() => window.close());
});

// ─── Network Call Checkpoint dialog ───────────────────────────────────────────

btnNetworkCheckpoint.addEventListener("click", () => {
  sendToSW({ type: "TOGGLE_NETWORK_DIALOG" }).then(() => window.close());
});

// ─── HTML escape helper ────────────────────────────────────────────────────────

/**
 * Escapes a string for safe insertion into `innerHTML` when building list rows.
 *
 * Strategy:
 * Replaces `&`, `<`, `>`, and `"` with HTML entities.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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
  showToast("Recording stopped. Saving to dashboard…", "success");
  showPanel("idle");
});

btnRestartRecording.addEventListener("click", async () => {
  btnRestartRecording.disabled = true;
  const res = await sendToSW({ type: "RESTART_RECORDING" });
  btnRestartRecording.disabled = false;

  if (res?.ok) {
    recEventCount.textContent = "0";
    recCheckpointCount.textContent = "0";
    recDuration.textContent = "0s";
    checkpointThumbsRec.innerHTML = "";
    recordingStartTime = Date.now();
    startDurationTimer();
    showToast("Recording restarted", "success");
  } else {
    showToast("Restart failed: " + (res?.error ?? "unknown"), "error");
  }
});

btnDiscardRecording.addEventListener("click", async () => {
  if (!confirm("Are you sure you want to discard this recording?")) return;
  btnDiscardRecording.disabled = true;
  const res = await sendToSW({ type: "DISCARD_RECORDING" });
  btnDiscardRecording.disabled = false;

  if (res?.ok) {
    clearInterval(durationTimer);
    showPanel("idle");
    showToast("Recording discarded", "success");
  } else {
    showToast("Discard failed: " + (res?.error ?? "unknown"), "error");
  }
});

// ─── Load source tabs ────────────────────────────────────────────────────────

/**
 * Switches between file-based and dashboard-based workflow loading UI.
 *
 * Strategy:
 * Toggles tab and pane visibility; on first open of the dashboard tab, triggers
 * `fetchDashboardWorkflows`.
 */
function switchLoadTab(tab) {
  const isFile = tab === 'file';
  tabFromFile.classList.toggle('active', isFile);
  tabFromDashboard.classList.toggle('active', !isFile);
  paneFromFile.classList.toggle('hidden', !isFile);
  paneFromDashboard.classList.toggle('hidden', isFile);
  if (!isFile && !dashboardAuth.token) {
    workflowSelect.disabled = true;
    btnAddQueueDb.disabled = true;
    dbLoadStatus.textContent = 'Sign in to access dashboard workflows.';
    dbLoadStatus.className = 'db-status';
    return;
  }
  if (!isFile && !dashboardWorkflowsFetched) {
    dashboardWorkflowsFetched = true;
    fetchDashboardWorkflows();
  }
}

tabFromFile.addEventListener('click', () => switchLoadTab('file'));
tabFromDashboard.addEventListener('click', () => switchLoadTab('dashboard'));

/**
 * Loads workflow metadata from the dashboard API into the select control.
 *
 * Strategy:
 * GETs `/api/workflows` with the extension header, repopulates options, and surfaces
 * status text; resets fetch flag on error so retry works.
 */
async function fetchDashboardWorkflows() {
  if (!dashboardAuth.token) {
    dashboardWorkflowsFetched = false;
    workflowSelect.options.length = 1;
    workflowSelect.value = '';
    workflowSelect.disabled = true;
    btnAddQueueDb.disabled = true;
    dbLoadStatus.textContent = 'Sign in to access dashboard workflows.';
    dbLoadStatus.className = 'db-status';
    return;
  }

  dbLoadStatus.textContent = 'Loading…';
  dbLoadStatus.className = 'db-status';
  workflowSelect.disabled = true;
  btnAddQueueDb.disabled = true;
  // Clear old options except placeholder
  workflowSelect.options.length = 1;

  try {
    const res = await dashboardFetch('/api/workflows', { method: 'GET' }, true);
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
    workflowSelect.disabled = !dashboardAuth.token;
    btnAddQueueDb.disabled = !dashboardAuth.token || !workflowSelect.value;
  }
}

btnRefreshWorkflows.addEventListener('click', () => {
  workflowSelect.options.length = 1; // Clear UI immediately for feedback
  dashboardWorkflowsFetched = true;
  fetchDashboardWorkflows();
});

workflowSelect.addEventListener('change', () => {
  btnAddQueueDb.disabled = !dashboardAuth.token || !workflowSelect.value;
});

btnAddQueueDb.addEventListener('click', async () => {
  const id = workflowSelect.value;
  if (!id) return;

  dbLoadStatus.textContent = 'Adding to queue…';
  btnAddQueueDb.disabled = true;
  workflowSelect.disabled = true;

  try {
    const res = await dashboardFetch(`/api/workflows/${id}`, { method: 'GET' }, true);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const wf = await res.json();
    if (!Array.isArray(wf.events)) throw new Error('Workflow has no events');
    
    workflowQueue.push({
      id: wf.id,
      _dashboardId: wf.id,
      name: wf.name,
      recordedAt: wf.recordedAt,
      events: wf.events,
      loopEnabled: false,
      loopCount: 2,
    });
    renderQueue();
    
    dbLoadStatus.textContent = `Added: ${wf.name}`;
    dbLoadStatus.className = 'db-status';
  } catch (err) {
    dbLoadStatus.textContent = `Failed to load: ${err.message}`;
    dbLoadStatus.className = 'db-status error';
  } finally {
    workflowSelect.value = ''; // Reset UI
    btnAddQueueDb.disabled = true;
    workflowSelect.disabled = !dashboardAuth.token;
  }
});

/**
 * Renders the playback queue list and enables or disables the Play button.
 *
 * Strategy:
 * Builds DOM rows with remove handlers, toggles queue container visibility, and mirrors
 * queue length into the Play button label via `innerHTML`.
 */
function renderQueue() {
  queueList.innerHTML = '';
  if (workflowQueue.length === 0) {
    queueContainer.classList.add('hidden');
    btnPlay.disabled = true;
    btnPlay.innerHTML = '<span class="btn-icon" aria-hidden="true"></span> Play Queue';
    return;
  }
  
  queueContainer.classList.remove('hidden');
  queueCount.textContent = workflowQueue.length;
  btnPlay.disabled = false;
  btnPlay.innerHTML = `<span class="btn-icon" aria-hidden="true"></span> Play Queue (${workflowQueue.length})`;

  workflowQueue.forEach((wf, i) => {
    const item = document.createElement('div');
    item.className = 'queue-item';
    
    let displayName = wf.name || 'Workflow';
    if (displayName.startsWith('recorded-workflow-')) displayName = displayName.replace('recorded-workflow-', 'Run ');
    
    const topRow = document.createElement('div');
    topRow.className = 'queue-item-top';

    const nameEl = document.createElement('div');
    nameEl.className = 'queue-item-name';
    nameEl.textContent = `${i + 1}. ${displayName}`;

    const controlsRow = document.createElement('div');
    controlsRow.className = 'queue-item-controls';

    const loopControls = document.createElement('div');
    loopControls.className = 'queue-loop-controls';

    const loopLabel = document.createElement('label');
    loopLabel.className = 'queue-loop-label';

    const loopCheckbox = document.createElement('input');
    loopCheckbox.type = 'checkbox';
    loopCheckbox.checked = Boolean(wf.loopEnabled);
    const commitLoopToggle = () => {
      wf.loopEnabled = loopCheckbox.checked;
      if (wf.loopEnabled && (!Number.isInteger(wf.loopCount) || wf.loopCount < 2)) {
        wf.loopCount = 2;
      }
      renderQueue();
    };
    loopCheckbox.addEventListener('change', commitLoopToggle);
    loopCheckbox.addEventListener('input', commitLoopToggle);

    const loopText = document.createElement('span');
    loopText.textContent = 'Loop';

    const loopCount = document.createElement('input');
    loopCount.type = 'number';
    loopCount.min = '2';
    loopCount.max = '99';
    loopCount.value = String(Math.max(2, Number.parseInt(wf.loopCount, 10) || 2));
    loopCount.className = 'input queue-loop-count';
    loopCount.classList.toggle('hidden', !wf.loopEnabled);
    loopCount.addEventListener('click', (event) => event.stopPropagation());
    const commitLoopCount = () => {
      const nextValue = Math.max(2, Number.parseInt(loopCount.value, 10) || 2);
      wf.loopCount = nextValue;
      loopCount.value = String(nextValue);
    };
    loopCount.addEventListener('input', commitLoopCount);
    loopCount.addEventListener('change', commitLoopCount);

    loopLabel.appendChild(loopCheckbox);
    loopLabel.appendChild(loopText);
    loopControls.appendChild(loopLabel);
    loopControls.appendChild(loopCount);
    
    const rmBtn = document.createElement('button');
    rmBtn.className = 'queue-item-remove';
    rmBtn.textContent = 'x';
    rmBtn.onclick = () => {
      workflowQueue.splice(i, 1);
      renderQueue();
    };
    
    topRow.appendChild(nameEl);
    topRow.appendChild(rmBtn);
    controlsRow.appendChild(loopControls);
    item.appendChild(topRow);
    item.appendChild(controlsRow);
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

    workflowQueue.push({
      ...parsed,
      name: parsed.name || file.name,
      loopEnabled: false,
      loopCount: 2,
    });
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

  const workflows = workflowQueue.map((workflow) => ({
    ...workflow,
    loopEnabled: Boolean(workflow.loopEnabled),
    loopCount: workflow.loopEnabled
      ? Math.max(2, Number.parseInt(workflow.loopCount, 10) || 2)
      : 1,
  }));

  const res = await sendToSW({ type: "START_PLAYBACK", workflows });
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
      if (msg.screenshotDataUrl) {
        addThumbnail(checkpointThumbsRec, msg.screenshotDataUrl, msg.label, msg.index);
      }
      break;

    case "CONSOLE_CHECKPOINT_ADDED":
      if (recCheckpointCount) {
        recCheckpointCount.textContent = parseInt(recCheckpointCount.textContent || "0") + 1;
      }
      break;

    case "NETWORK_CHECKPOINT_ADDED":
      if (recCheckpointCount) {
        recCheckpointCount.textContent = parseInt(recCheckpointCount.textContent || "0") + 1;
      }
      break;

    case "DASHBOARD_SAVE_COMPLETE":
      showToast("Workflow saved to Dashboard.", "success");
      break;

    case "DASHBOARD_SAVE_FAILED":
      showToast(`Dashboard save failed: ${msg.error || "unknown error"}`, "error");
      break;

    case "PLAYBACK_PROGRESS": {
      const pct = msg.total > 0 ? Math.round((msg.index / msg.total) * 100) : 0;
      playProgressBar.style.width = pct + "%";
      playProgressText.textContent = `${msg.index} / ${msg.total}`;
      const ev = msg.event;
      const evDesc = ev.type === "checkpoint"
        ? `Screenshot checkpoint: ${ev.label}`
        : ev.type === "console_checkpoint"
          ? `Console checkpoint: ${ev.label}`
          : ev.type === "network_checkpoint"
            ? `Network checkpoint: ${ev.label}`
            : ev.type === "tab_switch"
              ? `Tab: ${ev.url?.replace(/^https?:\/\//, "").slice(0, 40) ?? ""}`
              : `${ev.type}${ev.selector ? " → " + ev.selector.slice(0, 35) : ""}`;
      playCurrentEvent.textContent = evDesc;
      break;
    }

    case "CHECKPOINT_REACHED":
      noCheckpointsYet.style.display = "none";
      if (msg.screenshotDataUrl) {
        playScreenshots[msg.index] = msg.screenshotDataUrl;
        addThumbnail(checkpointThumbsPlay, msg.screenshotDataUrl, msg.label, msg.index);
      }
      break;

    case "WORKFLOW_PLAYBACK_COMPLETE":
      showToast(`Completed: ${msg.name}`, "success");
      break;

    case "WORKFLOW_PLAYBACK_FAILED": {
      const step = msg.failedStep;
      const stepDesc = step
        ? `Step ${step.index + 1} (${step.type}${step.selector ? ": " + step.selector.slice(0, 35) : ""})`
        : "unknown step";
      showToast(`Failed at ${stepDesc}`, "error");
      // Only return to idle — do NOT call handlePlaybackComplete() here because
      // that function shows "Entire queue completed." (success), which would
      // immediately overwrite this error toast with a false-positive message.
      showPanel("idle");
      break;
    }

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

/**
 * Returns the UI to idle after a full queue finishes and shows a completion toast.
 *
 * Strategy:
 * Calls `showPanel("idle")` then `showToast` for a neutral success message.
 */
function handlePlaybackComplete() {
  showPanel("idle");
  showToast("Entire queue completed.", "success");
}

// ─── Thumbnail helper ─────────────────────────────────────────────────────────

/**
 * Appends a small screenshot preview with label to a strip container.
 *
 * Strategy:
 * Creates image and caption nodes, wires click to open the data URL in a new window.
 */
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

btnOpenSettings.addEventListener("click", () => {
  chrome.tabs.create({ url: `${DASHBOARD_URL}/settings` });
});

// ─── Utility: send message to service worker ──────────────────────────────────

/**
 * Promise wrapper around `chrome.runtime.sendMessage` to the service worker.
 *
 * Strategy:
 * Resolves with the callback result or `null` when `lastError` is set or send throws.
 */
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

/**
 * Shows a transient toast message with optional success/error styling.
 *
 * Strategy:
 * Sets text and class on the toast node, clears any prior timer, auto-hides after 3s.
 */
function showToast(message, type = "") {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = "toast" + (type ? " " + type : "");
  toastTimer = setTimeout(() => {
    toast.className = "toast hidden";
  }, 3000);
}

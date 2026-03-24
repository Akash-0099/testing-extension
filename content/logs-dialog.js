/**
 * Content Script - Logs Dialog Overlay
 *
 * Injects a resizable, draggable UI overlay for selecting Console and Network logs.
 * It listens for incoming logs in real-time and fetches history from the SW.
 */

(function () {
  "use strict";

  if (window.__workflowLogsDialogLoaded) return;
  window.__workflowLogsDialogLoaded = true;

  const DIALOG_ID = "__wf_logs_dialog__";
  let activeTab = "console"; // "console" | "network"
  let consoleLogs = [];
  let networkCalls = [];
  let selectedLog = null;
  let selectedCall = null;

  // ─── UI Construction ────────────────────────────────────────────────────────

  function createDialog() {
    if (document.getElementById(DIALOG_ID)) return;

    const dialog = document.createElement("div");
    dialog.id = DIALOG_ID;
    dialog.style.cssText = `
      position: fixed;
      top: 50px;
      right: 50px;
      width: 400px;
      height: 500px;
      min-width: 300px;
      min-height: 250px;
      background: #111827;
      color: #f3f4f6;
      border: 1px solid #374151;
      border-radius: 8px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      overflow: hidden;
      resize: both;
      transition: opacity 0.2s ease;
    `;
    // Hidden by default
    dialog.style.display = "none";

    // Header (Draggable)
    const header = document.createElement("div");
    header.id = "__wf_logs_header__";
    header.style.cssText = `
      padding: 12px 16px;
      background: #1f2937;
      border-bottom: 1px solid #374151;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: grab;
      user-select: none;
    `;
    
    const title = document.createElement("div");
    title.id = "__wf_logs_title__";
    title.style.cssText = "font-weight: 600; font-size: 14px; color: #e5e7eb;";
    title.textContent = "Logs / Network Checks";

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.style.cssText = `
      background: transparent;
      border: none;
      color: #9ca3af;
      font-size: 20px;
      cursor: pointer;
      line-height: 1;
      padding: 0;
    `;
    closeBtn.onclick = () => {
      hideDialog();
      chrome.runtime.sendMessage({ type: "CLOSE_LOGS_DIALOG" }).catch(() => {});
    };

    header.appendChild(title);
    header.appendChild(closeBtn);

    // Make Draggable
    let isDragging = false;
    let dragStartX, dragStartY, initialLeft, initialTop;

    header.addEventListener("mousedown", (e) => {
      isDragging = true;
      header.style.cursor = "grabbing";
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const rect = dialog.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      dialog.style.left = `${initialLeft + dx}px`;
      dialog.style.top = `${initialTop + dy}px`;
      dialog.style.right = "auto"; // Override right since we are using left/top
    });

    document.addEventListener("mouseup", () => {
      isDragging = false;
      header.style.cursor = "grab";
    });

    // Content area
    const body = document.createElement("div");
    body.style.cssText = `
      flex: 1;
      overflow-y: auto;
      padding: 0;
      background: #111827;
      position: relative;
    `;
    
    const listContainer = document.createElement("div");
    listContainer.id = "__wf_logs_list__";
    listContainer.style.cssText = "display: flex; flex-direction: column;";

    body.appendChild(listContainer);

    // Footer
    const footer = document.createElement("div");
    footer.style.cssText = `
      padding: 12px 16px;
      border-top: 1px solid #374151;
      background: #1f2937;
      display: flex;
      flex-direction: column;
      gap: 10px;
    `;

    const inputWrap = document.createElement("div");
    inputWrap.style.cssText = "display: flex; gap: 8px;";

    const labelInput = document.createElement("input");
    labelInput.id = "__wf_logs_label_input__";
    labelInput.type = "text";
    labelInput.placeholder = "Checkpoint label (optional)";
    labelInput.style.cssText = `
      flex: 1;
      background: #374151;
      border: 1px solid #4b5563;
      color: #f3f4f6;
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 13px;
      outline: none;
    `;
    labelInput.addEventListener("focus", () => labelInput.style.borderColor = "#3b82f6");
    labelInput.addEventListener("blur", () => labelInput.style.borderColor = "#4b5563");

    const addBtn = document.createElement("button");
    addBtn.id = "__wf_logs_add_btn__";
    addBtn.textContent = "Add Checkpoint";
    addBtn.disabled = true;
    addBtn.style.cssText = `
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 4px;
      padding: 6px 12px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      opacity: 0.5;
      transition: background 0.2s, opacity 0.2s;
    `;
    addBtn.onclick = handleAddCheckpoint;

    inputWrap.appendChild(labelInput);
    inputWrap.appendChild(addBtn);
    footer.appendChild(inputWrap);

    dialog.appendChild(header);
    dialog.appendChild(body);
    dialog.appendChild(footer);

    document.body.appendChild(dialog);
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  function renderList() {
    const list = document.getElementById("__wf_logs_list__");
    if (!list) return;

    list.innerHTML = "";

    const items = activeTab === "console" ? consoleLogs : networkCalls;

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = activeTab === "console" ? "No console logs captured." : "No network calls captured.";
      empty.style.cssText = "padding: 20px; text-align: center; color: #9ca3af; font-size: 13px; font-style: italic;";
      list.appendChild(empty);
      updateFooterState();
      return;
    }

    items.forEach((item, index) => {
      const row = document.createElement("div");
      
      const isSelected = activeTab === "console" ? (selectedLog === item) : (selectedCall === item);
      
      row.style.cssText = `
        padding: 8px 12px;
        border-bottom: 1px solid #1f2937;
        font-size: 12px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        background: ${isSelected ? '#1e3a8a' : 'transparent'};
        transition: background 0.15s;
        word-break: break-all;
      `;

      row.onmouseover = () => { if (!isSelected) row.style.background = "#1f2937"; };
      row.onmouseout = () => { if (!isSelected) row.style.background = "transparent"; };

      row.onclick = () => {
        if (activeTab === "console") selectedLog = item;
        else selectedCall = item;
        renderList();
      };

      const time = new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

      if (activeTab === "console") {
        const badge = document.createElement("span");
        badge.textContent = "LOG";
        badge.style.cssText = "font-size: 10px; font-weight: 600; padding: 2px 4px; border-radius: 4px; background: #374151; color: #d1d5db; flex-shrink: 0;";
        
        const msg = document.createElement("span");
        msg.textContent = item.message.length > 100 ? item.message.slice(0, 98) + "…" : item.message;
        msg.style.cssText = "flex: 1; color: #e5e7eb;";

        const timeNode = document.createElement("span");
        timeNode.textContent = time;
        timeNode.style.cssText = "color: #6b7280; font-size: 10px; flex-shrink: 0;";

        row.appendChild(badge);
        row.appendChild(msg);
        row.appendChild(timeNode);
      } else {
        const method = document.createElement("span");
        method.textContent = item.method;
        method.style.cssText = "font-size: 10px; font-weight: 600; padding: 2px 4px; border-radius: 4px; background: #3b82f6; color: #fff; flex-shrink: 0;";

        const urlInfo = document.createElement("span");
        urlInfo.textContent = item.url.length > 80 ? "…" + item.url.slice(-78) : item.url;
        urlInfo.style.cssText = "flex: 1; color: #e5e7eb;";

        const statusColor = item.status >= 400 ? "#ef4444" : item.status >= 300 ? "#f59e0b" : "#10b981";
        const status = document.createElement("span");
        status.textContent = item.status || "---";
        status.style.cssText = `font-size: 10px; font-weight: 700; color: ${statusColor}; flex-shrink: 0; min-width: 24px; text-align: center;`;

        const timeNode = document.createElement("span");
        timeNode.textContent = time;
        timeNode.style.cssText = "color: #6b7280; font-size: 10px; flex-shrink: 0;";

        row.appendChild(method);
        row.appendChild(urlInfo);
        row.appendChild(status);
        row.appendChild(timeNode);
      }

      list.appendChild(row);
    });

    updateFooterState();
  }

  function updateFooterState() {
    const btn = document.getElementById("__wf_logs_add_btn__");
    if (!btn) return;

    const hasSelection = activeTab === "console" ? !!selectedLog : !!selectedCall;
    
    if (hasSelection) {
      btn.disabled = false;
      btn.style.opacity = "1";
      btn.style.cursor = "pointer";
    } else {
      btn.disabled = true;
      btn.style.opacity = "0.5";
      btn.style.cursor = "not-allowed";
    }
  }

  // ─── Core Logic & Interactivity ───────────────────────────────────────────

  function showDialog(tabType) {
    createDialog();
    activeTab = tabType;
    document.getElementById("__wf_logs_title__").textContent = tabType === 'console' ? "Console Logs" : "Network Calls";
    const dialog = document.getElementById(DIALOG_ID);
    dialog.style.display = "flex";
    
    // Fetch latest state from Service Worker specific to this tab
    chrome.runtime.sendMessage({ type: tabType === "console" ? "GET_CONSOLE_LOGS" : "GET_NETWORK_CALLS" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (tabType === "console") {
        consoleLogs = res?.logs || [];
      } else {
        networkCalls = res?.calls || [];
      }
      renderList();
      
      // Auto-scroll to bottom on open
      setTimeout(() => {
        const body = document.getElementById("__wf_logs_list__")?.parentElement;
        if (body) body.scrollTop = body.scrollHeight;
      }, 50);
    });
  }

  function hideDialog() {
    const dialog = document.getElementById(DIALOG_ID);
    if (dialog) dialog.style.display = "none";
  }

  async function handleAddCheckpoint() {
    const input = document.getElementById("__wf_logs_label_input__");
    const label = input.value.trim() || null;
    const btn = document.getElementById("__wf_logs_add_btn__");
    btn.textContent = "Saving...";
    btn.disabled = true;

    try {
      if (activeTab === "console" && selectedLog) {
        await chrome.runtime.sendMessage({
          type: "ADD_CONSOLE_CHECKPOINT",
          logMessage: selectedLog.message,
          label
        });
      } else if (activeTab === "network" && selectedCall) {
        await chrome.runtime.sendMessage({
          type: "ADD_NETWORK_CHECKPOINT",
          networkUrl: selectedCall.url,
          networkMethod: selectedCall.method,
          networkStatus: selectedCall.status,
          label
        });
      }
      
      // Cleanup UI
      input.value = "";
      selectedLog = null;
      selectedCall = null;
      hideDialog();
      // Notify background to clear state
      chrome.runtime.sendMessage({ type: "CLOSE_LOGS_DIALOG" }).catch(() => {});
      
    } catch (err) {
      console.warn("Failed to add checkpoint:", err);
    }
    
    btn.textContent = "Add Checkpoint";
  }

  // ─── Listeners ────────────────────────────────────────────────────────────

  // 1. Listen for runtime messages (visibility toggles & syncs)
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      if (msg.type === "SYNC_DIALOG_STATE") {
        if (msg.consoleOpen) showDialog("console");
        else if (msg.networkOpen) showDialog("network");
        else hideDialog();
        sendResponse({ ok: true });
      }
    } catch (e) {}
    return false;
  });

  // 2. Listen for REAL-TIME logs from page-interceptor.js in the SAME tab
  window.addEventListener("message", (e) => {
    if (!e.data || e.data.__wfSrc !== "__wf_interceptor__") return;
    
    const dialog = document.getElementById(DIALOG_ID);
    const isVisible = dialog && dialog.style.display === "flex";
    
    // Only bother updating DOM if the dialog is currently on screen
    if (!isVisible) return;

    if (e.data.type === "console_log") {
      consoleLogs.push({
        message: e.data.message,
        timestamp: e.data.timestamp,
        url: window.location.href,
      });
      if (activeTab === "console") {
        renderList();
        const body = document.getElementById("__wf_logs_list__")?.parentElement;
        // Auto-scroll logic if user hasn't scrolled up manually
        if (body && body.scrollHeight - body.scrollTop - body.clientHeight < 50) {
           body.scrollTop = body.scrollHeight;
        }
      }
    } else if (e.data.type === "network_call") {
      networkCalls.push({
        url: e.data.url,
        method: e.data.method,
        status: e.data.status,
        timestamp: e.data.timestamp,
      });
      if (activeTab === "network") {
        renderList();
        const body = document.getElementById("__wf_logs_list__")?.parentElement;
        if (body && body.scrollHeight - body.scrollTop - body.clientHeight < 50) {
           body.scrollTop = body.scrollHeight;
        }
      }
    }
  });

})();

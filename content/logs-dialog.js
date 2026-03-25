/**
 * Content Script - Logs Dialog Overlay
 *
 * Injects resizable, draggable UI overlays for Console and Network logs.
 * They run independently and can be onscreen at the same time.
 */

(function () {
  "use strict";

  if (window.__workflowLogsDialogLoaded) return;
  window.__workflowLogsDialogLoaded = true;

  const DIALOGS = {
    console: { id: "__wf_console_dialog__", title: "Console Logs", items: [], selected: null },
    network: { id: "__wf_network_dialog__", title: "Network Calls", items: [], selected: null }
  };

  // ─── Dialog Factory ───────────────────────────────────────────────────────

  function createDialog(type) {
    const config = DIALOGS[type];
    if (document.getElementById(config.id)) return document.getElementById(config.id);

    const dialog = document.createElement("div");
    dialog.id = config.id;
    // Offset network dialog slightly so they don't exactly overlap on first open
    const topPx = type === "console" ? 50 : 100;
    const rightPx = type === "console" ? 50 : 80;

    dialog.style.cssText = `
      position: fixed;
      top: ${topPx}px;
      right: ${rightPx}px;
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
    dialog.style.display = "none";

    // Header
    const header = document.createElement("div");
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
    title.style.cssText = "font-weight: 600; font-size: 14px; color: #e5e7eb;";
    title.textContent = config.title;

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
      dialog.style.display = "none";
      const action = type === "console" ? "CLOSE_CONSOLE_DIALOG" : "CLOSE_NETWORK_DIALOG";
      try {
        chrome.runtime.sendMessage({ type: action }).catch(() => {});
      } catch (err) {}
    };

    header.appendChild(title);
    header.appendChild(closeBtn);

    // Draggable Logic
    let isDragging = false;
    let dragStartX, dragStartY, initialLeft, initialTop;

    header.addEventListener("mousedown", (e) => {
      isDragging = true;
      header.style.cursor = "grabbing";
      dialog.style.zIndex = "2147483648"; // Bring to front
      // lower other dialog
      const otherType = type === "console" ? "network" : "console";
      const otherDialog = document.getElementById(DIALOGS[otherType].id);
      if (otherDialog) otherDialog.style.zIndex = "2147483647";

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
      dialog.style.right = "auto";
    });

    document.addEventListener("mouseup", () => {
      isDragging = false;
      header.style.cursor = "grab";
    });

    // Body
    const body = document.createElement("div");
    body.style.cssText = `
      flex: 1;
      overflow-y: auto;
      padding: 0;
      background: #111827;
      position: relative;
    `;
    
    const listContainer = document.createElement("div");
    listContainer.className = "__wf_logs_list__";
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
    labelInput.className = "__wf_logs_label_input__";
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

    const addBtn = document.createElement("button");
    addBtn.className = "__wf_logs_add_btn__";
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
    addBtn.onclick = () => handleAddCheckpoint(type);

    inputWrap.appendChild(labelInput);
    inputWrap.appendChild(addBtn);
    footer.appendChild(inputWrap);

    dialog.appendChild(header);
    dialog.appendChild(body);
    dialog.appendChild(footer);

    document.body.appendChild(dialog);
    return dialog;
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  function renderList(type) {
    const dialog = document.getElementById(DIALOGS[type].id);
    if (!dialog) return;

    const list = dialog.querySelector(".__wf_logs_list__");
    if (!list) return;

    list.innerHTML = "";

    const items = DIALOGS[type].items;
    const selected = DIALOGS[type].selected;

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = type === "console" ? "No console logs captured." : "No network calls captured.";
      empty.style.cssText = "padding: 20px; text-align: center; color: #9ca3af; font-size: 13px; font-style: italic;";
      list.appendChild(empty);
      updateFooterState(type);
      return;
    }

    items.forEach((item, index) => {
      const row = document.createElement("div");
      const isSelected = (selected === item);
      
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
        DIALOGS[type].selected = item;
        renderList(type);
      };

      const time = new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

      if (type === "console") {
        const badge = document.createElement("span");
        badge.textContent = "LOG";
        badge.style.cssText = "font-size: 10px; font-weight: 600; padding: 2px 4px; border-radius: 4px; background: #374151; color: #d1d5db; flex-shrink: 0;";
        
        const messageStr = String(item.message || "");
        const msg = document.createElement("span");
        msg.textContent = messageStr.length > 100 ? messageStr.slice(0, 98) + "…" : messageStr;
        msg.style.cssText = "flex: 1; color: #e5e7eb;";

        const timeNode = document.createElement("span");
        timeNode.textContent = time;
        timeNode.style.cssText = "color: #6b7280; font-size: 10px; flex-shrink: 0;";

        row.appendChild(badge);
        row.appendChild(msg);
        row.appendChild(timeNode);
      } else {
        const methodStr = String(item.method || "GET");
        const method = document.createElement("span");
        method.textContent = methodStr;
        method.style.cssText = "font-size: 10px; font-weight: 600; padding: 2px 4px; border-radius: 4px; background: #3b82f6; color: #fff; flex-shrink: 0;";

        const urlStr = String(item.url || "unknown");
        const urlInfo = document.createElement("span");
        urlInfo.textContent = urlStr.length > 80 ? "…" + urlStr.slice(-78) : urlStr;
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

    updateFooterState(type);
  }

  function updateFooterState(type) {
    const dialog = document.getElementById(DIALOGS[type].id);
    if (!dialog) return;

    const btn = dialog.querySelector(".__wf_logs_add_btn__");
    if (!btn) return;

    const hasSelection = !!DIALOGS[type].selected;
    
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

  function showDialog(type) {
    const dialog = createDialog(type);
    dialog.style.display = "flex";
    dialog.style.zIndex = "2147483648"; // active one on top
    
    const otherType = type === "console" ? "network" : "console";
    const otherDialog = document.getElementById(DIALOGS[otherType].id);
    if (otherDialog) otherDialog.style.zIndex = "2147483647";
    
    // Fetch latest state from Service Worker specific to this tab
    try {
      chrome.runtime.sendMessage({ type: type === "console" ? "GET_CONSOLE_LOGS" : "GET_NETWORK_CALLS" }, (res) => {
        if (chrome.runtime.lastError) return;
        DIALOGS[type].items = (type === "console" ? res?.logs : res?.calls) || [];
        renderList(type);
        
        // Auto-scroll to bottom on open
        setTimeout(() => {
          const listContainer = dialog.querySelector(".__wf_logs_list__");
          const body = listContainer?.parentElement;
          if (body) body.scrollTop = body.scrollHeight;
        }, 50);
      });
    } catch (err) {}
  }

  function hideDialog(type) {
    const dialog = document.getElementById(DIALOGS[type].id);
    if (dialog) dialog.style.display = "none";
  }

  async function handleAddCheckpoint(type) {
    const dialog = document.getElementById(DIALOGS[type].id);
    const input = dialog.querySelector(".__wf_logs_label_input__");
    const label = input.value.trim() || null;
    const btn = dialog.querySelector(".__wf_logs_add_btn__");
    const selected = DIALOGS[type].selected;

    btn.textContent = "Saving...";
    btn.disabled = true;

    try {
      if (type === "console" && selected) {
        await chrome.runtime.sendMessage({
          type: "ADD_CONSOLE_CHECKPOINT",
          logMessage: selected.message,
          label
        });
      } else if (type === "network" && selected) {
        await chrome.runtime.sendMessage({
          type: "ADD_NETWORK_CHECKPOINT",
          networkUrl: selected.url,
          networkMethod: selected.method,
          networkStatus: selected.status,
          label
        });
      }

      // Keep the dialog open so the user can add more checkpoints.
      // Just reset the selection and input, and show brief inline feedback.
      input.value = "";
      DIALOGS[type].selected = null;

      // Deselect highlighted row
      const list = document.getElementById(DIALOGS[type].id)?.querySelector(".__wf_logs_list__");
      if (list) {
        list.querySelectorAll(".__wf_logs_item__--selected").forEach(el => el.classList.remove("__wf_logs_item__--selected"));
      }

      btn.textContent = "Checkpoint Added!";
      btn.style.background = "#16a34a";
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = "Add Checkpoint";
        btn.style.background = "";
        btn.disabled = true; // stays disabled until a new item is selected
      }, 1500);
      return;

    } catch (err) {
      console.warn("Failed to add checkpoint:", err);
    }

    btn.textContent = "Add Checkpoint";
  }

  // ─── Listeners ────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      if (msg.type === "SYNC_DIALOG_STATE") {
        if (msg.consoleOpen) showDialog("console");
        else hideDialog("console");

        if (msg.networkOpen) showDialog("network");
        else hideDialog("network");

        sendResponse({ ok: true });
      } else if (msg.type === "CLOSE_ALL_DIALOGS") {
        // Remove dialog elements entirely from this tab
        const cd = document.getElementById(DIALOGS.console.id);
        if (cd) cd.remove();
        const nd = document.getElementById(DIALOGS.network.id);
        if (nd) nd.remove();
        DIALOGS.console.items = [];
        DIALOGS.console.selected = null;
        DIALOGS.network.items = [];
        DIALOGS.network.selected = null;
        sendResponse({ ok: true });
      } else if (msg.type === "CLEAR_DIALOG_CONTENT") {
        // On tab switch: reuse existing dialogs, just clear their content
        DIALOGS.console.items = [];
        DIALOGS.console.selected = null;
        DIALOGS.network.items = [];
        DIALOGS.network.selected = null;
        renderList("console");
        renderList("network");
        sendResponse({ ok: true });
      } else if (msg.type === "NETWORK_CALL_LIVE") {
        DIALOGS.network.items.push(msg.call);
        if (DIALOGS.network.items.length > 20) {
          DIALOGS.network.items = DIALOGS.network.items.slice(-20);
        }
        const dialog = document.getElementById(DIALOGS.network.id);
        if (dialog && dialog.style.display === "flex") {
          renderList("network");
          const body = dialog.querySelector(".__wf_logs_list__")?.parentElement;
          if (body && body.scrollHeight - body.scrollTop - body.clientHeight < 50) {
            body.scrollTop = body.scrollHeight;
          }
        }
        sendResponse({ ok: true });
      }
    } catch (e) {}
    return false;
  });

  // Real-time console log updates via postMessage from page-interceptor.js (MAIN world).
  window.addEventListener("message", (e) => {
    if (!e.data || e.data.__wfSrc !== "__wf_interceptor__") return;

    if (e.data.type === "console_log") {
      DIALOGS.console.items.push({
        message: e.data.message,
        timestamp: e.data.timestamp,
        url: window.location.href,
      });
      if (DIALOGS.console.items.length > 20) {
        DIALOGS.console.items = DIALOGS.console.items.slice(-20);
      }

      const dialog = document.getElementById(DIALOGS.console.id);
      if (dialog && dialog.style.display === "flex") {
        renderList("console");
        const body = dialog.querySelector(".__wf_logs_list__")?.parentElement;
        if (body && body.scrollHeight - body.scrollTop - body.clientHeight < 50) {
          body.scrollTop = body.scrollHeight;
        }
      }
    }
    // network_call postMessages are no longer sent — network capture is handled via
    // chrome.webRequest in the service worker, which sends NETWORK_CALL_LIVE messages.
  });

})();

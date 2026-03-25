/**
 * Content Script - Logs Dialog Overlay
 *
 * Injects resizable, draggable UI overlays for Console and Network logs.
 * They run independently and can be on-screen at the same time.
 *
 * Strategy:
 * - Console logs: listened via CustomEvent("__wf_console_log__") from page-interceptor.js (MAIN world)
 * - Network calls: listened via CustomEvent("__wf_network_call__") from page-interceptor.js (MAIN world)
 * - On dialog open, buffers are seeded directly from window.__wfConsoleLogs / window.__wfNetCalls
 *   (no round-trip to the service worker)
 * - Network rows show full request/response details in a collapsible panel on selection
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
    const topPx   = type === "console" ? 50  : 110;
    const rightPx = type === "console" ? 50  : 80;

    dialog.style.cssText = `
      position: fixed;
      top: ${topPx}px;
      right: ${rightPx}px;
      width: 480px;
      height: 560px;
      min-width: 320px;
      min-height: 260px;
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

    // ── Header ──────────────────────────────────────────────────────────────
    const header = document.createElement("div");
    header.style.cssText = `
      padding: 10px 14px;
      background: #1f2937;
      border-bottom: 1px solid #374151;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: grab;
      user-select: none;
      gap: 8px;
    `;

    const title = document.createElement("div");
    title.style.cssText = "font-weight: 600; font-size: 13px; color: #e5e7eb; flex: 1;";
    title.textContent = config.title;

    const countBadge = document.createElement("span");
    countBadge.id = config.id + "_count";
    countBadge.style.cssText = "font-size: 10px; background: #374151; color: #9ca3af; padding: 1px 6px; border-radius: 10px;";
    countBadge.textContent = "0";

    const clearBtn = document.createElement("button");
    clearBtn.textContent = "Clear";
    clearBtn.style.cssText = `
      background: transparent; border: 1px solid #374151; color: #9ca3af;
      font-size: 11px; padding: 2px 8px; border-radius: 4px; cursor: pointer;
    `;
    clearBtn.onclick = () => {
      DIALOGS[type].items = [];
      DIALOGS[type].selected = null;
      // Also clear the in-page buffer so new ones start fresh
      if (type === "console") { try { window.__wfConsoleLogs = []; } catch(_) {} }
      else { try { window.__wfNetCalls = []; } catch(_) {} }
      renderList(type);
    };

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.style.cssText = `
      background: transparent; border: none; color: #9ca3af;
      font-size: 20px; cursor: pointer; line-height: 1; padding: 0;
    `;
    closeBtn.onclick = () => {
      dialog.style.display = "none";
      const action = type === "console" ? "CLOSE_CONSOLE_DIALOG" : "CLOSE_NETWORK_DIALOG";
      try { chrome.runtime.sendMessage({ type: action }).catch(() => {}); } catch (err) {}
    };

    header.appendChild(title);
    header.appendChild(countBadge);
    header.appendChild(clearBtn);
    header.appendChild(closeBtn);

    // ── Drag ────────────────────────────────────────────────────────────────
    let isDragging = false, dragStartX, dragStartY, initialLeft, initialTop;
    header.addEventListener("mousedown", (e) => {
      if (e.target === clearBtn || e.target === closeBtn) return;
      isDragging = true;
      header.style.cursor = "grabbing";
      dialog.style.zIndex = "2147483648";
      const other = document.getElementById(DIALOGS[type === "console" ? "network" : "console"].id);
      if (other) other.style.zIndex = "2147483647";
      dragStartX = e.clientX; dragStartY = e.clientY;
      const rect = dialog.getBoundingClientRect();
      initialLeft = rect.left; initialTop = rect.top;
    });
    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      dialog.style.left  = `${initialLeft + (e.clientX - dragStartX)}px`;
      dialog.style.top   = `${initialTop  + (e.clientY - dragStartY)}px`;
      dialog.style.right = "auto";
    });
    document.addEventListener("mouseup", () => { isDragging = false; header.style.cursor = "grab"; });

    // ── Body — list + detail pane ────────────────────────────────────────────
    const body = document.createElement("div");
    body.style.cssText = "flex: 1; display: flex; flex-direction: column; overflow: hidden;";

    const listContainer = document.createElement("div");
    listContainer.className = "__wf_logs_list__";
    listContainer.style.cssText = "flex: 1; overflow-y: auto; display: flex; flex-direction: column;";

    // Detail panel (hidden by default, shown on network row selection)
    const detailPanel = document.createElement("div");
    detailPanel.id = config.id + "_detail";
    detailPanel.style.cssText = `
      display: none;
      max-height: 200px;
      overflow-y: auto;
      border-top: 1px solid #374151;
      background: #0d1117;
      font-family: monospace;
      font-size: 11px;
      color: #c9d1d9;
      padding: 10px 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
    `;

    body.appendChild(listContainer);
    body.appendChild(detailPanel);

    // ── Footer ───────────────────────────────────────────────────────────────
    const footer = document.createElement("div");
    footer.style.cssText = `
      padding: 10px 14px;
      border-top: 1px solid #374151;
      background: #1f2937;
      display: flex;
      flex-direction: column;
      gap: 8px;
    `;

    const inputWrap = document.createElement("div");
    inputWrap.style.cssText = "display: flex; gap: 8px;";

    const labelInput = document.createElement("input");
    labelInput.className = "__wf_logs_label_input__";
    labelInput.type = "text";
    labelInput.placeholder = "Checkpoint label (optional)";
    labelInput.style.cssText = `
      flex: 1; background: #374151; border: 1px solid #4b5563;
      color: #f3f4f6; border-radius: 4px; padding: 6px 10px; font-size: 12px; outline: none;
    `;

    const addBtn = document.createElement("button");
    addBtn.className = "__wf_logs_add_btn__";
    addBtn.textContent = "Add Checkpoint";
    addBtn.disabled = true;
    addBtn.style.cssText = `
      background: #2563eb; color: #fff; border: none; border-radius: 4px;
      padding: 6px 12px; font-size: 12px; font-weight: 500; cursor: pointer;
      opacity: 0.5; transition: background 0.2s, opacity 0.2s; white-space: nowrap;
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

  // ─── Detail panel rendering ───────────────────────────────────────────────

  function formatDetail(item) {
    const lines = [];
    lines.push(`URL:     ${item.url || ""}`);
    lines.push(`Method:  ${item.method || "GET"}`);
    lines.push(`Status:  ${item.status || 0} ${item.statusText || ""}`);

    if (item.requestHeaders && Object.keys(item.requestHeaders).length) {
      lines.push("\n── Request Headers ──────────────────");
      Object.entries(item.requestHeaders).forEach(([k, v]) => lines.push(`  ${k}: ${v}`));
    }
    if (item.requestBody) {
      lines.push("\n── Request Body ─────────────────────");
      let body = item.requestBody;
      try { body = JSON.stringify(JSON.parse(body), null, 2); } catch (_) {}
      lines.push(body.length > 2000 ? body.slice(0, 2000) + "\n…(truncated)" : body);
    }
    if (item.responseHeaders && Object.keys(item.responseHeaders).length) {
      lines.push("\n── Response Headers ─────────────────");
      Object.entries(item.responseHeaders).forEach(([k, v]) => lines.push(`  ${k}: ${v}`));
    }
    if (item.responseBody != null) {
      lines.push("\n── Response Body ────────────────────");
      let body = item.responseBody;
      try { body = JSON.stringify(JSON.parse(body), null, 2); } catch (_) {}
      lines.push(body.length > 3000 ? body.slice(0, 3000) + "\n…(truncated)" : body);
    }
    return lines.join("\n");
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  function renderList(type) {
    const dialog = document.getElementById(DIALOGS[type].id);
    if (!dialog) return;

    const list = dialog.querySelector(".__wf_logs_list__");
    if (!list) return;

    // Update count badge
    const badge = document.getElementById(DIALOGS[type].id + "_count");
    if (badge) badge.textContent = String(DIALOGS[type].items.length);

    list.innerHTML = "";

    const items    = DIALOGS[type].items;
    const selected = DIALOGS[type].selected;
    const detailEl = document.getElementById(DIALOGS[type].id + "_detail");

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = type === "console" ? "No console logs captured." : "No network calls captured.";
      empty.style.cssText = "padding: 20px; text-align: center; color: #9ca3af; font-size: 13px; font-style: italic;";
      list.appendChild(empty);
      if (detailEl) detailEl.style.display = "none";
      updateFooterState(type);
      return;
    }

    items.forEach((item) => {
      const isSelected = (selected === item);
      const row = document.createElement("div");
      row.style.cssText = `
        padding: 7px 12px;
        border-bottom: 1px solid #1f2937;
        font-size: 11px;
        cursor: pointer;
        display: flex;
        align-items: flex-start;
        gap: 7px;
        background: ${isSelected ? "#1e3a8a" : "transparent"};
        transition: background 0.12s;
        word-break: break-all;
      `;
      row.onmouseover = () => { if (!isSelected) row.style.background = "#1f2937"; };
      row.onmouseout  = () => { if (!isSelected) row.style.background = "transparent"; };
      row.onclick = () => {
        DIALOGS[type].selected = item;
        renderList(type);
        // Show detail panel for network
        if (type === "network" && detailEl) {
          detailEl.textContent = formatDetail(item);
          detailEl.style.display = "block";
        }
      };

      const time = new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

      if (type === "console") {
        const levelColors = { warn: "#fbbf24", error: "#f87171", info: "#60a5fa", debug: "#9ca3af" };
        const levelColor = levelColors[item.level] || "#d1d5db";
        const badge = document.createElement("span");
        badge.textContent = (item.level || "log").toUpperCase().slice(0, 4);
        badge.style.cssText = `font-size: 9px; font-weight: 700; padding: 2px 4px; border-radius: 3px; background: #374151; color: ${levelColor}; flex-shrink: 0; margin-top: 1px;`;

        const msgStr = String(item.message || "");
        const msg = document.createElement("span");
        msg.textContent = msgStr.length > 120 ? msgStr.slice(0, 118) + "…" : msgStr;
        msg.style.cssText = `flex: 1; color: ${levelColor};`;

        const timeNode = document.createElement("span");
        timeNode.textContent = time;
        timeNode.style.cssText = "color: #6b7280; font-size: 10px; flex-shrink: 0; margin-top: 1px;";

        row.appendChild(badge);
        row.appendChild(msg);
        row.appendChild(timeNode);
      } else {
        // Network row
        const methodStr = String(item.method || "GET");
        const methodColors = { GET: "#3b82f6", POST: "#10b981", PUT: "#f59e0b", PATCH: "#f59e0b", DELETE: "#ef4444" };
        const methodColor = methodColors[methodStr] || "#6b7280";

        const method = document.createElement("span");
        method.textContent = methodStr;
        method.style.cssText = `font-size: 9px; font-weight: 700; padding: 2px 5px; border-radius: 3px; background: ${methodColor}22; border: 1px solid ${methodColor}55; color: ${methodColor}; flex-shrink: 0; margin-top: 1px;`;

        const urlStr  = String(item.url || "");
        const urlInfo = document.createElement("span");
        // Show path part only for brevity
        let displayUrl = urlStr;
        try { displayUrl = new URL(urlStr).pathname + new URL(urlStr).search; } catch (_) {}
        urlInfo.textContent = displayUrl.length > 70 ? "…" + displayUrl.slice(-68) : displayUrl;
        urlInfo.title = urlStr;
        urlInfo.style.cssText = "flex: 1; color: #e5e7eb; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";

        const statusColor = item.status >= 400 ? "#ef4444" : item.status >= 300 ? "#f59e0b" : item.status >= 200 ? "#10b981" : "#9ca3af";
        const status = document.createElement("span");
        status.textContent = item.status || "---";
        status.style.cssText = `font-size: 10px; font-weight: 700; color: ${statusColor}; flex-shrink: 0; min-width: 26px; text-align: right;`;

        const timeNode = document.createElement("span");
        timeNode.textContent = time;
        timeNode.style.cssText = "color: #6b7280; font-size: 10px; flex-shrink: 0;";

        row.appendChild(method);
        row.appendChild(urlInfo);
        row.appendChild(status);
        row.appendChild(timeNode);

        // Expand icon hint when selected
        if (isSelected) {
          const hint = document.createElement("span");
          hint.textContent = "▼";
          hint.style.cssText = "color: #60a5fa; font-size: 9px; flex-shrink: 0; margin-top: 2px;";
          row.appendChild(hint);
        }
      }

      list.appendChild(row);
    });

    if (type === "network" && selected && detailEl && detailEl.style.display === "none") {
      detailEl.style.display = "none"; // keep hidden if deselected
    }

    updateFooterState(type);
  }

  function updateFooterState(type) {
    const dialog = document.getElementById(DIALOGS[type].id);
    if (!dialog) return;
    const btn = dialog.querySelector(".__wf_logs_add_btn__");
    if (!btn) return;
    const has = !!DIALOGS[type].selected;
    btn.disabled = !has;
    btn.style.opacity = has ? "1" : "0.5";
    btn.style.cursor  = has ? "pointer" : "not-allowed";
  }

  // ─── Core Logic & Interactivity ───────────────────────────────────────────

  function showDialog(type) {
    const dialog = createDialog(type);
    dialog.style.display = "flex";
    dialog.style.zIndex  = "2147483648";
    const other = document.getElementById(DIALOGS[type === "console" ? "network" : "console"].id);
    if (other) other.style.zIndex = "2147483647";

    // Render whatever has already been accumulated via postMessage since recording started.
    // (window.__wfConsoleLogs / window.__wfNetCalls live in MAIN world and are not directly
    //  readable here in the ISOLATED world — postMessage is the only cross-world bridge.)
    renderList(type);

    // Auto-scroll to bottom
    setTimeout(() => {
      const list = dialog.querySelector(".__wf_logs_list__");
      if (list) list.scrollTop = list.scrollHeight;
    }, 20);
  }

  function hideDialog(type) {
    const dialog = document.getElementById(DIALOGS[type].id);
    if (dialog) dialog.style.display = "none";
  }

  async function handleAddCheckpoint(type) {
    const dialog   = document.getElementById(DIALOGS[type].id);
    const input    = dialog.querySelector(".__wf_logs_label_input__");
    const label    = input.value.trim() || null;
    const btn      = dialog.querySelector(".__wf_logs_add_btn__");
    const selected = DIALOGS[type].selected;

    btn.textContent = "Saving…";
    btn.disabled = true;

    try {
      if (type === "console" && selected) {
        await chrome.runtime.sendMessage({
          type: "ADD_CONSOLE_CHECKPOINT",
          logMessage: selected.message,
          label,
        });
      } else if (type === "network" && selected) {
        await chrome.runtime.sendMessage({
          type: "ADD_NETWORK_CHECKPOINT",
          networkUrl: selected.url,
          networkMethod: selected.method,
          networkStatus: selected.status,
          // Pass full details so the checkpoint event stores them
          networkRequestBody: selected.requestBody || null,
          label,
        });
      }

      input.value = "";
      DIALOGS[type].selected = null;
      const detailEl = document.getElementById(DIALOGS[type].id + "_detail");
      if (detailEl) detailEl.style.display = "none";

      btn.textContent = "Checkpoint Added!";
      btn.style.background = "#16a34a";
      setTimeout(() => {
        btn.textContent = "Add Checkpoint";
        btn.style.background = "";
        btn.disabled = true;
      }, 1500);
      return;
    } catch (err) {
      console.warn("Failed to add checkpoint:", err);
    }

    btn.textContent = "Add Checkpoint";
  }

  // ─── Listeners ────────────────────────────────────────────────────────────

  // Service worker messages (dialog open/close sync, and legacy fallback)
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      if (msg.type === "SYNC_DIALOG_STATE") {
        if (msg.consoleOpen) showDialog("console"); else hideDialog("console");
        if (msg.networkOpen) showDialog("network"); else hideDialog("network");
        sendResponse({ ok: true });
      } else if (msg.type === "CLOSE_ALL_DIALOGS") {
        ["console", "network"].forEach(t => {
          document.getElementById(DIALOGS[t].id)?.remove();
          DIALOGS[t].items = [];
          DIALOGS[t].selected = null;
        });
        sendResponse({ ok: true });
      } else if (msg.type === "CLEAR_DIALOG_CONTENT") {
        ["console", "network"].forEach(t => {
          DIALOGS[t].items = [];
          DIALOGS[t].selected = null;
          renderList(t);
        });
        sendResponse({ ok: true });
      }
    } catch (e) {}
    return false;
  });

  // Real-time updates via window.postMessage from page-interceptor.js (MAIN world).
  // postMessage is the only API that crosses the MAIN→ISOLATED world boundary.
  // CustomEvent fired in MAIN world is invisible here in the ISOLATED world.
  window.addEventListener("message", (e) => {
    if (!e.data || e.data.__wfSrc !== "__wf_interceptor__") return;

    if (e.data.type === "console_log") {
      const entry = {
        message:   e.data.message,
        level:     e.data.level || "log",
        timestamp: e.data.timestamp,
        url:       e.data.url || window.location.href,
      };
      DIALOGS.console.items.push(entry);
      if (DIALOGS.console.items.length > 200) DIALOGS.console.items.shift();

      const dialog = document.getElementById(DIALOGS.console.id);
      if (dialog && dialog.style.display === "flex") {
        renderList("console");
        const list = dialog.querySelector(".__wf_logs_list__");
        if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 60) {
          list.scrollTop = list.scrollHeight;
        }
      }
    } else if (e.data.type === "network_call") {
      const entry = {
        url:             e.data.url,
        method:          e.data.method,
        status:          e.data.status,
        statusText:      e.data.statusText,
        requestHeaders:  e.data.requestHeaders  || {},
        requestBody:     e.data.requestBody     || null,
        responseHeaders: e.data.responseHeaders || {},
        responseBody:    e.data.responseBody    || null,
        timestamp:       e.data.timestamp,
      };
      DIALOGS.network.items.push(entry);
      if (DIALOGS.network.items.length > 200) DIALOGS.network.items.shift();

      const dialog = document.getElementById(DIALOGS.network.id);
      if (dialog && dialog.style.display === "flex") {
        renderList("network");
        const list = dialog.querySelector(".__wf_logs_list__");
        if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 60) {
          list.scrollTop = list.scrollHeight;
        }
      }
    }
  });

})();

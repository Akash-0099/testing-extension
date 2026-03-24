/**
 * Content Script — Player
 * 
 * Strategy:
 * Injected into the active page frame during playback, this script provides the visual 
 * overlay (HUD) so the user knows an automated workflow is currently running.
 * It does not execute the actual DOM events (which are done via eval injected by the SW),
 * but solely handles UI feedback to keep the user informed of progress.
 */

(function () {
  "use strict";

  // Strategy: Detect stale extension context after reload.
  // If the user navigates or the page reloads, the script prevents re-initialization
  // collisions while ensuring the variables are properly registered.
  let runtimeConnected = false;
  try {
    runtimeConnected = !!(chrome.runtime && chrome.runtime.id);
  } catch (e) {
    // Context invalidated
  }
  if (window.__workflowPlayerLoaded && runtimeConnected) return;
  window.__workflowPlayerLoaded = true;

  // ─── HUD overlay ──────────────────────────────────────────────────────────

  const HUD_ID = "__workflow_player_hud__";

  /**
   * Renders and updates the visual Progress HUD.
   *
   * Strategy:
   * Dynamically constructs the HUD DOM nodes on first call, injecting them fixed to the bottom-right 
   * of the viewport. Uses robust inline CSS to bypass potential page stylesheet conflicts. Subsequent 
   * calls simply update the text content and progress bar width rather than rebuilding the DOM, 
   * ensuring smooth 60fps animations.
   *
   * @param {string} label - Text describing the current playback step.
   * @param {number} progress - The current step index.
   * @param {number} total - The total number of steps in the workflow.
   */
  function showHUD(label, progress, total) {
    let hud = document.getElementById(HUD_ID);
    if (!hud) {
      hud = document.createElement("div");
      hud.id = HUD_ID;
      hud.style.cssText = `
        position: fixed;
        bottom: 16px;
        right: 16px;
        z-index: 2147483647;
        background: rgba(17, 24, 39, 0.95);
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 12px;
        padding: 10px 14px;
        border-radius: 10px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.4);
        min-width: 200px;
        max-width: 280px;
      `;

      const titleRow = document.createElement("div");
      titleRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:6px;";

      const dot = document.createElement("span");
      dot.style.cssText = `
        width:8px;height:8px;border-radius:50%;
        background:#22c55e;flex-shrink:0;
        animation:__wf_play_pulse__ 1.2s infinite;
      `;

      if (!document.getElementById("__wf_play_style__")) {
        const style = document.createElement("style");
        style.id = "__wf_play_style__";
        style.textContent = `
          @keyframes __wf_play_pulse__ {0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.5;transform:scale(0.8)}}
          #__wf_stop_btn__:hover { background: rgba(220,38,38,0.9) !important; }
        `;
        document.head.appendChild(style);
      }

      const titleText = document.createElement("span");
      titleText.id = "__wf_hud_title__";
      titleText.style.cssText = "font-weight:600;font-size:11px;color:#d1d5db;letter-spacing:0.5px;";
      titleText.textContent = "PLAYING";

      titleRow.appendChild(dot);
      titleRow.appendChild(titleText);

      const stepText = document.createElement("div");
      stepText.id = "__wf_hud_step__";
      stepText.style.cssText = "color:#e5e7eb;font-size:12px;margin-bottom:8px;line-height:1.4;word-break:break-word;";

      const barWrap = document.createElement("div");
      barWrap.style.cssText = "background:rgba(255,255,255,0.12);border-radius:4px;height:4px;overflow:hidden;margin-bottom:10px;";
      const bar = document.createElement("div");
      bar.id = "__wf_hud_bar__";
      bar.style.cssText = "height:100%;background:#22c55e;border-radius:4px;transition:width 0.3s ease;width:0%;";
      barWrap.appendChild(bar);

      // ─── Stop button ─────────────────────────────────────────
      const stopBtn = document.createElement("button");
      stopBtn.id = "__wf_stop_btn__";
      stopBtn.textContent = "⏹ Stop Workflow";
      stopBtn.style.cssText = `
        display:block;width:100%;
        padding:6px 0;border:none;border-radius:6px;
        background:rgba(220,38,38,0.7);color:#fff;
        font-family:inherit;font-size:12px;font-weight:600;
        cursor:pointer;letter-spacing:0.3px;
        transition:background 0.15s ease;
      `;
      stopBtn.addEventListener("click", () => {
        try {
          chrome.runtime.sendMessage({ type: "STOP_PLAYBACK" }, () => {
            void chrome.runtime.lastError;
          });
          hideHUD();
        } catch (e) {
          // Ignore context invalidated error
        }
      });

      hud.appendChild(titleRow);
      hud.appendChild(stepText);
      hud.appendChild(barWrap);
      hud.appendChild(stopBtn);
      document.body.appendChild(hud);
    }

    const stepEl = document.getElementById("__wf_hud_step__");
    const barEl = document.getElementById("__wf_hud_bar__");

    if (stepEl) stepEl.textContent = label || "Running…";
    if (barEl && total > 0) barEl.style.width = `${Math.round((progress / total) * 100)}%`;
  }

  /**
   * Removes the active Progress HUD.
   *
   * Strategy:
   * Safely targets the exact HUD ID and removes it from the document, cleaning up the DOM
   * once the workflow finishes or is aborted.
   */
  function hideHUD() {
    document.getElementById(HUD_ID)?.remove();
  }

  /**
   * Displays the Failure HUD and auto-removes it after 4 seconds.
   */
  function showFailureHUD(reason) {
    let hud = document.getElementById(HUD_ID);
    if (!hud) return;

    const titleText = document.getElementById("__wf_hud_title__");
    if (titleText) {
      titleText.textContent = "FAILED";
      titleText.style.color = "#f87171";
    }

    const dot = hud.querySelector("span");
    if (dot) {
      dot.style.background = "#ef4444";
      dot.style.animation = "none";
    }

    const stepEl = document.getElementById("__wf_hud_step__");
    if (stepEl) {
      stepEl.textContent = reason || "Execution failed on this step.";
    }

    const barEl = document.getElementById("__wf_hud_bar__");
    if (barEl) {
      barEl.style.background = "#ef4444";
    }

    const stopBtn = document.getElementById("__wf_stop_btn__");
    if (stopBtn) stopBtn.remove();

    setTimeout(hideHUD, 4000);
  }

  /**
   * Displays a visual flash and badge when a checkpoint is taken.
   *
   * Strategy:
   * Generates a full-screen semi-transparent overlay that fades out rapidly via CSS keyframes, 
   * mimicking a camera shutter. Concurrently displays a centered badge to confirm the checkpoint 
   * was successfully recorded during playback. Cleans up DOM nodes immediately after animations 
   * complete.
   *
   * @param {string} label - The label of the captured checkpoint.
   */
  function showCheckpointFlash(label) {
    const flash = document.createElement("div");
    flash.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      z-index: 2147483646;
      background: rgba(255,255,255,0.15);
      pointer-events: none;
      animation: __wf_flash__ 0.4s ease-out forwards;
    `;

    if (!document.getElementById("__wf_flash_style__")) {
      const style = document.createElement("style");
      style.id = "__wf_flash_style__";
      style.textContent = `@keyframes __wf_flash__ {0%{opacity:1}100%{opacity:0}}`;
      document.head.appendChild(style);
    }

    document.body.appendChild(flash);
    setTimeout(() => flash.remove(), 450);

    // Show checkpoint badge
    const badge = document.createElement("div");
    badge.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 2147483647;
      background: rgba(17,24,39,0.92);
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      font-weight: 600;
      padding: 10px 20px;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
      pointer-events: none;
      display: flex;
      align-items: center;
      gap: 8px;
      animation: __wf_flash__ 1.2s ease-out forwards;
    `;
    badge.innerHTML = `<span style="color:#facc15;font-size:16px;">📸</span> ${label || "Checkpoint"}`;
    document.body.appendChild(badge);
    setTimeout(() => badge.remove(), 1200);
  }

  // ─── Message listener ──────────────────────────────────────────────────────

  /**
   * Listens for HUD commands from the Service Worker.
   *
   * Strategy:
   * Acts as the single message bus for the player interface. Interprets commands to update the HUD 
   * progress, trigger camera flashes, or destroy the HUD. Always returns `false` since it operates 
   * synchronously and needs no kept-alive connection.
   */
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      try {
        switch (msg.type) {
          case "PLAYBACK_HUD_UPDATE":
            showHUD(msg.label, msg.progress, msg.total);
            sendResponse({ ok: true });
            break;

          case "PLAYBACK_CHECKPOINT_FLASH":
            showCheckpointFlash(msg.label);
            sendResponse({ ok: true });
            break;

          case "PLAYBACK_HUD_FAIL":
            showFailureHUD(msg.reason);
            sendResponse({ ok: true });
            break;

          case "PLAYBACK_HUD_HIDE":
            hideHUD();
            sendResponse({ ok: true });
            break;

          default:
            break;
        }
      } catch (err) {
        // Catch DOM exceptions when context is invalidated mid-execution
      }
      return false;
    });
  } catch (e) {
    // Context invalidated during registration
  }

})();

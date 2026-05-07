// ==UserScript==
// @name         Bilibili 动态评论批量点赞助手
// @namespace    tabbit.local
// @version      1.0
// @description  穿透 open Shadow DOM 扫描 B 站动态评论点赞按钮；识别已点赞/未点赞，按位置全扫描，防止滑动过头漏点；支持拖拽定位与快速点赞。
// @author       BaiyiRyis
// @match        https://t.bilibili.com/*
// @match        https://www.bilibili.com/opus/*
// @run-at       document-idle
// @icon         https://www.bilibili.com/favicon.ico
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    debug: true,

    // 速度参数
    clickDelayMin: 220,
    clickDelayMax: 420,
    beforeClickDelay: 60,
    afterClickCheckDelay: 320,

    // 小步滚动，防止越过未处理评论
    scrollStepMin: 260,
    scrollStepMax: 420,
    scrollDelay: 420,

    // 连续多少轮没发现新可处理按钮则结束
    idleRoundsToStop: 6,

    // 最大总轮次
    maxRounds: 260,

    // 已点赞蓝色判定
    likedBlueHex: "#00aeec",

    // 面板位置缓存
    panelStorageKey: "bili_comment_like_helper_panel_pos_v6_3",

    // 防止误扫顶部区域
    minTop: 80,
    minLeft: 80
  };

  let running = false;
  let likedCount = 0;
  let roundCount = 0;
  let lastCandidateCount = 0;
  let currentTaskText = "待开始";
  let idleRounds = 0;

  const clickedButtons = new WeakSet();
  const attemptedButtons = new WeakSet();

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function randomInt(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  function log() {
    if (!CONFIG.debug) return;
    const args = Array.prototype.slice.call(arguments);
    args.unshift("[Bili 评论点赞助手 V6.3]");
    console.log.apply(console, args);
  }

  function textOf(el) {
    return (el && (el.innerText || el.textContent) || "").replace(/\s+/g, " ").trim();
  }

  function isDigits(text) {
    if (!text) return false;
    return !/[^0-9]/.test(String(text));
  }

  function clamp(n, min, max) {
    return Math.min(Math.max(n, min), max);
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.pointerEvents !== "none"
    );
  }

  function normalizeColorString(color) {
    return String(color || "").replace(/\s+/g, "").toLowerCase();
  }

  function rgbToHex(r, g, b) {
    const toHex = function (n) {
      return Number(n).toString(16).padStart(2, "0");
    };
    return "#" + toHex(r) + toHex(g) + toHex(b);
  }

  function parseRgb(color) {
    const m = normalizeColorString(color).match(/rgba?\((\d+),(\d+),(\d+)/);
    if (!m) return null;
    return {
      r: Number(m[1]),
      g: Number(m[2]),
      b: Number(m[3]),
      hex: rgbToHex(m[1], m[2], m[3])
    };
  }

  function colorNear(a, b, tolerance) {
    if (!a || !b) return false;
    return (
      Math.abs(a.r - b.r) <= tolerance &&
      Math.abs(a.g - b.g) <= tolerance &&
      Math.abs(a.b - b.b) <= tolerance
    );
  }

  function getAllOpenRoots(startRoot) {
    const roots = [];
    const seen = new WeakSet();

    function walkRoot(root) {
      if (!root || seen.has(root)) return;
      seen.add(root);
      roots.push(root);

      const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
      for (const el of all) {
        if (el.shadowRoot) {
          walkRoot(el.shadowRoot);
        }
      }
    }

    walkRoot(startRoot || document);
    return roots;
  }

  function getThumbsupIcon(btn) {
    const icons = Array.from(btn.querySelectorAll ? btn.querySelectorAll("bili-icon") : []);
    return icons.find(function (icon) {
      const name = icon.getAttribute("icon") || "";
      return /thumbsup/i.test(name);
    });
  }

  function getCountNode(btn) {
    if (!btn || !btn.querySelector) return null;
    return (
      btn.querySelector("span#count") ||
      btn.querySelector('span[id="count"]') ||
      btn.querySelector("#count")
    );
  }

  function getButtonColor(btn) {
    return normalizeColorString(getComputedStyle(btn).color || "");
  }

  function getIconColor(btn) {
    const icon = getThumbsupIcon(btn);
    if (!icon) return "";

    const iconStyleColor = normalizeColorString(getComputedStyle(icon).color || "");
    if (iconStyleColor) return iconStyleColor;

    const svg =
      icon.shadowRoot &&
      (icon.shadowRoot.querySelector("#icon") ||
       icon.shadowRoot.querySelector("svg") ||
       icon.shadowRoot.querySelector("path"));

    if (svg) {
      const svgColor = normalizeColorString(getComputedStyle(svg).color || "");
      const fill = normalizeColorString(getComputedStyle(svg).fill || "");
      return svgColor || fill || "";
    }

    return "";
  }

  function getLikeStateInfo(btn) {
    const cls = String(btn.className || "").toLowerCase();
    const ariaPressed = btn.getAttribute ? btn.getAttribute("aria-pressed") : "";
    const ariaLabel = btn.getAttribute ? btn.getAttribute("aria-label") || "" : "";
    const title = btn.getAttribute ? btn.getAttribute("title") || "" : "";

    const icon = getThumbsupIcon(btn);
    const iconName = icon ? icon.getAttribute("icon") || "" : "";

    const buttonColor = parseRgb(getButtonColor(btn));
    const iconColor = parseRgb(getIconColor(btn));
    const likedBlue = parseRgb("rgb(0,174,236)");

    const byAria =
      ariaPressed === "true" ||
      /已点赞|取消点赞/.test(ariaLabel) ||
      /已点赞|取消点赞/.test(title);

    const byClass =
      cls.indexOf("liked") >= 0 ||
      cls.indexOf("active") >= 0 ||
      cls.indexOf("is-active") >= 0;

    const byIconName =
      /thumbsup_fill|hand_thumbsup_fill/i.test(iconName);

    const byColor =
      colorNear(buttonColor, likedBlue, 20) ||
      colorNear(iconColor, likedBlue, 20);

    const liked = byAria || byClass || byIconName || byColor;

    return {
      liked: liked,
      byAria: byAria,
      byClass: byClass,
      byIconName: byIconName,
      byColor: byColor,
      buttonColor: buttonColor ? buttonColor.hex : "",
      iconColor: iconColor ? iconColor.hex : "",
      iconName: iconName
    };
  }

  function isButtonUiLiked(btn) {
    return getLikeStateInfo(btn).liked;
  }

  function isAlreadyLiked(btn) {
    if (clickedButtons.has(btn)) return true;
    return isButtonUiLiked(btn);
  }

  function isScriptOwnButton(btn) {
    return Boolean(
      btn.closest &&
      (
        btn.closest("#bili-comment-like-helper-panel") ||
        btn.id === "bili-like-helper-start" ||
        btn.id === "bili-like-helper-stop"
      )
    );
  }

  function isUnsafeArea(btn) {
    const rect = btn.getBoundingClientRect();

    if (rect.top < CONFIG.minTop) return true;
    if (rect.left < CONFIG.minLeft) return true;

    if (btn.closest && btn.closest(".bili-header")) return true;
    if (btn.closest && btn.closest(".custom-navbar")) return true;
    if (btn.closest && btn.closest(".side-toolbar")) return true;
    if (btn.closest && btn.closest("#bili-comment-like-helper-panel")) return true;

    return false;
  }

  function isCommentLikeButton(btn) {
    if (!btn || btn.tagName !== "BUTTON") return false;
    if (!isVisible(btn)) return false;
    if (isScriptOwnButton(btn)) return false;
    if (isUnsafeArea(btn)) return false;

    const icon = getThumbsupIcon(btn);
    if (!icon) return false;

    const countNode = getCountNode(btn);
    const countText = textOf(countNode);
    const buttonText = textOf(btn);

    if (countNode && isDigits(countText)) return true;
    if (isDigits(buttonText)) return true;

    return false;
  }

  function getButtonSignature(btn) {
    const rect = btn.getBoundingClientRect();
    const icon = getThumbsupIcon(btn);
    return [
      Math.round(rect.left),
      Math.round(rect.top + window.scrollY),
      Math.round(rect.width),
      Math.round(rect.height),
      textOf(btn),
      icon ? icon.getAttribute("icon") || "" : ""
    ].join("|");
  }

  function collectLikeButtons() {
    const roots = getAllOpenRoots(document);
    const result = [];
    const seen = new Set();

    for (const root of roots) {
      const buttons = Array.from(root.querySelectorAll ? root.querySelectorAll("button") : []);

      for (const btn of buttons) {
        if (!isCommentLikeButton(btn)) continue;
        if (attemptedButtons.has(btn)) continue;
        if (isAlreadyLiked(btn)) continue;

        const key = getButtonSignature(btn);
        if (seen.has(key)) continue;
        seen.add(key);

        result.push(btn);
      }
    }

    result.sort(function (a, b) {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const ay = ra.top + window.scrollY;
      const by = rb.top + window.scrollY;
      if (ay !== by) return ay - by;
      return ra.left - rb.left;
    });

    lastCandidateCount = result.length;

    log("open roots 数量：", roots.length);
    log("候选未点赞按钮数量：", result.length);
    log(
      "候选按钮预览：",
      result.slice(0, 20).map(function (btn) {
        const state = getLikeStateInfo(btn);
        return {
          text: textOf(btn),
          state: state,
          rect: btn.getBoundingClientRect(),
          html: btn.outerHTML.slice(0, 260)
        };
      })
    );

    updatePanel();
    return result;
  }

  function dispatchRealClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      clientX: x,
      clientY: y
    };

    const PointerEventClass = window.PointerEvent || MouseEvent;

    el.dispatchEvent(new PointerEventClass("pointerover", base));
    el.dispatchEvent(new PointerEventClass("pointerenter", base));
    el.dispatchEvent(new PointerEventClass("pointermove", base));
    el.dispatchEvent(new PointerEventClass("pointerdown", base));
    el.dispatchEvent(new MouseEvent("mousedown", base));
    el.dispatchEvent(new PointerEventClass("pointerup", base));
    el.dispatchEvent(new MouseEvent("mouseup", base));
    el.dispatchEvent(new MouseEvent("click", base));
  }

  async function clickLikeButton(btn) {
    if (!btn || !isVisible(btn)) return false;
    if (attemptedButtons.has(btn)) return false;

    const beforeState = getLikeStateInfo(btn);
    if (beforeState.liked) {
      clickedButtons.add(btn);
      currentTaskText = "跳过已点赞按钮";
      updatePanel();
      return false;
    }

    attemptedButtons.add(btn);

    btn.scrollIntoView({
      behavior: "auto",
      block: "center",
      inline: "nearest"
    });

    await sleep(CONFIG.beforeClickDelay);

    if (!running) return false;
    if (!isVisible(btn)) return false;

    const stateAgain = getLikeStateInfo(btn);
    if (stateAgain.liked) {
      clickedButtons.add(btn);
      currentTaskText = "跳过已点赞按钮";
      updatePanel();
      return false;
    }

    const beforeText = textOf(btn);
    const beforeCountText = textOf(getCountNode(btn));
    const beforeRect = btn.getBoundingClientRect();

    currentTaskText = "正在点赞：" + beforeText;
    updatePanel();

    log("准备单次点击：", {
      text: beforeText,
      count: beforeCountText,
      rect: beforeRect,
      state: beforeState
    });

    try {
      if (btn.focus) btn.focus();

      dispatchRealClick(btn);

      await sleep(CONFIG.afterClickCheckDelay);

      const afterState = getLikeStateInfo(btn);
      const afterCountText = textOf(getCountNode(btn));
      const changed = afterCountText !== beforeCountText;

      clickedButtons.add(btn);

      if (afterState.liked || changed) {
        likedCount += 1;
        currentTaskText = "点赞成功：" + beforeText;
        updatePanel();

        log("点赞成功：", {
          beforeCountText: beforeCountText,
          afterCountText: afterCountText,
          afterState: afterState
        });

        return true;
      }

      currentTaskText = "已点击，等待下轮复查";
      updatePanel();

      log("已点击但未立即检测到变化，不做二次点击：", {
        beforeState: beforeState,
        afterState: afterState,
        beforeCountText: beforeCountText,
        afterCountText: afterCountText
      });

      return false;
    } catch (err) {
      clickedButtons.add(btn);
      currentTaskText = "点击失败，已跳过该按钮";
      updatePanel();
      log("点击失败：", err);
      return false;
    }
  }

  function smallStepScroll() {
    const step = randomInt(CONFIG.scrollStepMin, CONFIG.scrollStepMax);
    window.scrollBy({
      top: step,
      behavior: "auto"
    });
    return step;
  }

  async function rescanAroundViewport() {
    await sleep(60);

    const buttons = collectLikeButtons();
    const viewportButtons = buttons.filter(function (btn) {
      const rect = btn.getBoundingClientRect();
      return rect.top < window.innerHeight + 120 && rect.bottom > -120;
    });

    for (const btn of viewportButtons) {
      if (!running) break;
      await clickLikeButton(btn);
      await sleep(randomInt(CONFIG.clickDelayMin, CONFIG.clickDelayMax));
    }

    return viewportButtons.length;
  }

  function injectStyle() {
    const oldStyle = document.getElementById("bili-like-helper-style");
    if (oldStyle) oldStyle.remove();

    const style = document.createElement("style");
    style.id = "bili-like-helper-style";
    style.textContent = `
      #bili-comment-like-helper-panel {
        position: fixed;
        right: 18px;
        bottom: 88px;
        z-index: 2147483647;
        width: 300px;
        box-sizing: border-box;
        padding: 12px;
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 14px;
        background: rgba(0,0,0,0.38);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        color: rgba(255,255,255,0.92);
        box-shadow: 0 8px 28px rgba(0,0,0,0.28);
        font-size: 12px;
        line-height: 1.5;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, "Microsoft YaHei", sans-serif;
        pointer-events: auto;
        user-select: none;
      }

      #bili-comment-like-helper-panel * {
        box-sizing: border-box;
      }

      .bili-like-helper-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin: -4px -4px 10px -4px;
        padding: 8px 9px;
        border-radius: 11px;
        background: rgba(255,255,255,0.07);
        border: 1px solid rgba(255,255,255,0.10);
        user-select: none;
        cursor: move;
        touch-action: none;
      }

      .bili-like-helper-head:active {
        cursor: grabbing;
      }

      .bili-like-helper-title {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        pointer-events: none;
      }

      .bili-like-helper-title-main {
        font-size: 14px;
        font-weight: 700;
        color: rgba(255,255,255,0.96);
        letter-spacing: 0.2px;
      }

      .bili-like-helper-title-sub {
        font-size: 11px;
        color: rgba(255,255,255,0.62);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .bili-like-helper-dot {
        width: 9px;
        height: 9px;
        border-radius: 999px;
        background: #8c8c8c;
        box-shadow: 0 0 0 4px rgba(255,255,255,0.06);
        flex: 0 0 auto;
        pointer-events: none;
      }

      .bili-like-helper-dot.running {
        background: #00aeec;
        box-shadow: 0 0 0 4px rgba(0,174,236,0.18), 0 0 16px rgba(0,174,236,0.65);
      }

      .bili-like-helper-dot.stopped {
        background: #ff7875;
        box-shadow: 0 0 0 4px rgba(255,120,117,0.16);
      }

      .bili-like-helper-body {
        display: flex;
        flex-direction: column;
        gap: 9px;
      }

      .bili-like-helper-status {
        min-height: 34px;
        padding: 8px 9px;
        border-radius: 10px;
        background: rgba(0,0,0,0.22);
        border: 1px solid rgba(255,255,255,0.10);
        color: rgba(255,255,255,0.86);
        word-break: break-word;
        user-select: text;
      }

      .bili-like-helper-stats {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr 1fr;
        gap: 7px;
      }

      .bili-like-helper-stat {
        padding: 7px 6px;
        border-radius: 10px;
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.10);
        text-align: center;
      }

      .bili-like-helper-stat .label {
        color: rgba(255,255,255,0.58);
        font-size: 11px;
      }

      .bili-like-helper-stat .value {
        margin-top: 2px;
        color: rgba(255,255,255,0.96);
        font-size: 15px;
        font-weight: 700;
      }

      .bili-like-helper-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-top: 1px;
      }

      .bili-like-helper-btn {
        height: 34px;
        padding: 0 12px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.14);
        color: #fff;
        cursor: pointer;
        font-weight: 700;
        font-size: 13px;
        transition: transform 120ms ease, background 120ms ease, opacity 120ms ease, border-color 120ms ease;
        user-select: none;
      }

      .bili-like-helper-btn:hover {
        transform: translateY(-1px);
      }

      .bili-like-helper-btn:active {
        transform: translateY(0);
      }

      .bili-like-helper-btn:disabled {
        cursor: not-allowed;
        opacity: 0.55;
        transform: none;
      }

      #bili-like-helper-start {
        background: rgba(0,174,236,0.86);
        border-color: rgba(0,174,236,0.78);
      }

      #bili-like-helper-start:hover {
        background: rgba(0,174,236,1);
      }

      #bili-like-helper-stop {
        background: rgba(255,255,255,0.10);
        border-color: rgba(255,255,255,0.16);
      }

      #bili-like-helper-stop:hover {
        background: rgba(255,120,117,0.72);
        border-color: rgba(255,120,117,0.82);
      }

      .bili-like-helper-footnote {
        margin-top: 1px;
        color: rgba(255,255,255,0.48);
        font-size: 11px;
        line-height: 1.45;
        user-select: text;
      }
    `;

    document.head.appendChild(style);
  }

  function savePanelPosition(panel) {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const data = {
      left: Math.round(rect.left),
      top: Math.round(rect.top)
    };
    try {
      localStorage.setItem(CONFIG.panelStorageKey, JSON.stringify(data));
    } catch (err) {
      log("保存面板位置失败：", err);
    }
  }

  function loadPanelPosition() {
    try {
      const raw = localStorage.getItem(CONFIG.panelStorageKey);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (typeof data.left !== "number" || typeof data.top !== "number") return null;
      return data;
    } catch (_) {
      return null;
    }
  }

  function applyPanelPosition(panel, pos) {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const width = rect.width || 300;
    const height = rect.height || 180;

    const left = clamp(pos.left, 8, window.innerWidth - width - 8);
    const top = clamp(pos.top, 8, window.innerHeight - height - 8);

    panel.style.left = left + "px";
    panel.style.top = top + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function initPanelPosition(panel) {
    if (!panel) return;
    const saved = loadPanelPosition();
    if (saved) {
      applyPanelPosition(panel, saved);
      return;
    }

    requestAnimationFrame(function () {
      const rect = panel.getBoundingClientRect();
      applyPanelPosition(panel, {
        left: window.innerWidth - rect.width - 18,
        top: window.innerHeight - rect.height - 88
      });
      savePanelPosition(panel);
    });
  }

  function wirePanelDrag(panel) {
    if (!panel) return;
    const handle = panel.querySelector(".bili-like-helper-head");
    if (!handle) return;

    let dragging = false;
    let startClientX = 0;
    let startClientY = 0;
    let startLeft = 0;
    let startTop = 0;
    let moved = false;

    function onPointerMove(e) {
      if (!dragging) return;

      const dx = e.clientX - startClientX;
      const dy = e.clientY - startClientY;

      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;

      const rect = panel.getBoundingClientRect();
      const width = rect.width || 300;
      const height = rect.height || 180;

      const nextLeft = clamp(startLeft + dx, 8, window.innerWidth - width - 8);
      const nextTop = clamp(startTop + dy, 8, window.innerHeight - height - 8);

      panel.style.left = nextLeft + "px";
      panel.style.top = nextTop + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";

      e.preventDefault();
      e.stopPropagation();
    }

    function onPointerUp(e) {
      if (!dragging) return;
      dragging = false;

      try {
        handle.releasePointerCapture(e.pointerId);
      } catch (_) {}

      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerUp, true);

      savePanelPosition(panel);

      if (moved && !running) {
        currentTaskText = "面板位置已保存";
        updatePanel();
      }

      e.preventDefault();
      e.stopPropagation();
    }

    handle.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;

      const rect = panel.getBoundingClientRect();
      dragging = true;
      moved = false;
      startClientX = e.clientX;
      startClientY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;

      panel.style.left = rect.left + "px";
      panel.style.top = rect.top + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";

      try {
        handle.setPointerCapture(e.pointerId);
      } catch (_) {}

      document.addEventListener("pointermove", onPointerMove, true);
      document.addEventListener("pointerup", onPointerUp, true);
      document.addEventListener("pointercancel", onPointerUp, true);

      e.preventDefault();
      e.stopPropagation();
    }, true);

    window.addEventListener("resize", function () {
      const rect = panel.getBoundingClientRect();
      applyPanelPosition(panel, {
        left: rect.left,
        top: rect.top
      });
      savePanelPosition(panel);
    });
  }

  function createPanel() {
    injectStyle();

    const old = document.getElementById("bili-comment-like-helper-panel");
    if (old) old.remove();

    const panel = document.createElement("div");
    panel.id = "bili-comment-like-helper-panel";

    panel.innerHTML = `
      <div class="bili-like-helper-head" title="按住这里拖动面板">
        <div class="bili-like-helper-title">
          <div class="bili-like-helper-title-main">评论点赞助手</div>
          <div class="bili-like-helper-title-sub">使用GPT-5.5制作</div>
        </div>
        <div id="bili-like-helper-dot" class="bili-like-helper-dot"></div>
      </div>

      <div class="bili-like-helper-body">
        <div id="bili-like-helper-status" class="bili-like-helper-status">状态：待开始</div>

        <div class="bili-like-helper-stats">
          <div class="bili-like-helper-stat">
            <div class="label">已点赞</div>
            <div id="bili-like-helper-liked" class="value">0</div>
          </div>
          <div class="bili-like-helper-stat">
            <div class="label">候选</div>
            <div id="bili-like-helper-candidates" class="value">0</div>
          </div>
          <div class="bili-like-helper-stat">
            <div class="label">轮次</div>
            <div id="bili-like-helper-round" class="value">0</div>
          </div>
          <div class="bili-like-helper-stat">
            <div class="label">空轮</div>
            <div id="bili-like-helper-idle" class="value">0</div>
          </div>
        </div>

        <div class="bili-like-helper-actions">
          <button id="bili-like-helper-start" class="bili-like-helper-btn" type="button">开始点赞评论</button>
          <button id="bili-like-helper-stop" class="bili-like-helper-btn" type="button">停止</button>
        </div>

        <div class="bili-like-helper-footnote">
          通过蓝色图标识别（ #00AEEC）是否已点赞，按位置顺序扫描，如有安装其他主题插件可能会影响插件使用。
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    document.getElementById("bili-like-helper-start").addEventListener("click", start);
    document.getElementById("bili-like-helper-stop").addEventListener("click", stop);

    initPanelPosition(panel);
    wirePanelDrag(panel);
    updatePanel();
  }

  function updatePanel() {
    const statusEl = document.getElementById("bili-like-helper-status");
    const likedEl = document.getElementById("bili-like-helper-liked");
    const candidatesEl = document.getElementById("bili-like-helper-candidates");
    const roundEl = document.getElementById("bili-like-helper-round");
    const idleEl = document.getElementById("bili-like-helper-idle");
    const dotEl = document.getElementById("bili-like-helper-dot");
    const startBtn = document.getElementById("bili-like-helper-start");
    const stopBtn = document.getElementById("bili-like-helper-stop");

    if (statusEl) {
      const stateText = running ? "运行中" : "待开始";
      statusEl.textContent = "状态：" + stateText + "｜" + currentTaskText;
    }

    if (likedEl) likedEl.textContent = String(likedCount);
    if (candidatesEl) candidatesEl.textContent = String(lastCandidateCount);
    if (roundEl) roundEl.textContent = String(roundCount);
    if (idleEl) idleEl.textContent = String(idleRounds);

    if (dotEl) {
      dotEl.classList.remove("running");
      dotEl.classList.remove("stopped");

      if (running) dotEl.classList.add("running");
      else if (currentTaskText !== "待开始") dotEl.classList.add("stopped");
    }

    if (startBtn) startBtn.disabled = running;
    if (stopBtn) stopBtn.disabled = !running;
  }

  function stop() {
    running = false;
    currentTaskText = "已停止";
    updatePanel();
  }

  async function processCurrentlyLoadedButtons() {
    const buttons = collectLikeButtons();
    let processed = 0;

    for (const btn of buttons) {
      if (!running) break;
      const ok = await clickLikeButton(btn);
      processed += ok ? 1 : 0;
      if (!running) break;
      await sleep(randomInt(CONFIG.clickDelayMin, CONFIG.clickDelayMax));
    }

    return {
      total: buttons.length,
      processed: processed
    };
  }

  async function start() {
    if (running) return;

    running = true;
    likedCount = 0;
    roundCount = 0;
    lastCandidateCount = 0;
    idleRounds = 0;
    currentTaskText = "开始全量扫描评论区";
    updatePanel();

    while (running && roundCount < CONFIG.maxRounds) {
      roundCount += 1;
      currentTaskText = "第 " + roundCount + " 轮扫描当前已加载评论";
      updatePanel();

      const firstPass = await processCurrentlyLoadedButtons();
      if (!running) break;

      await sleep(60);

      currentTaskText = "执行视口回扫";
      updatePanel();

      const rescanCount = await rescanAroundViewport();
      if (!running) break;

      const newlyHandled = firstPass.total + rescanCount;

      if (newlyHandled <= 0) {
        idleRounds += 1;
        currentTaskText = "本轮无新候选，准备小步滚动";
      } else {
        idleRounds = 0;
        currentTaskText = "本轮完成，准备小步滚动";
      }
      updatePanel();

      if (idleRounds >= CONFIG.idleRoundsToStop) {
        currentTaskText = "连续多轮无新候选，自动结束";
        break;
      }

      const step = smallStepScroll();
      currentTaskText = "已小步滚动 " + step + "px，等待加载";
      updatePanel();

      await sleep(CONFIG.scrollDelay);
    }

    if (roundCount >= CONFIG.maxRounds) {
      currentTaskText = "达到最大轮次，自动结束";
    } else if (!running) {
      currentTaskText = "已停止";
    }

    running = false;
    updatePanel();
  }

  window.__biliLikeHelperV63 = {
    getAllOpenRoots: getAllOpenRoots,
    collectLikeButtons: collectLikeButtons,
    getLikeStateInfo: getLikeStateInfo,
    processCurrentlyLoadedButtons: processCurrentlyLoadedButtons,
    stop: stop,
    note: "V6.3 使用颜色+图标+状态多重判断已点赞，并采用全扫描+小步滚动回扫防止漏评。",
    savePanelPosition: function () {
      const panel = document.getElementById("bili-comment-like-helper-panel");
      savePanelPosition(panel);
    },
    resetPanelPosition: function () {
      try {
        localStorage.removeItem(CONFIG.panelStorageKey);
      } catch (_) {}

      const panel = document.getElementById("bili-comment-like-helper-panel");
      if (panel) {
        applyPanelPosition(panel, {
          left: window.innerWidth - 318,
          top: window.innerHeight - 320
        });
        savePanelPosition(panel);
      }
    }
  };

  createPanel();
  log("已加载全扫描防漏评版。调试对象：window.__biliLikeHelperV63");
})();

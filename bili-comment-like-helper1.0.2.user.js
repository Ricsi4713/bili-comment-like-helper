// ==UserScript==
// @name         Bilibili 动态评论批量点赞助手
// @namespace    tabbit.local
// @version      1.0.2
// @description  穿透 open Shadow DOM 扫描 B 站动态评论点赞按钮；识别已点赞/未点赞，按位置全扫描，防止滑动过头漏点；支持拖拽定位与快速点赞。
// @author       BaiyiRyis
// @match        https://t.bilibili.com/*
// @match        https://www.bilibili.com/opus/*
// @run-at       document-idle
// @downloadURL https://update.greasyfork.org/scripts/576946/Bilibili%20%E5%8A%A8%E6%80%81%E8%AF%84%E8%AE%BA%E6%89%B9%E9%87%8F%E7%82%B9%E8%B5%9E%E5%8A%A9%E6%89%8B.user.js
// @updateURL https://update.greasyfork.org/scripts/575233/Bilibili%20%E5%8A%A8%E6%80%81%E8%AF%84%E8%AE%BA%E6%89%B9%E9%87%8F%E7%82%B9%E8%B5%9E%E5%8A%A9%E6%89%8B.meta.js
// @icon         https://www.bilibili.com/favicon.ico
// @grant        none
// ==/UserScript==


(function () {
  "use strict";

  const CONFIG = {
    debug: true,

    clickDelayMin: 180,
    clickDelayMax: 320,
    beforeClickDelay: 90,
    afterClickCheckDelay: 520,

    loadMoreScrollStep: 480,
    loadMoreDelay: 700,

    idleRoundsToStop: 10,
    maxRounds: 420,

    // 每个按钮最多允许点击尝试次数
    maxAttemptsPerButton: 2,

    // 如果首次点击后状态未明显变化，不立刻放弃，而是进入待复查状态
    maxPendingChecksPerButton: 3,

    likedBlue: {
      r: 0,
      g: 174,
      b: 236
    },

    likedColorTolerance: 30,

    panelStorageKey: "bili_comment_like_helper_panel_pos_v6_5"
  };

  let running = false;
  let likedCount = 0;
  let skippedLikedCount = 0;
  let roundCount = 0;
  let idleRounds = 0;
  let lastCandidateCount = 0;
  let lastAllButtonCount = 0;
  let pendingCount = 0;
  let currentTaskText = "待开始";

  const processedButtons = new WeakSet();
  const attemptCountMap = new WeakMap();
  const pendingCheckCountMap = new WeakMap();

  const processedSignatures = new Set();
  const pendingSignatureState = new Map();

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
    args.unshift("[Bili 评论点赞助手 V6.5]");
    console.log.apply(console, args);
  }

  function textOf(el) {
    return (el && (el.innerText || el.textContent) || "").replace(/\s+/g, " ").trim();
  }

  function clamp(n, min, max) {
    return Math.min(Math.max(n, min), max);
  }

  function normalizeColor(color) {
    return String(color || "").replace(/\s+/g, "").toLowerCase();
  }

  function parseRgb(color) {
    const normalized = normalizeColor(color);

    const rgbMatch = normalized.match(/rgba?\((\d+),(\d+),(\d+)/);
    if (rgbMatch) {
      return {
        r: Number(rgbMatch[1]),
        g: Number(rgbMatch[2]),
        b: Number(rgbMatch[3])
      };
    }

    const hexMatch = normalized.match(/^#([0-9a-f]{6})$/i);
    if (hexMatch) {
      const hex = hexMatch[1];
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16)
      };
    }

    return null;
  }

  function rgbToHex(rgb) {
    if (!rgb) return "";
    function h(n) {
      return Number(n).toString(16).padStart(2, "0");
    }
    return "#" + h(rgb.r) + h(rgb.g) + h(rgb.b);
  }

  function colorNear(a, b, tolerance) {
    if (!a || !b) return false;
    return (
      Math.abs(a.r - b.r) <= tolerance &&
      Math.abs(a.g - b.g) <= tolerance &&
      Math.abs(a.b - b.b) <= tolerance
    );
  }

  function isVisibleElement(el) {
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

  function getAllOpenRoots(startRoot) {
    const roots = [];
    const seen = new WeakSet();

    function walk(root) {
      if (!root || seen.has(root)) return;

      seen.add(root);
      roots.push(root);

      const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
      for (const el of all) {
        if (el.shadowRoot) {
          walk(el.shadowRoot);
        }
      }
    }

    walk(startRoot || document);
    return roots;
  }

  function getThumbsupIcon(btn) {
    if (!btn || !btn.querySelectorAll) return null;

    const icons = Array.from(btn.querySelectorAll("bili-icon"));
    return icons.find(function (icon) {
      const name = icon.getAttribute("icon") || "";
      return /thumbsup/i.test(name);
    }) || null;
  }

  function getCountNode(btn) {
    if (!btn || !btn.querySelector) return null;

    return (
      btn.querySelector("span#count") ||
      btn.querySelector('span[id="count"]') ||
      btn.querySelector("#count")
    );
  }

  function getCountText(btn) {
    const node = getCountNode(btn);
    if (!node) return null;
    return textOf(node);
  }

  function getDeepIconColors(btn) {
    const colors = [];

    function pushColor(value) {
      const rgb = parseRgb(value);
      if (rgb) colors.push(rgb);
    }

    const icon = getThumbsupIcon(btn);
    if (!icon) return colors;

    const iconStyle = getComputedStyle(icon);
    pushColor(iconStyle.color);
    pushColor(iconStyle.fill);

    pushColor(icon.getAttribute("color"));

    const styleAttr = icon.getAttribute("style") || "";
    const styleColorMatch = styleAttr.match(/color\s*:\s*([^;]+)/i);
    if (styleColorMatch) pushColor(styleColorMatch[1]);

    if (icon.shadowRoot) {
      const shadowTargets = Array.from(
        icon.shadowRoot.querySelectorAll("svg, path, use, g, #icon")
      );

      for (const target of shadowTargets) {
        const s = getComputedStyle(target);
        pushColor(s.color);
        pushColor(s.fill);
        pushColor(s.stroke);
        pushColor(target.getAttribute("fill"));
        pushColor(target.getAttribute("stroke"));
        pushColor(target.getAttribute("color"));
      }
    }

    const btnStyle = getComputedStyle(btn);
    pushColor(btnStyle.color);
    pushColor(btnStyle.fill);

    return colors;
  }

  function getButtonSignature(btn) {
    const rect = btn.getBoundingClientRect();
    const icon = getThumbsupIcon(btn);
    const countNode = getCountNode(btn);

    return [
      Math.round(rect.left),
      Math.round(rect.top + window.scrollY),
      Math.round(rect.width),
      Math.round(rect.height),
      countNode ? "has-count-node" : "no-count-node",
      textOf(countNode) || "empty",
      icon ? icon.getAttribute("icon") || "" : ""
    ].join("|");
  }

  function getLikeStateInfo(btn) {
    const cls = String(btn.className || "").toLowerCase();
    const ariaPressed = btn.getAttribute ? btn.getAttribute("aria-pressed") : "";
    const ariaLabel = btn.getAttribute ? btn.getAttribute("aria-label") || "" : "";
    const title = btn.getAttribute ? btn.getAttribute("title") || "" : "";

    const icon = getThumbsupIcon(btn);
    const iconName = icon ? icon.getAttribute("icon") || "" : "";

    const colors = getDeepIconColors(btn);
    const likedByColor = colors.some(function (rgb) {
      return colorNear(rgb, CONFIG.likedBlue, CONFIG.likedColorTolerance);
    });

    const likedByAria =
      ariaPressed === "true" ||
      /已点赞|取消点赞/.test(ariaLabel) ||
      /已点赞|取消点赞/.test(title);

    const likedByClass =
      cls.indexOf("liked") >= 0 ||
      cls.indexOf("active") >= 0 ||
      cls.indexOf("is-active") >= 0;

    const likedByIconName =
      /thumbsup_fill|hand_thumbsup_fill/i.test(iconName);

    const liked =
      likedByColor ||
      likedByAria ||
      likedByClass ||
      likedByIconName;

    return {
      liked: liked,
      likedByColor: likedByColor,
      likedByAria: likedByAria,
      likedByClass: likedByClass,
      likedByIconName: likedByIconName,
      iconName: iconName,
      colors: colors.map(rgbToHex)
    };
  }

  function isButtonLiked(btn) {
    return getLikeStateInfo(btn).liked;
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

  function isLikelyCommentLikeButton(btn) {
    if (!btn || btn.tagName !== "BUTTON") return false;
    if (!isVisibleElement(btn)) return false;
    if (isScriptOwnButton(btn)) return false;

    const icon = getThumbsupIcon(btn);
    if (!icon) return false;

    const countNode = getCountNode(btn);

    // 关键修复：
    // 只要存在 thumbsup 图标 + span#count，就算 count 为空，也认为是点赞按钮。
    if (countNode) return true;

    // 兜底：少数情况下按钮文本上直接带数字
    const buttonText = textOf(btn);
    if (/^\d+$/.test(buttonText)) return true;

    return false;
  }

  function collectAllLikeButtonsInLoadedPage() {
    const roots = getAllOpenRoots(document);
    const allButtons = [];
    const seen = new Set();

    for (const root of roots) {
      const buttons = Array.from(root.querySelectorAll ? root.querySelectorAll("button") : []);

      for (const btn of buttons) {
        if (!isLikelyCommentLikeButton(btn)) continue;

        const sig = getButtonSignature(btn);
        if (seen.has(sig)) continue;

        seen.add(sig);
        allButtons.push(btn);
      }
    }

    allButtons.sort(function (a, b) {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();

      const ay = ra.top + window.scrollY;
      const by = rb.top + window.scrollY;

      if (ay !== by) return ay - by;
      return ra.left - rb.left;
    });

    lastAllButtonCount = allButtons.length;
    return allButtons;
  }

  function shouldSkipAsProcessed(btn, sig) {
    if (processedButtons.has(btn)) return true;
    if (processedSignatures.has(sig)) return true;
    return false;
  }

  function shouldTreatAsPending(sig) {
    return pendingSignatureState.has(sig);
  }

  function markPending(sig) {
    pendingSignatureState.set(sig, true);
    pendingCount = pendingSignatureState.size;
  }

  function clearPending(sig) {
    pendingSignatureState.delete(sig);
    pendingCount = pendingSignatureState.size;
  }

  function markProcessed(btn, sig) {
    processedButtons.add(btn);
    processedSignatures.add(sig);
    clearPending(sig);
  }

  function collectUnlikedButtonsInLoadedPage() {
    const allButtons = collectAllLikeButtonsInLoadedPage();
    const candidates = [];

    for (const btn of allButtons) {
      const sig = getButtonSignature(btn);

      if (shouldSkipAsProcessed(btn, sig)) continue;

      const attempts = attemptCountMap.get(btn) || 0;
      if (attempts >= CONFIG.maxAttemptsPerButton) {
        markProcessed(btn, sig);
        continue;
      }

      const state = getLikeStateInfo(btn);

      if (state.liked) {
        markProcessed(btn, sig);
        skippedLikedCount += 1;
        continue;
      }

      candidates.push(btn);
    }

    lastCandidateCount = candidates.length;

    log("当前已加载点赞按钮总数：", lastAllButtonCount);
    log("当前未点赞候选按钮数：", lastCandidateCount);
    log("当前待复查按钮数：", pendingCount);
    log(
      "候选预览：",
      candidates.slice(0, 20).map(function (btn) {
        const sig = getButtonSignature(btn);
        return {
          count: getCountText(btn),
          rect: btn.getBoundingClientRect(),
          state: getLikeStateInfo(btn),
          attempts: attemptCountMap.get(btn) || 0,
          pending: shouldTreatAsPending(sig),
          signature: sig,
          html: btn.outerHTML.slice(0, 260)
        };
      })
    );

    updatePanel();

    return candidates;
  }

  function dispatchOneRealClick(el) {
    const rect = el.getBoundingClientRect();

    const x = clamp(rect.left + rect.width / 2, 1, window.innerWidth - 2);
    const y = clamp(rect.top + rect.height / 2, 1, window.innerHeight - 2);

    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y
    };

    const PointerEventClass = window.PointerEvent || MouseEvent;

    el.dispatchEvent(new PointerEventClass("pointerover", base));
    el.dispatchEvent(new PointerEventClass("pointerenter", base));
    el.dispatchEvent(new PointerEventClass("pointermove", base));
    el.dispatchEvent(new PointerEventClass("pointerdown", base));
    el.dispatchEvent(new MouseEvent("mousedown", base));

    const upBase = Object.assign({}, base, {
      buttons: 0
    });

    el.dispatchEvent(new PointerEventClass("pointerup", upBase));
    el.dispatchEvent(new MouseEvent("mouseup", upBase));
    el.dispatchEvent(new MouseEvent("click", upBase));
  }

  async function clickOrQueueRetry(btn) {
    if (!btn || !isVisibleElement(btn)) return false;

    const sig = getButtonSignature(btn);

    if (shouldSkipAsProcessed(btn, sig)) return false;

    const attempts = attemptCountMap.get(btn) || 0;
    if (attempts >= CONFIG.maxAttemptsPerButton) {
      markProcessed(btn, sig);
      return false;
    }

    const beforeState = getLikeStateInfo(btn);
    if (beforeState.liked) {
      markProcessed(btn, sig);
      skippedLikedCount += 1;
      currentTaskText = "跳过已点赞按钮";
      updatePanel();
      return false;
    }

    attemptCountMap.set(btn, attempts + 1);

    btn.scrollIntoView({
      behavior: "auto",
      block: "center",
      inline: "nearest"
    });

    await sleep(CONFIG.beforeClickDelay);

    if (!running) return false;
    if (!isVisibleElement(btn)) return false;

    const stateAfterScroll = getLikeStateInfo(btn);
    if (stateAfterScroll.liked) {
      markProcessed(btn, sig);
      skippedLikedCount += 1;
      currentTaskText = "滚动后检测为已点赞，跳过";
      updatePanel();
      return false;
    }

    const beforeCount = getCountText(btn);
    const beforeRect = btn.getBoundingClientRect();

    currentTaskText = "正在点击：" + (beforeCount === "" ? "0" : (beforeCount || "空数值按钮"));
    updatePanel();

    log("准备点击按钮：", {
      beforeCount: beforeCount,
      beforeState: beforeState,
      rect: beforeRect,
      attempts: attempts + 1,
      signature: sig
    });

    try {
      if (btn.focus) btn.focus();

      dispatchOneRealClick(btn);

      await sleep(CONFIG.afterClickCheckDelay);

      const afterState = getLikeStateInfo(btn);
      const afterCount = getCountText(btn);
      const countChanged = beforeCount !== afterCount;

      if (afterState.liked || countChanged) {
        markProcessed(btn, sig);
        likedCount += 1;
        currentTaskText = "点赞成功：" + (afterCount === "" ? "0" : (afterCount || beforeCount || "空数值按钮"));
        updatePanel();

        log("点赞成功：", {
          beforeCount: beforeCount,
          afterCount: afterCount,
          beforeState: beforeState,
          afterState: afterState
        });

        return true;
      }

      // 没有明显变化：进入待复查 / 待重试，而不是直接永久放弃
      const pendingChecks = pendingCheckCountMap.get(btn) || 0;
      pendingCheckCountMap.set(btn, pendingChecks + 1);
      markPending(sig);

      if ((attemptCountMap.get(btn) || 0) >= CONFIG.maxAttemptsPerButton ||
          (pendingCheckCountMap.get(btn) || 0) >= CONFIG.maxPendingChecksPerButton) {
        markProcessed(btn, sig);
        currentTaskText = "复查后仍无变化，已放弃";
        updatePanel();

        log("达到最大复查/尝试次数，放弃该按钮：", {
          beforeCount: beforeCount,
          afterCount: afterCount,
          beforeState: beforeState,
          afterState: afterState,
          attempts: attemptCountMap.get(btn) || 0,
          pendingChecks: pendingCheckCountMap.get(btn) || 0
        });

        return false;
      }

      currentTaskText = "已加入待复查队列";
      updatePanel();

      log("点击后状态未明显变化，加入待复查队列：", {
        beforeCount: beforeCount,
        afterCount: afterCount,
        beforeState: beforeState,
        afterState: afterState,
        attempts: attemptCountMap.get(btn) || 0,
        pendingChecks: pendingCheckCountMap.get(btn) || 0
      });

      return false;
    } catch (err) {
      markPending(sig);
      currentTaskText = "点击异常，加入待复查";
      updatePanel();
      log("点击异常：", err);
      return false;
    }
  }

  async function reviewPendingButtons() {
    const allButtons = collectAllLikeButtonsInLoadedPage();
    let recovered = 0;

    for (const btn of allButtons) {
      if (!running) break;

      const sig = getButtonSignature(btn);
      if (!shouldTreatAsPending(sig)) continue;
      if (shouldSkipAsProcessed(btn, sig)) continue;

      const state = getLikeStateInfo(btn);
      if (state.liked) {
        markProcessed(btn, sig);
        likedCount += 1;
        recovered += 1;
        currentTaskText = "复查确认点赞成功";
        updatePanel();
        continue;
      }

      const attempts = attemptCountMap.get(btn) || 0;
      const pendingChecks = pendingCheckCountMap.get(btn) || 0;

      if (attempts < CONFIG.maxAttemptsPerButton &&
          pendingChecks < CONFIG.maxPendingChecksPerButton) {
        await clickOrQueueRetry(btn);
        await sleep(randomInt(CONFIG.clickDelayMin, CONFIG.clickDelayMax));
      } else {
        markProcessed(btn, sig);
      }
    }

    return recovered;
  }

  async function sweepCurrentlyLoadedPage() {
    let totalClicked = 0;
    let batchIndex = 0;

    while (running) {
      batchIndex += 1;

      const candidates = collectUnlikedButtonsInLoadedPage();

      if (!candidates.length && pendingCount <= 0) {
        break;
      }

      currentTaskText = "清扫当前已加载按钮，第 " + batchIndex + " 批，候选 " + candidates.length;
      updatePanel();

      for (const btn of candidates) {
        if (!running) break;

        const ok = await clickOrQueueRetry(btn);
        if (ok) totalClicked += 1;

        if (!running) break;
        await sleep(randomInt(CONFIG.clickDelayMin, CONFIG.clickDelayMax));
      }

      if (!running) break;

      const recovered = await reviewPendingButtons();
      totalClicked += recovered;

      await sleep(140);

      if (batchIndex >= 14) {
        break;
      }
    }

    return totalClicked;
  }

  function scrollLoadMore() {
    window.scrollBy({
      top: CONFIG.loadMoreScrollStep,
      behavior: "auto"
    });
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
        width: 326px;
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
        grid-template-columns: 1fr 1fr 1fr 1fr 1fr;
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
    const width = rect.width || 326;
    const height = rect.height || 190;

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
      const width = rect.width || 326;
      const height = rect.height || 190;

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
          <div class="bili-like-helper-title-sub">使用GPT5.5制作</div>
        </div>
        <div id="bili-like-helper-dot" class="bili-like-helper-dot"></div>
      </div>

      <div class="bili-like-helper-body">
        <div id="bili-like-helper-status" class="bili-like-helper-status">状态：待开始</div>

        <div class="bili-like-helper-stats">
          <div class="bili-like-helper-stat">
            <div class="label">已点</div>
            <div id="bili-like-helper-liked" class="value">0</div>
          </div>
          <div class="bili-like-helper-stat">
            <div class="label">候选</div>
            <div id="bili-like-helper-candidates" class="value">0</div>
          </div>
          <div class="bili-like-helper-stat">
            <div class="label">总按钮</div>
            <div id="bili-like-helper-all" class="value">0</div>
          </div>
          <div class="bili-like-helper-stat">
            <div class="label">待复查</div>
            <div id="bili-like-helper-pending" class="value">0</div>
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
          点击后无明显变化的按钮会进入有限重试。通过蓝色图标识别（ #00AEEC）是否已点赞，按位置顺序扫描，如有安装其他主题插件可能会影响插件使用。
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
    const allEl = document.getElementById("bili-like-helper-all");
    const pendingEl = document.getElementById("bili-like-helper-pending");
    const idleEl = document.getElementById("bili-like-helper-idle");
    const dotEl = document.getElementById("bili-like-helper-dot");
    const startBtn = document.getElementById("bili-like-helper-start");
    const stopBtn = document.getElementById("bili-like-helper-stop");

    if (statusEl) {
      const stateText = running ? "运行中" : "待开始";
      statusEl.textContent = "状态：" + stateText + "｜" + currentTaskText + "｜轮次 " + roundCount;
    }

    if (likedEl) likedEl.textContent = String(likedCount);
    if (candidatesEl) candidatesEl.textContent = String(lastCandidateCount);
    if (allEl) allEl.textContent = String(lastAllButtonCount);
    if (pendingEl) pendingEl.textContent = String(pendingCount);
    if (idleEl) idleEl.textContent = String(idleRounds);

    if (dotEl) {
      dotEl.classList.remove("running");
      dotEl.classList.remove("stopped");

      if (running) {
        dotEl.classList.add("running");
      } else if (currentTaskText !== "待开始") {
        dotEl.classList.add("stopped");
      }
    }

    if (startBtn) startBtn.disabled = running;
    if (stopBtn) stopBtn.disabled = !running;
  }

  function stop() {
    running = false;
    currentTaskText = "已停止";
    updatePanel();
  }

  async function sweepCurrentlyLoadedPage() {
    let totalClicked = 0;
    let batchIndex = 0;

    while (running) {
      batchIndex += 1;

      const candidates = collectUnlikedButtonsInLoadedPage();

      if (!candidates.length && pendingCount <= 0) {
        break;
      }

      currentTaskText = "清扫当前已加载按钮，第 " + batchIndex + " 批";
      updatePanel();

      for (const btn of candidates) {
        if (!running) break;

        const ok = await clickOrQueueRetry(btn);
        if (ok) totalClicked += 1;

        if (!running) break;
        await sleep(randomInt(CONFIG.clickDelayMin, CONFIG.clickDelayMax));
      }

      if (!running) break;

      const recovered = await reviewPendingButtons();
      totalClicked += recovered;

      await sleep(150);

      if (batchIndex >= 16) break;
    }

    return totalClicked;
  }

  async function start() {
    if (running) return;

    running = true;
    likedCount = 0;
    skippedLikedCount = 0;
    roundCount = 0;
    idleRounds = 0;
    lastCandidateCount = 0;
    lastAllButtonCount = 0;
    pendingCount = 0;
    currentTaskText = "开始当前页全按钮清扫";
    updatePanel();

    while (running && roundCount < CONFIG.maxRounds) {
      roundCount += 1;

      currentTaskText = "第 " + roundCount + " 轮：清扫当前已加载按钮";
      updatePanel();

      const beforeLiked = likedCount;
      const clickedThisRound = await sweepCurrentlyLoadedPage();

      if (!running) break;

      const added = likedCount - beforeLiked;

      if (clickedThisRound <= 0 && added <= 0 && lastCandidateCount <= 0 && pendingCount <= 0) {
        idleRounds += 1;
        currentTaskText = "本轮无新候选，继续向下加载";
      } else {
        idleRounds = 0;
        currentTaskText = "本轮完成，新增 " + added + " 个";
      }

      updatePanel();

      if (idleRounds >= CONFIG.idleRoundsToStop) {
        currentTaskText = "连续多轮无新候选，自动结束";
        break;
      }

      scrollLoadMore();
      await sleep(CONFIG.loadMoreDelay);
    }

    if (roundCount >= CONFIG.maxRounds) {
      currentTaskText = "达到最大轮次，自动结束";
    } else if (!running) {
      currentTaskText = "已停止";
    }

    running = false;
    updatePanel();
  }

  function scrollLoadMore() {
    window.scrollBy({
      top: CONFIG.loadMoreScrollStep,
      behavior: "auto"
    });
  }

  window.__biliLikeHelperV65 = {
    getAllOpenRoots: getAllOpenRoots,
    collectAllLikeButtonsInLoadedPage: collectAllLikeButtonsInLoadedPage,
    collectUnlikedButtonsInLoadedPage: collectUnlikedButtonsInLoadedPage,
    getLikeStateInfo: getLikeStateInfo,
    reviewPendingButtons: reviewPendingButtons,
    sweepCurrentlyLoadedPage: sweepCurrentlyLoadedPage,
    stop: stop,
    note: "V6.5：支持 0 赞隐藏数字按钮识别，并为点击后状态未变化的按钮提供有限重试机制。",
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
          left: window.innerWidth - 344,
          top: window.innerHeight - 320
        });
        savePanelPosition(panel);
      }
    }
  };

  createPanel();
  log("已加载 V6.5：0赞识别 + 有限重试版。调试对象：window.__biliLikeHelperV65");
})();

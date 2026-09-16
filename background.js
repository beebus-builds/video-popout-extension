const DEFAULTS = {
  searchIframes: true,
  showPicker: true,
  autoRepopout: false,
  captureAudio: true,
  showContextMenu: true,
  hoverButtons: true,
  autoPipOnSwitch: false,
  autoPauseBackground: false,
  resumeOnReturn: false,
  docPipSize: "balanced",
  siteRules: {}
};

const DOC_PIP_SIZES = {
  compact: { width: 480, height: 270 },
  balanced: { width: 640, height: 360 },
  large: { width: 960, height: 540 }
};

async function getSettings() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

function originOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
    return "";
  } catch {
    return "";
  }
}

function isRestrictedUrl(url) {
  return !url || url.startsWith("chrome://") || url.startsWith("edge://") ||
    url.startsWith("about:") || url.startsWith("chrome-extension://") ||
    url.startsWith("chrome-search://") || url.startsWith("view-source:");
}

async function setBadgeError(tabId, message) {
  try {
    await chrome.action.setBadgeText({ tabId, text: "!" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#be123c" });
    await chrome.action.setTitle({ tabId, title: message || "Cannot access this page." });
  } catch { return; }
}

async function clearBadge(tabId) {
  try {
    await chrome.action.setBadgeText({ tabId, text: "" });
    await chrome.action.setTitle({ tabId, title: "Pop out video (Alt+P)" });
  } catch { return; }
}

async function ensureMenus() {
  try { await chrome.contextMenus.removeAll(); } catch { return; }
  const s = await getSettings();
  if (!s.showContextMenu) return;
  try {
    chrome.contextMenus.create({ id: "popout-video", title: "Pop out video", contexts: ["video"] });
    chrome.contextMenus.create({ id: "popout-all", title: "Pop out all videos", contexts: ["page", "video"] });
    chrome.contextMenus.create({ id: "popout-tab", title: "Pop out entire tab", contexts: ["page", "video"] });
  } catch { return; }
}

chrome.runtime.onInstalled.addListener((details) => {
  void ensureMenus();
  if (details.reason === "install") {
    try { chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") }); } catch { return; }
  }
  try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {}); } catch { return; }
});
chrome.runtime.onStartup.addListener(() => {
  void ensureMenus();
  try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {}); } catch { return; }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && Object.keys(DEFAULTS).some((k) => k in changes)) void ensureMenus();
});

async function setTargetIndex(tabId, frameId, index) {
  if (index == null) return;
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (idx) => { window.__popoutVideoIndex = idx; },
    args: [index]
  });
}

async function toggleInTab(tabId, frameId = 0, videoIndex = null, enterOnly = false) {
  if (tabId == null) return { ok: false, error: "No tab found." };
  try {
    if (videoIndex != null) {
      try { await setTargetIndex(tabId, frameId, videoIndex); } catch { return; }
    }
    if (enterOnly) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          func: () => { window.__popoutEnterOnly = true; }
        });
      } catch { return; }
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ["pip.js"]
    });
    const result = results[0]?.result;
    if (!result?.ok) throw new Error(result?.error || "Could not pop out this video.");
    await clearBadge(tabId);
    const s = await getSettings();
    if (s.autoRepopout && result.action === "entered") {
      await rememberPipTab(tabId);
    }
    if (result.action === "exited") {
      await forgetPipTab(tabId);
    }
    return { ok: true, action: result.action };
  } catch (error) {
    const message = error?.message || "Cannot access this page.";
    await setBadgeError(tabId, message);
    return { ok: false, error: message };
  }
}

async function collectVideos(tabId) {
  const s = await getSettings();
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: s.searchIframes },
      files: ["collect-videos.js"]
    });
    const videos = [];
    let docPipOpen = false;
    for (const r of results || []) {
      const payload = r?.result;
      const list = Array.isArray(payload) ? payload : (payload?.videos || []);
      if (payload && !Array.isArray(payload) && payload.docPipOpen) docPipOpen = true;
      for (const v of list) {
        videos.push({ frameId: r.frameId ?? 0, ...v });
      }
    }
    videos.sort((a, b) => {
      if (a.playing !== b.playing) return a.playing ? -1 : 1;
      if (a.inPip !== b.inPip) return a.inPip ? -1 : 1;
      return (b.width * b.height) - (a.width * a.height);
    });
    return { ok: true, videos, docPipOpen };
  } catch (error) {
    return { ok: false, error: error?.message || "Cannot access this page.", videos: [], docPipOpen: false };
  }
}

async function popMultiple(tabId, targets) {
  if (tabId == null) return { ok: false, error: "No tab found." };
  if (!targets || !targets.length) return { ok: false, error: "Select at least one video." };
  const frameIds = [...new Set(targets.map((t) => t.frameId ?? 0))];
  if (frameIds.length > 1) {
    return { ok: false, error: "Multi-popout works for videos in the same frame — Chrome allows only one floating window per section. Pop them one at a time, or use whole-tab popout." };
  }
  const frameId = frameIds[0];
  const indices = [...new Set(targets.map((t) => t.index).filter((i) => Number.isInteger(i)))];
  if (!indices.length) return { ok: false, error: "Select at least one video." };
  try {
    const s = await getSettings();
    const size = DOC_PIP_SIZES[s.docPipSize] || DOC_PIP_SIZES.balanced;
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: (idxs, winSize) => {
        window.__popoutVideoIndices = idxs;
        window.__popoutWindowSize = winSize;
      },
      args: [indices, size]
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ["multi-pip.js"]
    });
    const result = results[0]?.result;
    if (!result?.ok) throw new Error(result?.error || "Could not pop out these videos.");
    await clearBadge(tabId);
    if (s.autoRepopout && result.action === "entered") {
      await rememberPipTab(tabId);
    }
    if (result.action === "closed") {
      await forgetPipTab(tabId);
    }
    return { ok: true, count: result.count || indices.length, action: result.action };
  } catch (error) {
    const message = error?.message || "Cannot access this page.";
    await setBadgeError(tabId, message);
    return { ok: false, error: message };
  }
}

async function controlVideos(tabId, targets, command, value) {
  if (tabId == null) return { ok: false, error: "No tab found." };
  if (!targets || !targets.length) return { ok: false, error: "Select at least one video." };
  const byFrame = new Map();
  for (const t of targets) {
    const frameId = t.frameId ?? 0;
    if (!byFrame.has(frameId)) byFrame.set(frameId, []);
    if (Number.isInteger(t.index)) byFrame.get(frameId).push(t.index);
  }
  let applied = 0;
  const errors = [];
  for (const [frameId, indices] of byFrame) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: (idxs, cmd, val) => {
          const vids = Array.from(document.querySelectorAll("video"));
          let n = 0;
          for (const i of idxs) {
            const v = vids[i];
            if (!v) continue;
            try {
              if (cmd === "play") { void v.play(); n++; }
              else if (cmd === "pause") { v.pause(); n++; }
              else if (cmd === "toggle-play") { if (v.paused) { void v.play(); } else { v.pause(); } n++; }
              else if (cmd === "mute") { v.muted = true; n++; }
              else if (cmd === "unmute") { v.muted = false; n++; }
              else if (cmd === "toggle-mute") { v.muted = !v.muted; n++; }
              else if (cmd === "seek") { v.currentTime = Math.max(0, (v.currentTime || 0) + Number(val || 0)); n++; }
              else if (cmd === "rate") { v.playbackRate = Number(val) || 1; n++; }
              else if (cmd === "loop") { v.loop = !!val; n++; }
              else if (cmd === "toggle-loop") { v.loop = !v.loop; n++; }
            } catch (e) { return; }
          }
          return { ok: true, count: n };
        },
        args: [indices, command, value ?? null]
      });
      applied += results[0]?.result?.count || 0;
    } catch (error) {
      errors.push(error?.message || "Failed in one frame.");
    }
  }
  if (!applied) {
    return { ok: false, error: errors[0] || "Could not control these videos." };
  }
  return { ok: true, count: applied };
}

async function ensureOverlay(tabId) {
  try {
    const s = await getSettings();
    if (!s.hoverButtons) return;
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["page-overlay.js"]
    });
  } catch { return; }
}

async function rememberPipTab(tabId) {
  try {
    const data = await chrome.storage.session.get({ pipTabs: [] });
    const tabs = new Set(data.pipTabs || []);
    tabs.add(tabId);
    await chrome.storage.session.set({ pipTabs: [...tabs] });
  } catch { return; }
}

async function forgetPipTab(tabId) {
  try {
    const data = await chrome.storage.session.get({ pipTabs: [] });
    const tabs = (data.pipTabs || []).filter((id) => id !== tabId);
    await chrome.storage.session.set({ pipTabs: tabs });
  } catch { return; }
}

let repopoutTimers = {};

async function maybeRepopout(tabId, url) {
  if (tabId == null || isRestrictedUrl(url)) return;
  const s = await getSettings();
  const rule = originOf(url || "") ? (s.siteRules || {})[originOf(url)] : undefined;
  if (rule === "never") return;
  const alwaysSite = rule === "always";
  if (!s.autoRepopout && !alwaysSite) {
    void ensureOverlay(tabId);
    return;
  }
  if (!alwaysSite) {
    let session = {};
    try { session = await chrome.storage.session.get({ pipTabs: [] }); } catch { return; }
    if (!(session.pipTabs || []).includes(tabId)) {
      void ensureOverlay(tabId);
      return;
    }
  }
  const hasHosts = await chrome.permissions.contains({ origins: ["<all_urls>"] }).catch(() => false);
  if (!hasHosts) {
    await setBadgeError(tabId, "Auto re-popout needs site access — open Options to grant it, or press Alt+P.");
    return;
  }
  if (repopoutTimers[tabId]) clearTimeout(repopoutTimers[tabId]);
  repopoutTimers[tabId] = setTimeout(async () => {
    delete repopoutTimers[tabId];
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: () => { window.__popoutEnterOnly = true; }
      });
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: s.searchIframes },
        files: ["pip.js"]
      });
      const entered = (results || []).some((r) => r?.result?.ok);
      if (entered) {
        await clearBadge(tabId);
      } else {
        await setBadgeError(tabId, "Video changed — press Alt+P to pop it out again.");
      }
    } catch {
      await setBadgeError(tabId, "Video changed — press Alt+P to pop it out again.");
    }
  }, 1800);
}

let lastActiveTabId = null;

async function autoPipOnLeave(tabId) {
  if (tabId == null) return;
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !tab.url || isRestrictedUrl(tab.url)) return;
    const s = await getSettings();
    if (!s.autoPipOnSwitch) return;
    const rule = originOf(tab.url) ? (s.siteRules || {})[originOf(tab.url)] : undefined;
    if (rule === "never") return;
    const hasHosts = await chrome.permissions.contains({ origins: ["<all_urls>"] }).catch(() => false);
    if (!hasHosts) return;
    await toggleInTab(tabId, 0, null, true);
  } catch { return; }
}

async function handlePauseResume(previousTabId, currentTabId) {
  try {
    const s = await getSettings();
    if (s.autoPauseBackground && previousTabId != null) {
      const prevTab = await chrome.tabs.get(previousTabId).catch(() => null);
      if (prevTab && !isRestrictedUrl(prevTab.url)) {
        const rule = originOf(prevTab.url) ? (s.siteRules || {})[originOf(prevTab.url)] : undefined;
        if (rule !== "never") {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: previousTabId, allFrames: true },
              func: () => {
                for (const v of document.querySelectorAll("video")) {
                  try {
                    if (!v.paused && !v.ended) { v.dataset.popoutWasPlaying = "1"; v.pause(); }
                    else { delete v.dataset.popoutWasPlaying; }
                  } catch { return; }
                }
              }
            });
          } catch { return; }
        }
      }
    }
    if (s.resumeOnReturn && currentTabId != null) {
      const curTab = await chrome.tabs.get(currentTabId).catch(() => null);
      if (curTab && !isRestrictedUrl(curTab.url)) {
        const rule = originOf(curTab.url) ? (s.siteRules || {})[originOf(curTab.url)] : undefined;
        if (rule !== "never") {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: currentTabId, allFrames: true },
              func: () => {
                for (const v of document.querySelectorAll("video")) {
                  if (v.paused && v.dataset && v.dataset.popoutWasPlaying === "1") {
                    try { void v.play(); } catch { return; }
                  }
                }
              }
            });
          } catch { return; }
        }
      }
    }
  } catch { return; }
}

async function handleSleepAlarm(alarm) {
  if (alarm.name !== "popout-sleep") return;
  try {
    const data = await chrome.storage.session.get({ sleep: null });
    const sleep = data.sleep;
    if (!sleep || !sleep.tabId) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: sleep.tabId, allFrames: true },
        func: () => {
          for (const v of document.querySelectorAll("video")) { try { v.pause(); } catch { return; } }
          if (document.pictureInPictureElement) { try { document.exitPictureInPicture(); } catch { return; } }
          if (window.documentPictureInPicture && window.documentPictureInPicture.window) { try { window.documentPictureInPicture.window.close(); } catch { return; } }
        }
      });
    } catch { return; }
    await chrome.storage.session.remove("sleep");
    await chrome.alarms.clear("popout-sleep");
  } catch { return; }
}
chrome.alarms.onAlarm.addListener((alarm) => { void handleSleepAlarm(alarm); });

async function setSleep(minutes, tabId) {
  try { await chrome.alarms.clear("popout-sleep"); } catch { return { ok: false, error: "Could not set timer." }; }
  if (!minutes || minutes <= 0) {
    try { await chrome.storage.session.remove("sleep"); } catch { return; }
    return { ok: true, active: false };
  }
  const mins = Math.max(1, Math.min(240, Number(minutes) || 0));
  const endsAt = Date.now() + mins * 60 * 1000;
  try {
    await chrome.storage.session.set({ sleep: { minutes: mins, endsAt, tabId } });
    await chrome.alarms.create("popout-sleep", { when: endsAt });
  } catch { return { ok: false, error: "Could not set timer." }; }
  return { ok: true, active: true, minutes: mins, endsAt };
}

async function getSleep() {
  try {
    const data = await chrome.storage.session.get({ sleep: null });
    const sleep = data.sleep;
    if (!sleep) return { ok: true, active: false };
    return { ok: true, active: true, minutes: sleep.minutes, endsAt: sleep.endsAt, tabId: sleep.tabId };
  } catch {
    return { ok: true, active: false };
  }
}

async function proCommand(tabId, targets, command, value) {
  if (tabId == null) return { ok: false, error: "No tab found." };
  if (!targets || !targets.length) return { ok: false, error: "Select a video." };
  const byFrame = new Map();
  for (const t of targets) {
    const f = t.frameId ?? 0;
    if (!byFrame.has(f)) byFrame.set(f, []);
    if (Number.isInteger(t.index)) byFrame.get(f).push(t.index);
  }
  let count = 0;
  let dataUrl = null;
  let lastError = "";
  for (const [frameId, indices] of byFrame) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: (idxs, cmd, val) => { window.__popoutProIndices = idxs; window.__popoutProCmd = cmd; window.__popoutProValue = val; },
        args: [indices, command, value ?? null]
      });
      const res = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files: ["pro-controls.js"]
      });
      const r = res[0]?.result;
      if (r?.ok) {
        count += r.count || 0;
        if (r.dataUrl) dataUrl = r.dataUrl;
      } else {
        lastError = r?.error || "Failed.";
      }
    } catch (e) {
      lastError = e?.message || "Failed.";
    }
  }
  if (!count) return { ok: false, error: lastError || "Could not apply." };
  if (dataUrl) return { ok: true, count, dataUrl };
  return { ok: true, count };
}

function ytIdFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) {
      const id = u.pathname.slice(1).split("/")[0].split("?")[0];
      if (id && id.length >= 6) return id;
    }
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/\/embed\/([^/?]+)/);
      if (m) return m[1];
      const m2 = u.pathname.match(/\/shorts\/([^/?]+)/);
      if (m2) return m2[1];
    }
  } catch { return ""; }
  return "";
}

async function collectAllTabs() {
  const allTabs = await chrome.tabs.query({});
  const tabs = allTabs.filter((t) => t.url && !isRestrictedUrl(t.url));
  const results = [];
  for (const tab of tabs) {
    const found = await collectVideos(tab.id);
    const ytid = ytIdFromUrl(tab.url || "");
    results.push({
      id: tab.id,
      title: tab.title || tab.url || `Tab ${tab.id}`,
      url: tab.url || "",
      ytid: ytid || "",
      videos: found.ok ? found.videos : [],
      ok: found.ok,
      docPipOpen: !!found.docPipOpen
    });
  }
  results.sort((a, b) => (b.videos.length - a.videos.length) || (b.videos.some((v) => v.playing) ? 1 : 0) - (a.videos.some((v) => v.playing) ? 1 : 0));
  return results;
}

async function popAllTabsViaCapture(tabIds) {
  let okCount = 0;
  let errors = [];
  for (const tabId of tabIds) {
    try {
      await openCapture(tabId);
      okCount++;
      await new Promise((r) => setTimeout(r, 280));
    } catch (e) {
      errors.push(e?.message || "Failed");
    }
  }
  if (!okCount) return { ok: false, error: errors[0] || "Could not open floating windows. Try granting site access in Options." };
  return { ok: true, count: okCount };
}

async function popAllTabsViaPip(tabIds) {
  let okCount = 0;
  let lastError = "";
  let pipLimitedHit = false;
  for (const tabId of tabIds) {
    try {
      const res = await toggleInTab(tabId, 0);
      if (res?.ok) {
        okCount++;
        await new Promise((r) => setTimeout(r, 320));
      } else {
        lastError = res?.error || "Failed";
        if (lastError.toLowerCase().includes("picture-in-picture") && lastError.toLowerCase().includes("already")) pipLimitedHit = true;
      }
    } catch (e) {
      lastError = e?.message || "Failed";
    }
  }
  if (!okCount) return { ok: false, error: lastError || "No video could be popped. Try Capture windows or Video Wall." };
  if (pipLimitedHit && okCount === 1 && tabIds.length > 1) {
    return { ok: true, count: okCount, warning: "Chrome allows one native PiP at a time — only one stayed open. Use Floating windows (Capture) or Video Wall for 10+ at once." };
  }
  return { ok: true, count: okCount };
}

async function openWall(ids) {
  let list = (ids || []).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) {
    const tabs = await chrome.tabs.query({});
    const ytIds = tabs.map((t) => ytIdFromUrl(t.url || "")).filter(Boolean);
    list = [...new Set(ytIds)];
  }
  if (!list.length) return { ok: false, error: "No YouTube videos found. Open YouTube tabs like the links you sent, then try again." };
  if (list.length > 24) list = list.slice(0, 24);
  try {
    await chrome.storage.session.set({ wallIds: list });
  } catch { return { ok: false, error: "Could not prepare the wall." }; }
  try {
    await chrome.windows.create({ url: chrome.runtime.getURL("wall.html"), type: "popup", width: 1280, height: 760, focused: true });
  } catch (e) {
    return { ok: false, error: e?.message || "Could not open the wall window." };
  }
  return { ok: true, count: list.length };
}

chrome.tabs.onActivated.addListener((info) => {
  const previous = lastActiveTabId;
  lastActiveTabId = info.tabId;
  if (previous != null && previous !== info.tabId) {
    void autoPipOnLeave(previous);
    void handlePauseResume(previous, info.tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void forgetPipTab(tabId);
  if (lastActiveTabId === tabId) lastActiveTabId = null;
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId === 0) void maybeRepopout(details.tabId, details.url);
});
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0) void maybeRepopout(details.tabId, details.url);
});

async function openCapture(sourceTabId) {
  if (sourceTabId == null) throw new Error("No active tab found.");
  const s = await getSettings();
  const win = await chrome.windows.create({ url: "about:blank", type: "popup", width: 960, height: 640, focused: false });
  const consumerTabId = win.tabs?.[0]?.id;
  if (consumerTabId == null) throw new Error("Could not open the popout window.");
  try {
    await chrome.storage.session.set({
      [`capture:${consumerTabId}`]: { sourceTabId, audio: s.captureAudio }
    });
    await chrome.tabs.update(consumerTabId, { url: chrome.runtime.getURL("capture.html") });
    await chrome.windows.update(win.id, { focused: true });
  } catch (error) {
    try { await chrome.storage.session.remove(`capture:${consumerTabId}`); } catch { return; }
    throw error;
  }
  return { ok: true };
}

async function handleCaptureReady(sender) {
  const consumerTabId = sender?.tab?.id;
  const senderUrl = sender?.url || sender?.tab?.url || "";
  if (consumerTabId == null) throw new Error("Unknown capture window.");
  if (!senderUrl.startsWith(chrome.runtime.getURL("capture.html"))) {
    throw new Error("Unexpected capture sender.");
  }
  const key = `capture:${consumerTabId}`;
  let saved = null;
  try {
    const data = await chrome.storage.session.get(key);
    saved = data[key];
  } catch { saved = null; }
  try { await chrome.storage.session.remove(key); } catch { return; }
  if (!saved?.sourceTabId) throw new Error("Capture session expired. Please try again.");
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: saved.sourceTabId,
    consumerTabId
  });
  return { ok: true, streamId, audio: !!saved.audio, sourceTabId: saved.sourceTabId };
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "popout-video") {
    void toggleInTab(tab?.id, info.frameId ?? 0);
  } else if (info.menuItemId === "popout-all") {
    void (async () => {
      if (tab?.id == null) return;
      const found = await collectVideos(tab.id);
      if (!found.ok) {
        await setBadgeError(tab.id, found.error);
        return;
      }
      const frameId = info.frameId ?? 0;
      const targets = found.videos.filter((v) => (v.frameId ?? 0) === frameId && v.ready);
      const fallback = targets.length ? targets : found.videos.filter((v) => (v.frameId ?? 0) === frameId);
      if (!fallback.length) {
        await setBadgeError(tab.id, "No ready videos in this frame.");
        return;
      }
      await popMultiple(tab.id, fallback);
    })();
  } else if (info.menuItemId === "popout-tab") {
    if (tab?.id != null) {
      void openCapture(tab.id).catch((e) => setBadgeError(tab.id, e?.message));
    }
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (command === "toggle-pip") {
      await toggleInTab(tab?.id, 0);
    } else if (command === "popout-tab") {
      await openCapture(tab?.id);
    }
  } catch { return; }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.type) return;
    if (msg.type === "LIST_VIDEOS") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id == null) {
        sendResponse({ ok: false, videos: [], error: "No active tab found." });
        return;
      }
      const found = await collectVideos(tab.id);
      void ensureOverlay(tab.id);
      if (!found.ok) {
        sendResponse({ ...found, origin: originOf(tab.url || ""), siteRule: "default" });
        return;
      }
      const s = await getSettings();
      const origin = originOf(tab.url || "");
      const siteRule = (origin && s.siteRules && s.siteRules[origin]) || "default";
      sendResponse({ ...found, origin, siteRule });
      return;
    }
    if (msg.type === "POP_VIDEO") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      sendResponse(await toggleInTab(tab?.id, msg.frameId ?? 0, msg.index ?? null));
      return;
    }
    if (msg.type === "POP_VIDEOS") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      sendResponse(await popMultiple(tab?.id, msg.targets || []));
      return;
    }
    if (msg.type === "VIDEO_COMMAND") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      sendResponse(await controlVideos(tab?.id, msg.targets || [], msg.command, msg.value));
      return;
    }
    if (msg.type === "SET_SITE_RULE") {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const origin = msg.origin || originOf(tab?.url || "");
        if (!origin) throw new Error("Cannot determine this site.");
        const s = await getSettings();
        const rules = { ...(s.siteRules || {}) };
        if (!msg.rule || msg.rule === "default") delete rules[origin];
        else rules[origin] = msg.rule;
        await chrome.storage.sync.set({ siteRules: rules });
        sendResponse({ ok: true, origin, siteRule: rules[origin] || "default" });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || "Could not save the site rule." });
      }
      return;
    }
    if (msg.type === "OVERLAY_POP") {
      const tabId = sender?.tab?.id;
      const frameId = sender?.frameId ?? 0;
      sendResponse(await toggleInTab(tabId, frameId, msg.index ?? null));
      return;
    }
    if (msg.type === "PRO_COMMAND") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      sendResponse(await proCommand(tab?.id, msg.targets || [], msg.command, msg.value));
      return;
    }
    if (msg.type === "SET_SLEEP") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      sendResponse(await setSleep(msg.minutes, tab?.id));
      return;
    }
    if (msg.type === "GET_SLEEP") {
      sendResponse(await getSleep());
      return;
    }
    if (msg.type === "OPEN_SIDE_PANEL") {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId });
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || "Could not open Theater." });
      }
      return;
    }
    if (msg.type === "CAPTURE_TAB") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      try {
        await openCapture(tab?.id);
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || "Could not pop out this tab." });
      }
      return;
    }
    if (msg.type === "CAPTURE_READY") {
      try {
        sendResponse(await handleCaptureReady(sender));
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || "Capture failed." });
      }
      return;
    }
    if (msg.type === "LIST_ALL_TABS") {
      try {
        const hasTabs = await chrome.permissions.contains({ origins: ["<all_urls>"] }).catch(() => false);
        if (!hasTabs) {
          sendResponse({ ok: false, error: "Grant site access in Options to scan all tabs, or open YouTube tabs and use Video Wall.", tabs: [] });
          return;
        }
        sendResponse({ ok: true, tabs: await collectAllTabs() });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || "Could not scan tabs.", tabs: [] });
      }
      return;
    }
    if (msg.type === "POP_ALL_TABS") {
      try {
        const hasHosts = await chrome.permissions.contains({ origins: ["<all_urls>"] }).catch(() => false);
        if (!hasHosts) {
          const granted = await chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => false);
          if (!granted) throw new Error("Site access is needed to pop videos from other tabs. Grant it in Options and try again.");
        }
        let tabIds = Array.isArray(msg.tabIds) ? msg.tabIds.filter((n) => Number.isInteger(n)) : null;
        if (!tabIds || !tabIds.length) {
          const all = await collectAllTabs();
          let filtered = all.filter((t) => t.videos.length);
          if (msg.youtubeOnly) filtered = filtered.filter((t) => t.ytid);
          if (msg.limit) filtered = filtered.slice(0, msg.limit);
          tabIds = filtered.map((t) => t.id);
        }
        if (!tabIds.length) throw new Error("No tabs with videos found. Open the YouTube links you sent, play each, then try again.");
        const mode = msg.mode === "capture" ? "capture" : "pip";
        const res = mode === "capture" ? await popAllTabsViaCapture(tabIds) : await popAllTabsViaPip(tabIds);
        sendResponse(res);
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || "Could not pop all tabs." });
      }
      return;
    }
    if (msg.type === "OPEN_WALL") {
      try {
        const ids = Array.isArray(msg.ids) ? msg.ids : null;
        sendResponse(await openWall(ids));
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || "Could not open wall." });
      }
      return;
    }
  })();
  return true;
});

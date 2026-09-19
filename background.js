const DEFAULTS = {
  searchIframes: true,
  showPicker: true,
  hoverButtons: true,
  showContextMenu: true
};

async function getSettings() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
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
  } catch { return; }
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureMenus();
  try { chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") }); } catch { return; }
});
chrome.runtime.onStartup.addListener(() => {
  void ensureMenus();
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

async function toggleInTab(tabId, frameId = 0, videoIndex = null) {
  if (tabId == null) return { ok: false, error: "No tab found." };
  try {
    if (videoIndex != null) {
      try { await setTargetIndex(tabId, frameId, videoIndex); } catch { return; }
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ["pip.js"]
    });
    const result = results[0]?.result;
    if (!result?.ok) return { ok: false, code: result?.code, error: result?.error || "Could not pop out this video." };
    await clearBadge(tabId);
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
    for (const r of results || []) {
      const payload = r?.result;
      const list = Array.isArray(payload) ? payload : (payload?.videos || []);
      for (const v of list) {
        videos.push({ frameId: r.frameId ?? 0, ...v });
      }
    }
    videos.sort((a, b) => {
      if (a.playing !== b.playing) return a.playing ? -1 : 1;
      if (a.inPip !== b.inPip) return a.inPip ? -1 : 1;
      return (b.width * b.height) - (a.width * a.height);
    });
    return { ok: true, videos };
  } catch (error) {
    return { ok: false, error: error?.message || "Cannot access this page.", videos: [] };
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
              if (cmd === "toggle-play") { if (v.paused) { void v.play(); } else { v.pause(); } n++; }
              else if (cmd === "toggle-mute") { v.muted = !v.muted; n++; }
              else if (cmd === "volume") { v.muted = false; v.volume = Math.max(0, Math.min(1, Number(val))); n++; }
              else if (cmd === "seek") { v.currentTime = Math.max(0, (v.currentTime || 0) + Number(val || 0)); n++; }
              else if (cmd === "rate") { v.playbackRate = Number(val) || 1; n++; }
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

// Runs in the page MAIN world: Web Audio createMediaElementSource only
// affects audible output from MAIN. ISOLATED world hooks stay silent,
// which is why boost previously reported success but changed nothing.
async function runProAudioMain(idxs, cmd, val) {
  try {
    if (!["boost", "eq", "get-state", "noise"].includes(cmd)) return { ok: false, error: "Unknown audio command." };
    const videos = Array.from(document.querySelectorAll("video"));
    const targets = (Array.isArray(idxs) && idxs.length ? idxs.map((i) => videos[i]).filter(Boolean) : videos);
    if (!targets.length) return { ok: false, error: "No video found." };
    if (!window.__popoutAudioMap) window.__popoutAudioMap = new WeakMap();
    if (!window.__popoutAudioState) window.__popoutAudioState = new WeakMap();


    function makeFilter(ctx, type, freq, q) {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      if (q) f.Q.value = q;
      f.gain.value = 0;
      return f;
    }
    function ensureAudio(video) {
      if (window.__popoutAudioMap.has(video)) return { rec: window.__popoutAudioMap.get(video) };
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return { error: "Web Audio not supported on this page." };
        const ctx = new AC();
        const src = ctx.createMediaElementSource(video);
        const low = makeFilter(ctx, "lowshelf", 110);
        const mid1 = makeFilter(ctx, "peaking", 400, 0.9);
        const mid2 = makeFilter(ctx, "peaking", 1200, 0.9);
        const mid3 = makeFilter(ctx, "peaking", 4000, 0.9);
        const high = makeFilter(ctx, "highshelf", 9500);
        const preGain = ctx.createGain();
        preGain.gain.value = 1;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -12;
        comp.knee.value = 0;
        comp.ratio.value = 20;
        comp.attack.value = 0.003;
        comp.release.value = 0.15;
        src.connect(low);
        low.connect(mid1); mid1.connect(mid2); mid2.connect(mid3); mid3.connect(high);
        high.connect(preGain); preGain.connect(comp); comp.connect(ctx.destination);
        const rec = { ctx, preGain, low, mid1, mid2, mid3, high, comp, src };
        window.__popoutAudioMap.set(video, rec);
        if (!window.__popoutAudioState.has(video)) window.__popoutAudioState.set(video, { boost: 100, eq: "flat", noise: false });
        return { rec };
      } catch (e) {
        const msg = (e && e.message) || "";
        if (/already|InvalidState|mediaElementSource/i.test(msg)) {
          return { error: "This video is already hooked. Reload the page, then set boost once." };
        }
        return { error: msg || "Could not hook audio." };
      }
    }
    const PRESETS = {
      flat: [0, 0, 0, 0, 0],
      bass: [10, 4, 0, -1, 1],
      vocal: [-3, -1, 4, 5, 4],
      treble: [-5, -2, 0, 4, 8],
      loud: [7, 3, 1, 3, 6],
      night: [-1, 0, -1, -2, -3]
    };
    function applyEQ(rec, name) {
      const p = PRESETS[name] || PRESETS.flat;
      const t = rec.ctx.currentTime;
      rec.low.gain.setTargetAtTime(p[0], t, 0.02);
      rec.mid1.gain.setTargetAtTime(p[1], t, 0.02);
      rec.mid2.gain.setTargetAtTime(p[2], t, 0.02);
      rec.mid3.gain.setTargetAtTime(p[3], t, 0.02);
      rec.high.gain.setTargetAtTime(p[4], t, 0.02);
      if (name === "night") {
        rec.comp.threshold.setTargetAtTime(-26, t, 0.05);
        rec.comp.ratio.setTargetAtTime(12, t, 0.05);
      } else if (name === "loud") {
        rec.comp.threshold.setTargetAtTime(-16, t, 0.05);
        rec.comp.ratio.setTargetAtTime(20, t, 0.05);
      } else {
        rec.comp.threshold.setTargetAtTime(-12, t, 0.05);
        rec.comp.ratio.setTargetAtTime(20, t, 0.05);
      }
    }
    function getState(video) {
      const st = window.__popoutAudioState.get(video) || { boost: 100, eq: "flat", noise: false };
      const hooked = window.__popoutAudioMap.has(video);
      const ctxState = hooked ? window.__popoutAudioMap.get(video).ctx.state : "unhooked";
      return { boost: st.boost, eq: st.eq, noise: st.noise, hooked, ctxState };
    }
    if (cmd === "get-state") {
      const states = targets.map((v) => getState(v));
      return { ok: true, count: targets.length, state: states[0], states };
    }
    let count = 0;
    let lastError = "";
    for (const v of targets) {
      const out = ensureAudio(v);
      if (out.error || !out.rec) { lastError = out.error || "Could not hook audio."; continue; }
      const rec = out.rec;
      try {
        if (rec.ctx.state === "suspended") {
          try { await rec.ctx.resume(); } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
      if (rec.ctx.state === "suspended") {
        lastError = "Browser blocked audio: click Play on the video once, keep it playing, then set boost again.";
        continue;
      }
      const st = window.__popoutAudioState.get(v) || { boost: 100, eq: "flat", noise: false };
      if (cmd === "boost") {
        const pct = Math.max(100, Math.min(400, Number(val) || 100));
        rec.preGain.gain.setTargetAtTime(pct / 100, rec.ctx.currentTime, 0.02);
        st.boost = pct;
        window.__popoutAudioState.set(v, st);
        count++;
      } else if (cmd === "eq") {
        const name = String(val || "flat");
        applyEQ(rec, name);
        st.eq = name;
        window.__popoutAudioState.set(v, st);
        count++;
      } else if (cmd === "noise") {
        const on = Boolean(val);
        const t = rec.ctx.currentTime;
        if (on) {
          rec.comp.threshold.setTargetAtTime(-28, t, 0.05);
          rec.comp.ratio.setTargetAtTime(8, t, 0.05);
          rec.comp.knee.setTargetAtTime(0, t, 0.05);
          rec.comp.attack.setTargetAtTime(0.001, t, 0.05);
          rec.comp.release.setTargetAtTime(0.08, t, 0.05);
        } else {
          const eqName = st.eq || "flat";
          applyEQ(rec, eqName);
        }
        st.noise = on;
        window.__popoutAudioState.set(v, st);
        count++;
      }
    }
    if (!count) return { ok: false, error: lastError || "Could not apply. Click Play first, then try again." };
    return { ok: true, count };
  } catch (e) {
    return { ok: false, error: (e && e.message) || "Audio failed." };
  }
}

async function proCommand(tabId, targets, command, value) {
  if (tabId == null) return { ok: false, error: "No tab found." };
  if (!targets || !targets.length) return { ok: false, error: "Select a video." };
  if (!["boost", "eq", "get-state", "noise"].includes(command)) return { ok: false, error: "Unknown audio command." };
  const byFrame = new Map();
  for (const t of targets) {
    const f = t.frameId ?? 0;
    if (!byFrame.has(f)) byFrame.set(f, []);
    if (Number.isInteger(t.index)) byFrame.get(f).push(t.index);
  }
  let count = 0;
  let lastError = "";
  let gotState = null;
  for (const [frameId, indices] of byFrame) {
    try {
      // MAIN world first: only MAIN-world Web Audio is audible.
      let r = null;
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          world: "MAIN",
          func: runProAudioMain,
          args: [indices, command, value ?? null]
        });
        r = res[0]?.result;
      } catch (mainErr) {
        // Fallback to legacy file-based ISOLATED injection
        try {
          await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frameId] },
            func: (idxs, cmd, val) => { window.__popoutProIndices = idxs; window.__popoutProCmd = cmd; window.__popoutProValue = val; },
            args: [indices, command, value ?? null]
          });
          const res2 = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frameId] },
            files: ["pro-controls.js"]
          });
          r = res2[0]?.result;
          if (r?.ok) r.fallback = true;
        } catch (e2) {
          lastError = mainErr?.message || e2?.message || "Failed.";
          continue;
        }
      }
      if (r?.ok) {
        count += r.count || 0;
        if (command === "get-state" && r.state) {
          gotState = r.state;
          if (r.fallback) gotState.fallback = true;
          return { ok: true, count, state: gotState };
        }
      } else {
        lastError = r?.error || "Failed.";
      }
    } catch (e) {
      lastError = e?.message || "Failed.";
    }
  }
  if (!count) return { ok: false, error: lastError || "Could not apply." };
  return { ok: true, count };
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "popout-video") {
    void toggleInTab(tab?.id, info.frameId ?? 0);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (command === "toggle-pip") {
      await toggleInTab(tab?.id, 0);
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
      sendResponse(found);
      return;
    }
    if (msg.type === "POP_VIDEO") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      sendResponse(await toggleInTab(tab?.id, msg.frameId ?? 0, msg.index ?? null));
      return;
    }
    if (msg.type === "VIDEO_COMMAND") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      sendResponse(await controlVideos(tab?.id, msg.targets || [], msg.command, msg.value));
      return;
    }
    if (msg.type === "PRO_COMMAND") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      sendResponse(await proCommand(tab?.id, msg.targets || [], msg.command, msg.value));
      return;
    }
    if (msg.type === "OVERLAY_POP") {
      const tabId = sender?.tab?.id;
      const frameId = sender?.frameId ?? 0;
      sendResponse(await toggleInTab(tabId, frameId, msg.index ?? null));
      return;
    }
  })();
  return true;
});

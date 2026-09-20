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
  // Chrome blocks these unconditionally — cannot be fixed by permissions
  // file:// is NOT included: it works if user enables "Allow access to file URLs" (with <all_urls>)
  return !url || url.startsWith("chrome://") || url.startsWith("edge://") ||
    url.startsWith("about:") || url.startsWith("chrome-extension://") ||
    url.startsWith("chrome-search://") || url.startsWith("view-source:") ||
    url.startsWith("moz-extension://");
}

async function getTabInfo(tabId) {
  try {
    if (tabId != null) return await chrome.tabs.get(tabId);
  } catch { /* ignore */ }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch { return null; }
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
  // Guard restricted URLs early for clearer error (file:// allowed if user enabled it)
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const url = tab?.url || tab?.pendingUrl || "";
    if (isRestrictedUrl(url)) {
      return { ok: false, error: "Chrome blocks this page (chrome://, Web Store, extension pages). PiP is not allowed here — try a regular http/https video page." };
    }
    if (url.startsWith("file://")) {
      // Will fail if user hasn't enabled file access; we try anyway and give guidance on failure
    }
  } catch { /* ignore */ }

  const tryFrame = async (fId, idx) => {
    try {
      if (idx != null) {
        try { await setTargetIndex(tabId, fId, idx); } catch (e) { return { ok: false, error: e?.message || "Cannot access frame." }; }
      }
      const results = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [fId] },
        files: ["pip.js"]
      });
      const result = results[0]?.result;
      if (!result?.ok) return { ok: false, code: result?.code, error: result?.error || "Could not pop out this video." };
      await clearBadge(tabId);
      return { ok: true, action: result.action };
    } catch (error) {
      let message = error?.message || "Cannot access this page.";
      if (/Cannot access contents of url|file url/i.test(message) && message.includes("file://")) {
        message = "For file:// pages, enable \"Allow access to file URLs\" in chrome://extensions, then reload.";
      }
      await setBadgeError(tabId, message);
      return { ok: false, error: message };
    }
  };

  // 1) Try requested frame first
  const first = await tryFrame(frameId, videoIndex);
  if (first.ok) return first;

  // 2) If generic pop (no index) failed on frame 0, fallback: try every frame that has videos
  // This makes popup "Pop out video" work when video is inside an iframe (common on embed sites)
  if (videoIndex == null) {
    try {
      const s = await getSettings();
      // Collect across frames to find candidates
      const all = await chrome.scripting.executeScript({
        target: { tabId, allFrames: s.searchIframes },
        files: ["collect-videos.js"]
      }).catch(() => []);
      const candidates = [];
      for (const r of all || []) {
        const payload = r?.result;
        const list = Array.isArray(payload) ? payload : (payload?.videos || []);
        for (const v of list) {
          // prefer playing/visible videos
          const score = (v.playing ? 1000 : 0) + (v.visible ? 500 : 0) + (v.width * v.height);
          candidates.push({ frameId: r.frameId ?? 0, index: v.index ?? 0, score, v });
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      // try top 3 frames (avoid hammering)
      for (const c of candidates.slice(0, 5)) {
        if (c.frameId === frameId) continue; // already tried
        const res = await tryFrame(c.frameId, c.index);
        if (res.ok) return res;
        // if NEEDS_GESTURE, don't try further — will fail everywhere
        if (res.code === "NEEDS_GESTURE") return res;
      }
    } catch { /* ignore */ }
    // return original error if no fallback succeeded
    return first;
  }

  return first;
}

async function collectVideos(tabId) {
  if (tabId == null) return { ok: false, error: "No tab found.", videos: [] };
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const url = tab?.url || tab?.pendingUrl || "";
    if (isRestrictedUrl(url)) {
      return { ok: false, error: "Chrome blocks this page (chrome://, Web Store, extension pages). Try a regular http/https video page.", videos: [] };
    }
    // file://: don't block early — try injection; if it fails we show guidance below
  } catch { /* ignore */ }

  const s = await getSettings();
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: s.searchIframes },
      files: ["collect-videos.js"]
    });
    const videos = [];
    const seenFrames = new Set();
    for (const r of results || []) {
      seenFrames.add(r.frameId ?? 0);
      const payload = r?.result;
      if (!payload) continue;
      const list = Array.isArray(payload) ? payload : (payload?.videos || []);
      for (const v of list) videos.push({ frameId: r.frameId ?? 0, ...v });
    }

    // If ISOLATED scan found nothing (common for closed shadow / hook-only videos), fallback to MAIN world registry scan
    if (!videos.length) {
      try {
        // Ensure MAIN registry script is injected (for pages open before install)
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: s.searchIframes },
          world: "MAIN",
          files: ["main-registry.js"]
        }).catch(() => {});
        const mainResults = await chrome.scripting.executeScript({
          target: { tabId, allFrames: s.searchIframes },
          world: "MAIN",
          func: () => {
            try {
              if (typeof window.__popoutCollectMain === "function") {
                const vids = window.__popoutCollectMain();
                return vids.map((v, idx) => {
                  let rect = { width: 0, height: 0 };
                  try { rect = v.getBoundingClientRect(); } catch {}
                  const playing = !v.paused && !v.ended;
                  const visible = rect.width > 10 && rect.height > 10;
                  const ready = v.readyState > 0 && (v.videoWidth > 0 || v.readyState >= 2);
                  let label = v.getAttribute("aria-label") || v.title || "";
                  if (!label && document.title && location.hostname.includes("youtube.com")) label = document.title.replace(/ - YouTube$/, "").slice(0, 48);
                  if (!label) label = `Video ${idx + 1}`;
                  return {
                    index: idx,
                    label,
                    width: Math.round(rect.width || v.videoWidth || 0),
                    height: Math.round(rect.height || v.videoHeight || 0),
                    playing, visible, ready,
                    muted: !!v.muted,
                    volume: typeof v.volume === "number" ? v.volume : 1,
                    loop: !!v.loop,
                    rate: v.playbackRate || 1,
                    currentTime: Math.round(v.currentTime || 0),
                    duration: Number.isFinite(v.duration) ? Math.round(v.duration) : 0,
                    isAd: false,
                    drm: !!(v.mediaKeys || v.webkitKeys),
                    inPip: document.pictureInPictureElement === v
                  };
                });
              }
              // fallback bare query
              const vids = Array.from(document.querySelectorAll("video"));
              return vids.map((v, idx) => {
                let rect = { width: 0, height: 0 };
                try { rect = v.getBoundingClientRect(); } catch {}
                return {
                  index: idx, label: v.title || `Video ${idx + 1}`,
                  width: Math.round(rect.width || 0), height: Math.round(rect.height || 0),
                  playing: !v.paused && !v.ended, visible: rect.width > 10, ready: v.readyState > 0,
                  muted: !!v.muted, volume: v.volume || 1, loop: !!v.loop, rate: v.playbackRate || 1,
                  currentTime: Math.round(v.currentTime || 0), duration: Math.round(v.duration || 0), isAd: false, drm: false, inPip: document.pictureInPictureElement === v
                };
              });
            } catch (e) { return { error: e.message }; }
          }
        }).catch(() => []);
        for (const r of mainResults || []) {
          const payload = r?.result;
          if (!payload || payload.error) continue;
          const list = Array.isArray(payload) ? payload : (payload?.videos || []);
          for (const v of list) {
            // avoid duplicating frames already covered
            const key = `${r.frameId}:${v.index}`;
            if (!videos.some(x => `${x.frameId}:${x.index}` === key)) {
              videos.push({ frameId: r.frameId ?? 0, ...v, fromMain: true });
            }
          }
        }
      } catch {}
    }

    videos.sort((a, b) => {
      if (a.playing !== b.playing) return a.playing ? -1 : 1;
      if (a.inPip !== b.inPip) return a.inPip ? -1 : 1;
      return (b.width * b.height) - (a.width * a.height);
    });
    return { ok: true, videos };
  } catch (error) {
    const msg = error?.message || "Cannot access this page.";
    if (/Cannot access contents of url|No tab with id|Cannot access a chrome/i.test(msg)) {
      if (msg.includes("file://") || msg.toLowerCase().includes("file url")) {
        return { ok: false, error: "For file:// pages, enable \"Allow access to file URLs\" for this extension in chrome://extensions, then reload the page.", videos: [] };
      }
      return { ok: false, error: "Cannot access this page. If you just updated, reload the extension and the page, then try again.", videos: [] };
    }
    return { ok: false, error: msg, videos: [] };
  }
}

async function controlVideos(tabId, targets, command, value) {
  if (tabId == null) return { ok: false, error: "No tab found." };
  if (!targets || !targets.length) return { ok: false, error: "Select at least one video." };
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const url = tab?.url || "";
    if (isRestrictedUrl(url)) {
      return { ok: false, error: "Chrome blocks this page." };
    }
  } catch { /* ignore */ }
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
          // shadow-aware collection (matches pip.js / main-registry)
          function collect() {
            const bucket = []; const seen = new Set();
            function deep(root) {
              try {
                const vids = root.querySelectorAll ? root.querySelectorAll("video") : [];
                for (const v of vids) if (!seen.has(v)) { seen.add(v); bucket.push(v); }
                const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
                for (const el of all) {
                  const sr = el.shadowRoot || el.__popoutShadow;
                  if (sr) deep(sr);
                  if (el.tagName === "SLOT" && el.assignedElements) {
                    try {
                      const assigned = el.assignedElements({ flatten: true });
                      for (const a of assigned) {
                        if (a.tagName === "VIDEO" && !seen.has(a)) { seen.add(a); bucket.push(a); }
                        if (a.querySelectorAll) { const inner = a.querySelectorAll("video"); for (const v of inner) if (!seen.has(v)) { seen.add(v); bucket.push(v); } }
                        const sr2 = a.shadowRoot || a.__popoutShadow;
                        if (sr2) deep(sr2);
                      }
                    } catch {}
                  }
                }
              } catch {}
            }
            deep(document);
            try { if (window.__popoutRegistry) for (const v of window.__popoutRegistry) if (v && v.tagName === "VIDEO" && !seen.has(v)) { seen.add(v); bucket.push(v); } } catch {}
            try { if (window.__popoutCollectMain) { const m = window.__popoutCollectMain(); for (const v of m) if (!seen.has(v)) { seen.add(v); bucket.push(v); } } } catch {}
            if (document.pictureInPictureElement && !seen.has(document.pictureInPictureElement)) bucket.push(document.pictureInPictureElement);
            return bucket;
          }
          const vids = collect();
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
    // content_scripts already injects page-overlay.js on <all_urls>, but keep this
    // for pages that were open before install/update where content_scripts hasn't run yet
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
    function collectMainVideos() {
      const bucket = []; const seen = new Set();
      function deep(root) {
        try {
          const vids = root.querySelectorAll ? root.querySelectorAll("video") : [];
          for (const v of vids) if (!seen.has(v)) { seen.add(v); bucket.push(v); }
          const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
          for (const el of all) {
            const sr = el.shadowRoot || el.__popoutShadow;
            if (sr) deep(sr);
          }
        } catch {}
      }
      deep(document);
      try { if (window.__popoutRegistry) for (const v of window.__popoutRegistry) if (v && v.tagName === "VIDEO" && !seen.has(v)) { seen.add(v); bucket.push(v); } } catch {}
      try { if (window.__popoutCollectMain) { const m = window.__popoutCollectMain(); for (const v of m) if (!seen.has(v)) { seen.add(v); bucket.push(v); } } } catch {}
      if (document.pictureInPictureElement && !seen.has(document.pictureInPictureElement)) bucket.push(document.pictureInPictureElement);
      return bucket;
    }
    const videos = collectMainVideos();
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
      const res = await toggleInTab(tab?.id, 0);
      if (!res.ok && res.code === "NEEDS_GESTURE" && tab?.id != null) {
        // Can't auto-resolve gesture from background; hint via badge
        await setBadgeError(tab.id, res.error);
      }
    }
  } catch { return; }
});

async function captionCommand(tabId, targets, enable) {
  if (tabId == null) return { ok: false, error: "No tab found." };
  if (!targets || !targets.length) return { ok: false, error: "Select a video." };
  const byFrame = new Map();
  for (const t of targets) {
    const f = t.frameId ?? 0;
    if (!byFrame.has(f)) byFrame.set(f, []);
    if (Number.isInteger(t.index)) byFrame.get(f).push(t.index);
  }
  let count = 0;
  let lastError = "";
  for (const [frameId, indices] of byFrame) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: (idxs, shouldEnable) => {
          function collect() {
            const bucket = []; const seen = new Set();
            function deep(root) {
              try {
                const vids = root.querySelectorAll ? root.querySelectorAll("video") : [];
                for (const v of vids) if (!seen.has(v)) { seen.add(v); bucket.push(v); }
                const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
                for (const el of all) {
                  const sr = el.shadowRoot || el.__popoutShadow;
                  if (sr) deep(sr);
                }
              } catch {}
            }
            deep(document);
            try { if (window.__popoutRegistry) for (const v of window.__popoutRegistry) if (v && !seen.has(v)) bucket.push(v); } catch {}
            return bucket;
          }
          const vids = collect();
          const targets = idxs.length ? idxs.map(i => vids[i]).filter(Boolean) : vids;
          if (!targets.length) return { ok: false, error: "No video found." };
          let n = 0;
          for (const v of targets) {
            try {
              if (shouldEnable === false) {
                const tracks = v.textTracks ? Array.from(v.textTracks) : [];
                for (const t of tracks) t.mode = "hidden";
                if (v.__popoutCaptionTrack) v.__popoutCaptionTrack.mode = "hidden";
                if (v.__popoutCaptionObserver) { try { v.__popoutCaptionObserver.disconnect(); } catch {} v.__popoutCaptionObserver = null; }
                n++;
              } else {
                // use bridge if available, else direct
                if (typeof window.__popoutEnableCaptions === "function") {
                  const r = window.__popoutEnableCaptions([vids.indexOf(v)], true);
                  if (r && r.ok) n++;
                  else {
                    // fallback direct enable
                    const tracks = v.textTracks ? Array.from(v.textTracks) : [];
                    let en = false;
                    for (const t of tracks) if (t.kind === "captions" || t.kind === "subtitles") { t.mode = "showing"; en = true; break; }
                    if (en) n++;
                  }
                } else {
                  const tracks = v.textTracks ? Array.from(v.textTracks) : [];
                  let en = false;
                  for (const t of tracks) if (t.kind === "captions" || t.kind === "subtitles") { t.mode = "showing"; en = true; break; }
                  if (en) n++; else {
                    // try inject from YouTube overlay
                    const host = location.hostname || "";
                    if (host.includes("youtube.com")) {
                      const seg = document.querySelector(".ytp-caption-segment");
                      if (seg && seg.textContent.trim()) {
                        try {
                          const tr = v.__popoutCaptionTrack || v.addTextTrack("captions", "Popout", "en");
                          tr.mode = "showing";
                          v.__popoutCaptionTrack = tr;
                          const cue = new VTTCue(v.currentTime || 0, (v.currentTime || 0) + 5, seg.textContent.trim());
                          tr.addCue(cue);
                          n++;
                        } catch {}
                      } else {
                        // no captions visible
                      }
                    }
                  }
                }
              }
            } catch (e) { lastError = e.message; }
          }
          if (!n) return { ok: false, error: "No captions found. Turn on CC on the page first." };
          return { ok: true, count: n };
        },
        args: [indices, enable !== false]
      });
      const r = res[0]?.result;
      if (r?.ok) count += r.count;
      else lastError = r?.error || lastError;
    } catch (e) { lastError = e.message || "Failed."; }
  }
  if (!count) return { ok: false, error: lastError || "Could not toggle captions." };
  return { ok: true, count };
}

async function grabCaptions(tabId, targets) {
  if (tabId == null) return { ok: false, error: "No tab found." };
  if (!targets || !targets.length) return { ok: false, error: "Select a video." };
  const byFrame = new Map();
  for (const t of targets) {
    const f = t.frameId ?? 0;
    if (!byFrame.has(f)) byFrame.set(f, []);
    if (Number.isInteger(t.index)) byFrame.get(f).push(t.index);
  }
  const all = [];
  for (const [frameId, indices] of byFrame) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: (idxs) => {
          if (typeof window.__popoutGrabCaptions === "function") {
            return window.__popoutGrabCaptions(idxs);
          }
          // fallback direct
          const vids = Array.from(document.querySelectorAll("video"));
          const tgts = idxs.length ? idxs.map(i => vids[i]).filter(Boolean) : vids.slice(0, 1);
          const out = [];
          for (const v of tgts) {
            const tracks = v.textTracks ? Array.from(v.textTracks) : [];
            const cues = [];
            for (const t of tracks) {
              try {
                if (t.cues) for (const c of Array.from(t.cues)) cues.push({ start: c.startTime, end: c.endTime, text: c.text, kind: t.kind, lang: t.language });
              } catch {}
            }
            if (v.__popoutCaptionTrack && v.__popoutCaptionTrack.cues) {
              for (const c of Array.from(v.__popoutCaptionTrack.cues)) cues.push({ start: c.startTime, end: c.endTime, text: c.text, injected: true });
            }
            // current overlay text
            let custom = "";
            try {
              const seg = document.querySelector(".ytp-caption-segment");
              if (seg) custom = seg.textContent.trim();
            } catch {}
            out.push({ label: v.title || "", cues, customText: custom });
          }
          return { ok: true, captions: out };
        },
        args: [indices]
      });
      const r = res[0]?.result;
      if (r?.ok && r.captions) all.push(...r.captions.map(c => ({ frameId, ...c })));
    } catch {}
  }
  if (!all.length) return { ok: false, error: "No captions found. Enable CC on the page, then try again." };
  return { ok: true, captions: all };
}

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
      // ensure caption bridge is available for grab/toggle
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: "MAIN", files: ["captions.js"] }).catch(() => {});
      } catch {}
      sendResponse(found);
      return;
    }
    if (msg.type === "POP_VIDEO") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id == null) {
        sendResponse({ ok: false, error: "No tab found." });
        return;
      }
      // msg.frameId/index may be missing for generic pop -> let toggleInTab fallback across frames
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
    if (msg.type === "CAPTION_TOGGLE") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      // ensure bridge
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: "MAIN", files: ["captions.js"] }).catch(() => {}); } catch {}
      sendResponse(await captionCommand(tab?.id, msg.targets || [], msg.enable !== false));
      return;
    }
    if (msg.type === "CAPTION_GET") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: "MAIN", files: ["captions.js"] }).catch(() => {}); } catch {}
      sendResponse(await grabCaptions(tab?.id, msg.targets || []));
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

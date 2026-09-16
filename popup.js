const popBtn = document.getElementById("popout");
const captureBtn = document.getElementById("capture");
const theaterBtn = document.getElementById("theater");
const optionsBtn = document.getElementById("options");
const statusEl = document.getElementById("status");
const listEl = document.getElementById("list");
const bulkEl = document.getElementById("bulk");
const popSelectedBtn = document.getElementById("pop-selected");
const popAllBtn = document.getElementById("pop-all");
const controlsEl = document.getElementById("controls");
const proEl = document.getElementById("pro");
const siteLabel = document.getElementById("site-label");
const siteRuleSel = document.getElementById("site-rule");
const sleepInput = document.getElementById("sleep");
const sleepStatus = document.getElementById("sleep-status");
const scanAllBtn = document.getElementById("scan-all");
const everywhereList = document.getElementById("everywhere-list");
const everywhereStatus = document.getElementById("everywhere-status");
const popYoutubePipBtn = document.getElementById("pop-youtube-pip");
const popAllCaptureBtn = document.getElementById("pop-all-capture");
const openWallBtn = document.getElementById("open-wall");
let allTabs = [];
const everywhereSelected = new Set();

const SPEEDS = [1, 1.25, 1.5, 2, 0.5];
let speedIdx = 0;
let videos = [];
let docPipOpen = false;
let siteOrigin = "";
const selected = new Set();

function keyOf(video) {
  return `${video.frameId ?? 0}:${video.index ?? 0}`;
}

function setStatus(text, isError = false) {
  statusEl.textContent = text || "";
  statusEl.classList.toggle("error", isError);
}

function controlTargets() {
  if (selected.size) {
    return videos.filter((v) => selected.has(keyOf(v))).map((v) => ({ frameId: v.frameId ?? 0, index: v.index ?? 0 }));
  }
  return videos.map((v) => ({ frameId: v.frameId ?? 0, index: v.index ?? 0 }));
}

function describe(video) {
  const bits = [];
  if (video.isAd) bits.push("ad");
  else if (video.inPip) bits.push("popped out");
  else if (video.playing) bits.push("playing");
  else if (!video.ready) bits.push("loading");
  else bits.push("paused");
  if (video.drm) bits.push("DRM");
  if (video.width && video.height) bits.push(`${video.width}x${video.height}`);
  if (video.frameId && video.frameId !== 0) bits.push("embedded");
  if (video.duration) bits.push(`${Math.floor(video.currentTime/60)}:${String(video.currentTime%60).padStart(2,"0")}/${Math.floor(video.duration/60)}:${String(video.duration%60).padStart(2,"0")}`);
  return bits.join(" · ");
}

function refreshBulk() {
  const show = videos.length > 1;
  bulkEl.hidden = !show;
  controlsEl.hidden = !videos.length;
  proEl.hidden = !videos.length;
  if (show) {
    popSelectedBtn.textContent = `Pop selected (${selected.size})`;
    popSelectedBtn.disabled = selected.size === 0;
    popAllBtn.textContent = docPipOpen ? "Close combined" : "Pop all";
  }
}

function renderList() {
  listEl.innerHTML = "";
  if (!videos.length) {
    refreshBulk();
    return;
  }
  for (const video of videos) {
    const key = keyOf(video);
    const row = document.createElement("div");
    row.className = "video-item" + (video.playing ? " playing" : "") + (video.inPip ? " inpip" : "");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = selected.has(key);
    box.title = "Select for multi-popout and controls";
    box.addEventListener("change", () => {
      if (box.checked) selected.add(key);
      else selected.delete(key);
      refreshBulk();
    });
    if (video.thumb) {
      const img = document.createElement("img");
      img.className = "thumb";
      img.src = video.thumb;
      img.alt = "";
      row.appendChild(img);
    }
    row.appendChild(box);
    const pick = document.createElement("button");
    pick.className = "pick";
    const dot = document.createElement("span");
    dot.className = "dot";
    const meta = document.createElement("span");
    meta.className = "meta";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = video.label || "Video";
    title.title = video.label || "Video";
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = describe(video);
    meta.appendChild(title);
    meta.appendChild(sub);
    pick.appendChild(dot);
    pick.appendChild(meta);
    pick.addEventListener("click", () => { void popSpecific(video); });
    row.appendChild(pick);
    listEl.appendChild(row);
  }
  refreshBulk();
}

async function popSpecific(video) {
  setStatus(`Popping out “${video.label || "video"}”…`);
  try {
    const res = await chrome.runtime.sendMessage({ type: "POP_VIDEO", frameId: video.frameId ?? 0, index: video.index ?? 0 });
    if (!res?.ok) throw new Error(res?.error || "Could not pop out this video.");
    window.close();
  } catch (error) {
    setStatus(error?.message || "Could not pop out this video.", true);
  }
}

async function sendControl(command, value) {
  const targets = controlTargets();
  if (!targets.length) return;
  setStatus("Applying…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "VIDEO_COMMAND", targets, command, value });
    if (!res?.ok) throw new Error(res?.error || "Could not control these videos.");
    setStatus(`Applied to ${res.count} video${res.count === 1 ? "" : "s"}.`);
  } catch (error) {
    setStatus(error?.message || "Could not control these videos.", true);
  }
}

async function sendPro(command, value) {
  const targets = controlTargets();
  if (!targets.length) return;
  setStatus("Applying…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "PRO_COMMAND", targets, command, value });
    if (!res?.ok) throw new Error(res?.error || "Could not apply.");
    if (res.dataUrl) {
      const a = document.createElement("a");
      a.href = res.dataUrl; a.download = `frame-${Date.now()}.png`; a.click();
      setStatus("Screenshot downloaded.");
    } else {
      setStatus(`Done on ${res.count} video${res.count===1?"":"s"}.`);
    }
  } catch (error) {
    setStatus(error?.message || "Could not apply.", true);
  }
}

document.getElementById("ctl-play").addEventListener("click", () => { void sendControl("toggle-play"); });
document.getElementById("ctl-mute").addEventListener("click", () => { void sendControl("toggle-mute"); });
document.getElementById("ctl-back").addEventListener("click", () => { void sendControl("seek", -10); });
document.getElementById("ctl-fwd").addEventListener("click", () => { void sendControl("seek", 10); });
document.getElementById("ctl-speed").addEventListener("click", (e) => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  e.target.textContent = `${SPEEDS[speedIdx]}x`;
  void sendControl("rate", SPEEDS[speedIdx]);
});
document.getElementById("ctl-loop").addEventListener("click", (e) => {
  e.target.classList.toggle("active");
  void sendControl("toggle-loop");
});
document.getElementById("boost").addEventListener("change", (e) => { void sendPro("boost", Number(e.target.value)); });
document.getElementById("eq").addEventListener("change", (e) => { void sendPro("eq", e.target.value); });
document.getElementById("ab-a").addEventListener("click", () => { void sendPro("ab-a"); });
document.getElementById("ab-b").addEventListener("click", () => { void sendPro("ab-b"); });
document.getElementById("ab-clear").addEventListener("click", () => { void sendPro("ab-clear"); });
document.getElementById("shot").addEventListener("click", () => { void sendPro("screenshot"); });

popSelectedBtn.addEventListener("click", async () => {
  const targets = videos.filter((v) => selected.has(keyOf(v))).map((v) => ({ frameId: v.frameId ?? 0, index: v.index ?? 0 }));
  if (!targets.length) return;
  popSelectedBtn.disabled = true;
  setStatus(`Popping out ${targets.length} video${targets.length === 1 ? "" : "s"} in one window…`);
  try {
    const res = await chrome.runtime.sendMessage({ type: "POP_VIDEOS", targets });
    if (!res?.ok) throw new Error(res?.error || "Could not pop out these videos.");
    window.close();
  } catch (error) {
    setStatus(error?.message || "Could not pop out these videos.", true);
  } finally {
    popSelectedBtn.disabled = false;
  }
});

popAllBtn.addEventListener("click", async () => {
  if (docPipOpen) {
    setStatus("Closing combined window…");
    try {
      const anyTarget = videos.length ? [{ frameId: videos[0].frameId ?? 0, index: videos[0].index ?? 0 }] : [];
      const res = await chrome.runtime.sendMessage({ type: "POP_VIDEOS", targets: anyTarget });
      if (!res?.ok) throw new Error(res?.error || "Could not close the combined window.");
      window.close();
    } catch (error) {
      setStatus(error?.message || "Could not close the combined window.", true);
    }
    return;
  }
  const targets = videos.map((v) => ({ frameId: v.frameId ?? 0, index: v.index ?? 0 }));
  popAllBtn.disabled = true;
  setStatus(`Popping out ${targets.length} videos in one window…`);
  try {
    const res = await chrome.runtime.sendMessage({ type: "POP_VIDEOS", targets });
    if (!res?.ok) throw new Error(res?.error || "Could not pop out these videos.");
    window.close();
  } catch (error) {
    setStatus(error?.message || "Could not pop out these videos.", true);
  } finally {
    popAllBtn.disabled = false;
  }
});

popBtn.addEventListener("click", async () => {
  popBtn.disabled = true;
  try {
    if (videos.length === 1) {
      await popSpecific(videos[0]);
      return;
    }
    const res = await chrome.runtime.sendMessage({ type: "POP_VIDEO", frameId: 0, index: null });
    if (!res?.ok) throw new Error(res?.error || "Could not pop out this video.");
    window.close();
  } catch (error) {
    setStatus(error?.message || "Could not pop out this video.", true);
  } finally {
    popBtn.disabled = false;
  }
});

captureBtn.addEventListener("click", async () => {
  captureBtn.disabled = true;
  setStatus("Opening whole-tab popout…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "CAPTURE_TAB" });
    if (!res?.ok) throw new Error(res?.error || "Could not pop out this tab.");
    window.close();
  } catch (error) {
    setStatus(error?.message || "Could not pop out this tab.", true);
  } finally {
    captureBtn.disabled = false;
  }
});

theaterBtn.addEventListener("click", async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: "OPEN_SIDE_PANEL" });
    if (!res?.ok) throw new Error(res?.error || "Could not open Theater.");
    window.close();
  } catch (e) {
    setStatus(e?.message || "Could not open Theater.", true);
  }
});

document.getElementById("sleep-start").addEventListener("click", async () => {
  const mins = Math.max(1, Math.min(240, Number(sleepInput.value) || 30));
  const res = await chrome.runtime.sendMessage({ type: "SET_SLEEP", minutes: mins });
  setStatus(res?.ok ? `Sleep in ${mins} min.` : res?.error || "Could not set timer.", !res?.ok);
  void refreshSleep();
});
document.getElementById("sleep-cancel").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "SET_SLEEP", minutes: 0 });
  setStatus(res?.ok ? "Sleep canceled." : res?.error || "Could not cancel.", !res?.ok);
  sleepStatus.textContent = "";
});

async function refreshSleep() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_SLEEP" });
    if (res?.active) {
      const left = Math.max(0, Math.round((res.endsAt - Date.now())/60000));
      sleepStatus.textContent = `Sleep in ${left} min`;
      sleepInput.value = res.minutes;
    } else sleepStatus.textContent = "";
  } catch { return; }
}

siteRuleSel.addEventListener("change", async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: "SET_SITE_RULE", origin: siteOrigin, rule: siteRuleSel.value });
    if (!res?.ok) throw new Error(res?.error || "Could not save the site rule.");
    siteLabel.textContent = `${siteOrigin || "This site"} · ${res.siteRule}`;
  } catch (error) {
    setStatus(error?.message || "Could not save the site rule.", true);
  }
});

optionsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

function renderEverywhere() {
  everywhereList.innerHTML = "";
  if (!allTabs.length) {
    everywhereList.innerHTML = `<div class="sub">No tabs with videos yet. Open your YouTube links like the two you sent, play each, then Scan again.</div>`;
    return;
  }
  for (const tab of allTabs) {
    const row = document.createElement("label");
    row.className = "everywhere-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = everywhereSelected.has(tab.id);
    cb.addEventListener("change", () => {
      if (cb.checked) everywhereSelected.add(tab.id);
      else everywhereSelected.delete(tab.id);
    });
    const t = document.createElement("span");
    t.className = "t";
    const ytid = tab.ytid ? ` · ${tab.ytid}` : "";
    t.textContent = `${tab.title.slice(0, 42)}${ytid}`;
    t.title = `${tab.title}\n${tab.url}`;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = tab.videos.length ? `${tab.videos.length} video${tab.videos.length===1?"":"s"}` : "no video";
    row.appendChild(cb);
    row.appendChild(t);
    row.appendChild(badge);
    everywhereList.appendChild(row);
  }
}

scanAllBtn.addEventListener("click", async () => {
  scanAllBtn.disabled = true;
  everywhereStatus.textContent = "Scanning all tabs…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "LIST_ALL_TABS" });
    if (!res?.ok) throw new Error(res?.error || "Could not scan.");
    allTabs = res.tabs || [];
    everywhereSelected.clear();
    for (const t of allTabs) {
      if (t.videos.length && !t.videos.every((v) => v.isAd)) everywhereSelected.add(t.id);
    }
    if (!allTabs.length) everywhereStatus.textContent = "No tabs with videos. Open the YouTube links first.";
    else {
      const yt = allTabs.filter((t) => t.ytid).length;
      everywhereStatus.textContent = `${allTabs.length} tabs scanned${yt ? ` · ${yt} YouTube` : ""} — tick and use the buttons below.`;
    }
    renderEverywhere();
  } catch (e) {
    everywhereStatus.textContent = e.message || "Could not scan.";
  } finally {
    scanAllBtn.disabled = false;
  }
});

async function popEverywhere(mode, youtubeOnly) {
  const ids = [...everywhereSelected];
  if (!ids.length && allTabs.length) {
    for (const t of allTabs) {
      if (youtubeOnly && !t.ytid) continue;
      if (t.videos.length) ids.push(t.id);
    }
  }
  if (!ids.length) {
    everywhereStatus.textContent = "Select at least one tab — open the YouTube links you sent and Scan again.";
    return;
  }
  everywhereStatus.textContent = mode === "capture" ? `Floating ${ids.length} windows…` : `Popping ${ids.length} tabs…`;
  try {
    const res = await chrome.runtime.sendMessage({ type: "POP_ALL_TABS", tabIds: ids, mode, youtubeOnly: !!youtubeOnly });
    if (!res?.ok) throw new Error(res?.error || "Could not pop.");
    const warn = res.warning ? ` — ${res.warning}` : "";
    everywhereStatus.textContent = `Done — ${res.count} tab${res.count===1?"":"s"}${warn}`;
    setStatus(`Everywhere: ${res.count} done.${warn ? " " + res.warning : ""}`, !!warn);
  } catch (e) {
    everywhereStatus.textContent = e.message || "Could not pop.";
  }
}

popYoutubePipBtn.addEventListener("click", () => { void popEverywhere("pip", true); });
popAllCaptureBtn.addEventListener("click", () => { void popEverywhere("capture", false); });
openWallBtn.addEventListener("click", async () => {
  const ids = [...everywhereSelected].map((id) => {
    const t = allTabs.find((x) => x.id === id);
    return t ? t.ytid : "";
  }).filter(Boolean);
  const payload = ids.length ? ids : undefined;
  everywhereStatus.textContent = "Opening wall…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "OPEN_WALL", ids: payload });
    if (!res?.ok) throw new Error(res?.error || "Could not open wall.");
    everywhereStatus.textContent = `Wall opened with ${res.count} videos — one window for 10+ at once.`;
    window.close();
  } catch (e) {
    everywhereStatus.textContent = e.message || "Could not open wall.";
  }
});

(async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: "LIST_VIDEOS" });
    if (!res?.ok) {
      videos = [];
      setStatus(res?.error || "Cannot access this page.", true);
      popBtn.disabled = true;
      refreshBulk();
      return;
    }
    videos = res.videos || [];
    docPipOpen = !!res.docPipOpen;
    siteOrigin = res.origin || "";
    siteRuleSel.value = res.siteRule || "default";
    siteLabel.textContent = siteOrigin ? `${siteOrigin} · ${res.siteRule || "default"}` : `This site: ${res.siteRule || "default"}`;
    selected.clear();
    for (const v of videos) {
      if (v.playing && v.ready && !v.isAd) selected.add(keyOf(v));
    }
    if (docPipOpen) {
      setStatus("Combined popout is open — Pop all closes it.");
    } else if (!videos.length) {
      setStatus("No video on this page. You can still pop out the entire tab or open Theater.");
    } else if (videos.length === 1) {
      const v = videos[0];
      if (v.drm) setStatus("DRM video — popout may show black. Try whole-tab capture or screenshot may be blocked.", true);
      else setStatus(v.inPip ? "Video is popped out — click to bring it back." : v.playing ? "Playing video found." : "Video found (paused).");
    } else {
      const drmCount = videos.filter((v) => v.drm).length;
      setStatus(`${videos.length} videos — ${drmCount ? drmCount + " DRM " : ""}tick and Pop selected, or Pop all.`);
    }
    renderList();
    void refreshSleep();
  } catch (error) {
    setStatus(error?.message || "Cannot access this page.", true);
    popBtn.disabled = true;
  }
})();

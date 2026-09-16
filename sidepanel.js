const statusEl = document.getElementById("status");
const listEl = document.getElementById("list");
const boostSel = document.getElementById("boost");
const eqSel = document.getElementById("eq");
const sleepInput = document.getElementById("sleep");
const sleepStatus = document.getElementById("sleep-status");

let videos = [];
let selected = new Set();
let origin = "";

function key(v) { return `${v.frameId ?? 0}:${v.index ?? 0}`; }
function setStatus(t, err=false) { statusEl.textContent = t || ""; statusEl.classList.toggle("error", err); }
function targets() {
  if (selected.size) return videos.filter((v) => selected.has(key(v))).map((v) => ({ frameId: v.frameId ?? 0, index: v.index ?? 0 }));
  return videos.map((v) => ({ frameId: v.frameId ?? 0, index: v.index ?? 0 }));
}

async function refresh() {
  setStatus("Scanning…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "LIST_VIDEOS" });
    if (!res?.ok) throw new Error(res?.error || "Cannot access this page.");
    videos = res.videos || [];
    origin = res.origin || "";
    if (selected.size) {
      const valid = new Set(videos.map(key));
      for (const k of [...selected]) if (!valid.has(k)) selected.delete(k);
    } else {
      for (const v of videos) if (v.playing && v.ready) selected.add(key(v));
    }
    if (!videos.length) setStatus("No video on this page. The panel stays usable when you switch tabs.");
    else setStatus(`${videos.length} video${videos.length===1?"":"s"} · ${origin || "this tab"}`);
    render();
    void updateSleepStatus();
  } catch (e) {
    setStatus(e.message || "Cannot access this page.", true);
  }
}

function render() {
  listEl.innerHTML = "";
  for (const v of videos) {
    const row = document.createElement("div");
    row.className = "video-row";
    if (v.thumb) {
      const img = document.createElement("img");
      img.src = v.thumb; img.alt = "";
      row.appendChild(img);
    }
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = selected.has(key(v));
    cb.addEventListener("change", () => { if (cb.checked) selected.add(key(v)); else selected.delete(key(v)); });
    const meta = document.createElement("div");
    meta.className = "meta";
    const t = document.createElement("div");
    t.className = "title"; t.textContent = v.label || "Video"; t.title = v.label || "Video";
    const sub = document.createElement("div");
    sub.className = "sub";
    const bits = [v.isAd ? "ad" : v.playing ? "playing" : v.ready ? "paused" : "loading"];
    if (v.drm) bits.push("DRM");
    bits.push(`${v.width}x${v.height}`);
    if (v.duration) bits.push(`${Math.floor(v.currentTime/60)}:${String(v.currentTime%60).padStart(2,"0")}/${Math.floor(v.duration/60)}:${String(v.duration%60).padStart(2,"0")}`);
    sub.textContent = bits.join(" · ");
    meta.appendChild(t); meta.appendChild(sub);
    const pop = document.createElement("button");
    pop.className = "ghost small"; pop.textContent = v.inPip ? "Bring back" : "Pop";
    pop.addEventListener("click", async () => {
      const res = await chrome.runtime.sendMessage({ type: "POP_VIDEO", frameId: v.frameId ?? 0, index: v.index ?? 0 });
      if (!res?.ok) setStatus(res?.error || "Could not pop.", true);
      else void refresh();
    });
    row.appendChild(cb); row.appendChild(meta); row.appendChild(pop);
    listEl.appendChild(row);
  }
}

document.getElementById("refresh").addEventListener("click", () => { void refresh(); });
document.getElementById("pop-all").addEventListener("click", async () => {
  if (!videos.length) return;
  const res = await chrome.runtime.sendMessage({ type: "POP_VIDEOS", targets: videos.map((v) => ({ frameId: v.frameId ?? 0, index: v.index ?? 0 })) });
  if (!res?.ok) setStatus(res?.error || "Could not pop all.", true);
  else void refresh();
});
document.getElementById("capture").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "CAPTURE_TAB" });
  if (!res?.ok) setStatus(res?.error || "Could not capture.", true);
});
document.getElementById("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

for (const btn of document.querySelectorAll("[data-cmd]")) {
  btn.addEventListener("click", async () => {
    const ts = targets();
    if (!ts.length) return;
    const cmd = btn.getAttribute("data-cmd");
    const val = btn.getAttribute("data-val");
    const res = await chrome.runtime.sendMessage({ type: "VIDEO_COMMAND", targets: ts, command: cmd, value: val ? Number(val) : undefined });
    if (!res?.ok) setStatus(res?.error || "Could not control.", true);
    else setStatus(`Done on ${res.count} video${res.count===1?"":"s"}.`);
  });
}
boostSel.addEventListener("change", async () => {
  const ts = targets(); if (!ts.length) return;
  const res = await chrome.runtime.sendMessage({ type: "PRO_COMMAND", targets: ts, command: "boost", value: Number(boostSel.value) });
  if (!res?.ok) setStatus(res?.error || "Boost failed.", true);
  else setStatus(`Boost ${boostSel.value}% on ${res.count} video(s).`);
});
eqSel.addEventListener("change", async () => {
  const ts = targets(); if (!ts.length) return;
  const res = await chrome.runtime.sendMessage({ type: "PRO_COMMAND", targets: ts, command: "eq", value: eqSel.value });
  if (!res?.ok) setStatus(res?.error || "EQ failed.", true);
  else setStatus(`EQ ${eqSel.value} on ${res.count} video(s).`);
});
document.getElementById("ab-a").addEventListener("click", async () => {
  const ts = targets(); if (!ts.length) return;
  const res = await chrome.runtime.sendMessage({ type: "PRO_COMMAND", targets: ts, command: "ab-a" });
  setStatus(res?.ok ? `A set on ${res.count} video(s).` : res?.error || "Could not set A.", !res?.ok);
});
document.getElementById("ab-b").addEventListener("click", async () => {
  const ts = targets(); if (!ts.length) return;
  const res = await chrome.runtime.sendMessage({ type: "PRO_COMMAND", targets: ts, command: "ab-b" });
  setStatus(res?.ok ? `A-B loop on ${res.count} video(s).` : res?.error || "Could not set B.", !res?.ok);
});
document.getElementById("ab-clear").addEventListener("click", async () => {
  const ts = targets(); if (!ts.length) return;
  const res = await chrome.runtime.sendMessage({ type: "PRO_COMMAND", targets: ts, command: "ab-clear" });
  setStatus(res?.ok ? "AB cleared." : res?.error || "Could not clear.", !res?.ok);
});
document.getElementById("shot").addEventListener("click", async () => {
  const ts = targets().slice(0, 1); if (!ts.length) return;
  const res = await chrome.runtime.sendMessage({ type: "PRO_COMMAND", targets: ts, command: "screenshot" });
  if (!res?.ok) setStatus(res?.error || "Screenshot failed.", true);
  else {
    try {
      const a = document.createElement("a");
      a.href = res.dataUrl; a.download = `frame-${Date.now()}.png`;
      a.click();
      setStatus("Screenshot downloaded.");
    } catch { setStatus("Screenshot ready but download blocked.", true); }
  }
});

async function updateSleepStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_SLEEP" });
    if (res?.active) sleepStatus.textContent = `Sleep in ${Math.max(0, Math.round((res.endsAt - Date.now())/60000))} min`;
    else sleepStatus.textContent = res?.remaining ? `Paused ${Math.round(res.remaining/60000)} min` : "";
    if (res?.minutes) sleepInput.value = res.minutes;
  } catch { return; }
}
document.getElementById("sleep-start").addEventListener("click", async () => {
  const mins = Math.max(1, Math.min(240, Number(sleepInput.value) || 30));
  const res = await chrome.runtime.sendMessage({ type: "SET_SLEEP", minutes: mins });
  setStatus(res?.ok ? `Sleep in ${mins} min.` : res?.error || "Could not set timer.", !res?.ok);
  void updateSleepStatus();
});
document.getElementById("sleep-cancel").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "SET_SLEEP", minutes: 0 });
  setStatus(res?.ok ? "Sleep canceled." : res?.error || "Could not cancel.", !res?.ok);
  sleepStatus.textContent = "";
});

const scanAllBtn = document.getElementById("scan-all");
const everywhereList = document.getElementById("everywhere-list");
const everywhereStatus = document.getElementById("everywhere-status");
let allTabs = [];
const everywhereSelected = new Set();

function renderEverywhere() {
  everywhereList.innerHTML = "";
  if (!allTabs.length) {
    everywhereList.innerHTML = `<div class="sub">Open your YouTube links, then Scan.</div>`;
    return;
  }
  for (const tab of allTabs) {
    const row = document.createElement("label");
    row.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11px;border:1px solid rgba(128,128,128,0.25);border-radius:6px;padding:4px 6px;background:rgba(255,255,255,0.06)";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = everywhereSelected.has(tab.id);
    cb.addEventListener("change", () => { if (cb.checked) everywhereSelected.add(tab.id); else everywhereSelected.delete(tab.id); });
    const t = document.createElement("span");
    t.style.cssText = "flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    t.textContent = tab.title.slice(0, 44) + (tab.ytid ? ` · ${tab.ytid}` : "");
    t.title = `${tab.title}\n${tab.url}`;
    const badge = document.createElement("span");
    badge.style.cssText = "font-size:10px;color:#9ca3af";
    badge.textContent = tab.videos.length ? `${tab.videos.length} vid` : "no vid";
    row.appendChild(cb); row.appendChild(t); row.appendChild(badge);
    everywhereList.appendChild(row);
  }
}

scanAllBtn.addEventListener("click", async () => {
  scanAllBtn.disabled = true;
  everywhereStatus.textContent = "Scanning…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "LIST_ALL_TABS" });
    if (!res?.ok) throw new Error(res?.error || "Could not scan.");
    allTabs = res.tabs || [];
    everywhereSelected.clear();
    for (const t of allTabs) if (t.videos.length) everywhereSelected.add(t.id);
    const yt = allTabs.filter((t) => t.ytid).length;
    everywhereStatus.textContent = `${allTabs.length} tabs${yt ? ` · ${yt} YouTube` : ""}`;
    renderEverywhere();
  } catch (e) {
    everywhereStatus.textContent = e.message || "Scan failed.";
  } finally {
    scanAllBtn.disabled = false;
  }
});

async function popEverywhere(mode, youtubeOnly) {
  let ids = [...everywhereSelected];
  if (!ids.length) {
    for (const t of allTabs) {
      if (youtubeOnly && !t.ytid) continue;
      if (t.videos.length) ids.push(t.id);
    }
  }
  if (!ids.length) { everywhereStatus.textContent = "No tabs selected."; return; }
  everywhereStatus.textContent = mode === "capture" ? `Floating ${ids.length}…` : `Popping ${ids.length}…`;
  try {
    const res = await chrome.runtime.sendMessage({ type: "POP_ALL_TABS", tabIds: ids, mode, youtubeOnly: !!youtubeOnly });
    if (!res?.ok) throw new Error(res?.error || "Failed.");
    const w = res.warning ? ` — ${res.warning}` : "";
    everywhereStatus.textContent = `Done ${res.count}${w}`;
    setStatus(`Everywhere ${res.count}${w}`, !!w);
  } catch (e) {
    everywhereStatus.textContent = e.message || "Failed.";
  }
}

document.getElementById("pop-youtube-pip").addEventListener("click", () => { void popEverywhere("pip", true); });
document.getElementById("pop-all-capture").addEventListener("click", () => { void popEverywhere("capture", false); });
document.getElementById("open-wall").addEventListener("click", async () => {
  const ids = [...everywhereSelected].map((id) => {
    const t = allTabs.find((x) => x.id === id);
    return t ? t.ytid : "";
  }).filter(Boolean);
  everywhereStatus.textContent = "Opening wall…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "OPEN_WALL", ids: ids.length ? ids : undefined });
    if (!res?.ok) throw new Error(res?.error || "Failed.");
    everywhereStatus.textContent = `Wall ${res.count} videos.`;
  } catch (e) {
    everywhereStatus.textContent = e.message || "Failed.";
  }
});

void refresh();
setInterval(() => { void updateSleepStatus(); }, 15000);

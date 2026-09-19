const popBtn = document.getElementById("popout");
const optionsBtn = document.getElementById("options");
const statusEl = document.getElementById("status");
const listEl = document.getElementById("list");
const controlsEl = document.getElementById("controls");
const audioEl = document.getElementById("audio");
const volumeInput = document.getElementById("volume");
const volumeVal = document.getElementById("volume-val");
const boostSel = document.getElementById("boost");
const eqSel = document.getElementById("eq");

const SPEEDS = [1, 1.25, 1.5, 2, 0.5];
let speedIdx = 0;
let videos = [];

function keyOf(video) {
  return `${video.frameId ?? 0}:${video.index ?? 0}`;
}

function setStatus(text, isError = false) {
  statusEl.textContent = text || "";
  statusEl.classList.toggle("error", isError);
}

function targets() {
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
  return bits.join(" · ");
}

function renderList() {
  listEl.innerHTML = "";
  for (const video of videos) {
    const row = document.createElement("div");
    row.className = "video-item" + (video.playing ? " playing" : "") + (video.inPip ? " inpip" : "");
    if (video.thumb) {
      const img = document.createElement("img");
      img.className = "thumb";
      img.src = video.thumb;
      img.alt = "";
      row.appendChild(img);
    }
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
  const show = videos.length > 0;
  controlsEl.hidden = !show;
  audioEl.hidden = !show;
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
  const ts = targets();
  if (!ts.length) return;
  setStatus("Applying…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "VIDEO_COMMAND", targets: ts, command, value });
    if (!res?.ok) throw new Error(res?.error || "Could not control these videos.");
    setStatus(`Applied to ${res.count} video${res.count === 1 ? "" : "s"}.`);
  } catch (error) {
    setStatus(error?.message || "Could not control these videos.", true);
  }
}

async function sendPro(command, value) {
  const ts = targets();
  if (!ts.length) return;
  setStatus("Applying…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "PRO_COMMAND", targets: ts, command, value });
    if (!res?.ok) throw new Error(res?.error || "Could not apply.");
    try {
      const saved = await chrome.storage.local.get({ boost: 100, eq: "flat" }).catch(() => ({ boost: 100, eq: "flat" }));
      if (command === "boost") await chrome.storage.local.set({ ...saved, boost: Number(value) });
      if (command === "eq") await chrome.storage.local.set({ ...saved, eq: String(value) });
    } catch { /* ignore */ }
    const label = command === "boost" ? `Boost ${value}% ON` : `EQ ${value} ON`;
    setStatus(`${label} — stays on after popup closes. Done on ${res.count} video${res.count === 1 ? "" : "s"}.`);
  } catch (error) {
    setStatus(error?.message || "Could not apply.", true);
  }
}

async function restoreAudioUI() {
  // 1) Restore last-chosen values instantly so selects never look reset
  try {
    const saved = await chrome.storage.local.get({ boost: 100, eq: "flat" }).catch(() => ({ boost: 100, eq: "flat" }));
    if (saved && boostSel && saved.boost) boostSel.value = String(saved.boost);
    if (saved && eqSel && saved.eq) eqSel.value = String(saved.eq);
  } catch { /* ignore */ }
  // 2) Ask the page for the real active state (survives popup close)
  try {
    const ts = targets();
    if (!ts.length) return;
    const res = await chrome.runtime.sendMessage({ type: "PRO_COMMAND", targets: ts.slice(0, 1), command: "get-state" });
    if (res?.ok && res.state) {
      if (res.state.hooked) {
        if (boostSel) boostSel.value = String(res.state.boost || 100);
        if (eqSel) eqSel.value = String(res.state.eq || "flat");
        try { await chrome.storage.local.set({ boost: res.state.boost || 100, eq: res.state.eq || "flat" }); } catch { /* ignore */ }
        if ((res.state.boost || 100) > 100 || (res.state.eq || "flat") !== "flat") {
          setStatus(`Audio ON: Boost ${res.state.boost}% + ${res.state.eq} — still active.`);
        }
      }
      if (res.state.ctxState === "suspended") {
        setStatus("Audio hooked but browser suspended it — click Play on the video, then set boost again.", true);
      }
    }
  } catch { /* ignore */ }
  // 3) Reflect the real element volume
  try {
    if (videos.length && typeof videos[0].volume === "number") {
      const pct = Math.round(videos[0].volume * 100);
      volumeInput.value = String(pct);
      volumeVal.textContent = `${pct}%`;
    }
  } catch { /* ignore */ }
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

let volTimer = null;
volumeInput.addEventListener("input", () => {
  volumeVal.textContent = `${volumeInput.value}%`;
  if (volTimer) clearTimeout(volTimer);
  volTimer = setTimeout(() => {
    void sendControl("volume", Number(volumeInput.value) / 100);
  }, 120);
});

document.getElementById("boost").addEventListener("change", (e) => { void sendPro("boost", Number(e.target.value)); });
document.getElementById("eq").addEventListener("change", (e) => { void sendPro("eq", e.target.value); });

const noiseBtn = document.getElementById("noise");

let noiseOn = false;
noiseBtn?.addEventListener("click", async () => {
  const ts = targets();
  if (!ts.length) return;
  noiseOn = !noiseOn;
  noiseBtn.classList.toggle("active", noiseOn);
  try {
    const res = await chrome.runtime.sendMessage({ type: "PRO_COMMAND", targets: ts, command: "noise", value: noiseOn });
    setStatus(res?.ok ? `Noise gate ${noiseOn ? "ON" : "OFF"}.` : res?.error || "Noise toggle failed.", !res?.ok);
  } catch (e) {
    setStatus(e?.message || "Noise toggle failed.", true);
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

optionsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

(async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: "LIST_VIDEOS" });
    if (!res?.ok) {
      videos = [];
      setStatus(res?.error || "Cannot access this page.", true);
      popBtn.disabled = true;
      renderList();
      return;
    }
    videos = res.videos || [];
    if (!videos.length) {
      setStatus("No video on this page.");
    } else if (videos.length === 1) {
      const v = videos[0];
      if (v.drm) setStatus("DRM video — popout may show black.", true);
      else setStatus(v.inPip ? "Video is popped out — click to bring it back." : v.playing ? "Playing video found." : "Video found (paused).");
    } else {
      setStatus(`${videos.length} videos — click one to pop it.`);
    }
    renderList();
    void restoreAudioUI();
  } catch (error) {
    setStatus(error?.message || "Cannot access this page.", true);
    popBtn.disabled = true;
  }
})();

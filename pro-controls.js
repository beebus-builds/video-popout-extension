(() => {
  const cmd = window.__popoutProCmd;
  const indices = window.__popoutProIndices || [];
  const value = window.__popoutProValue;
  try { delete window.__popoutProCmd; delete window.__popoutProIndices; delete window.__popoutProValue; } catch { window.__popoutProCmd = undefined; }
  if (!cmd) return { ok: false, error: "No command." };
  const videos = Array.from(document.querySelectorAll("video"));
  const targets = indices.length ? indices.map((i) => videos[i]).filter(Boolean) : videos;
  if (!targets.length) return { ok: false, error: "No video found." };
  if (!window.__popoutAudioMap) window.__popoutAudioMap = new WeakMap();
  if (!window.__popoutAB) window.__popoutAB = new WeakMap();
  function ensureAudio(video) {
    if (window.__popoutAudioMap.has(video)) return window.__popoutAudioMap.get(video);
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaElementSource(video);
      const gain = ctx.createGain();
      const eqLow = ctx.createBiquadFilter(); eqLow.type = "lowshelf"; eqLow.frequency.value = 320;
      const eqHigh = ctx.createBiquadFilter(); eqHigh.type = "highshelf"; eqHigh.frequency.value = 3200;
      src.connect(eqLow); eqLow.connect(eqHigh); eqHigh.connect(gain); gain.connect(ctx.destination);
      const rec = { ctx, gain, eqLow, eqHigh, src };
      window.__popoutAudioMap.set(video, rec);
      return rec;
    } catch {
      return null;
    }
  }
  let count = 0;
  let extra = null;
  for (const v of targets) {
    try {
      if (cmd === "boost") {
        const pct = Math.max(100, Math.min(200, Number(value) || 100));
        const rec = ensureAudio(v);
        if (rec) {
          if (rec.ctx.state === "suspended") rec.ctx.resume().catch(() => {});
          rec.gain.gain.value = pct / 100;
          count++;
        }
      } else if (cmd === "eq") {
        const rec = ensureAudio(v);
        if (rec) {
          if (rec.ctx.state === "suspended") rec.ctx.resume().catch(() => {});
          if (value === "bass") { rec.eqLow.gain.value = 6; rec.eqHigh.gain.value = -2; }
          else if (value === "vocal") { rec.eqLow.gain.value = -2; rec.eqHigh.gain.value = 4; }
          else if (value === "flat") { rec.eqLow.gain.value = 0; rec.eqHigh.gain.value = 0; }
          count++;
        }
      } else if (cmd === "ab-a") {
        const ab = window.__popoutAB.get(v) || {};
        ab.a = v.currentTime || 0;
        window.__popoutAB.set(v, ab);
        if (ab._handler) { v.removeEventListener("timeupdate", ab._handler); ab._handler = null; }
        count++;
      } else if (cmd === "ab-b") {
        const ab = window.__popoutAB.get(v) || {};
        ab.b = v.currentTime || 0;
        if (ab.a == null) ab.a = 0;
        if (ab.b <= ab.a) { extra = "B must be after A"; continue; }
        if (ab._handler) v.removeEventListener("timeupdate", ab._handler);
        const handler = () => { if (v.currentTime >= ab.b || v.currentTime < ab.a) v.currentTime = ab.a; };
        ab._handler = handler;
        v.addEventListener("timeupdate", handler);
        v.loop = false;
        window.__popoutAB.set(v, ab);
        count++;
      } else if (cmd === "ab-clear") {
        const ab = window.__popoutAB.get(v);
        if (ab && ab._handler) v.removeEventListener("timeupdate", ab._handler);
        window.__popoutAB.delete(v);
        count++;
      } else if (cmd === "screenshot") {
        try {
          if (v.readyState < 2 || !v.videoWidth) throw new Error("Video not ready.");
          const canvas = document.createElement("canvas");
          canvas.width = v.videoWidth;
          canvas.height = v.videoHeight;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Cannot capture.");
          ctx.drawImage(v, 0, 0);
          extra = canvas.toDataURL("image/png");
          count++;
        } catch (e) { extra = e.message; }
      } else if (cmd === "pip-close-all") {
        if (document.pictureInPictureElement) {
          document.exitPictureInPicture().catch(() => {});
        }
        if (window.documentPictureInPicture && window.documentPictureInPicture.window) {
          window.documentPictureInPicture.window.close();
        }
        const ab = window.__popoutAB.get(v);
        if (ab && ab._handler) v.removeEventListener("timeupdate", ab._handler);
        count++;
      }
    } catch { return; }
  }
  if (cmd === "screenshot") {
    if (!extra || !extra.startsWith("data:")) return { ok: false, error: extra || "Could not capture frame. DRM-protected videos block screenshots." };
    return { ok: true, count, dataUrl: extra };
  }
  if (!count) return { ok: false, error: extra || "Could not apply." };
  return { ok: true, count };
})();

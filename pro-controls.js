(async () => {
  const cmd = window.__popoutProCmd;
  const indices = window.__popoutProIndices || [];
  const value = window.__popoutProValue;
  try { delete window.__popoutProCmd; delete window.__popoutProIndices; delete window.__popoutProValue; } catch { window.__popoutProCmd = undefined; }
  if (!cmd) return { ok: false, error: "No command." };
  if (!["boost", "eq", "get-state"].includes(cmd)) return { ok: false, error: "Unknown audio command." };
  const videos = Array.from(document.querySelectorAll("video"));
  const targets = indices.length ? indices.map((i) => videos[i]).filter(Boolean) : videos;
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
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaElementSource(video);
      // 5-band EQ for much punchier / clearer sound than 2-band
      const low = makeFilter(ctx, "lowshelf", 110);
      const mid1 = makeFilter(ctx, "peaking", 400, 0.9);
      const mid2 = makeFilter(ctx, "peaking", 1200, 0.9);
      const mid3 = makeFilter(ctx, "peaking", 4000, 0.9);
      const high = makeFilter(ctx, "highshelf", 9500);
      const preGain = ctx.createGain();
      preGain.gain.value = 1;
      // Limiter: lets boost go to 400% loud without harsh clipping
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
      // Back-compat: old code expects gain/eqLow/eqHigh
      rec.gain = preGain; rec.eqLow = low; rec.eqHigh = high;
      window.__popoutAudioMap.set(video, rec);
      if (!window.__popoutAudioState.has(video)) {
        window.__popoutAudioState.set(video, { boost: 100, eq: "flat" });
      }
      return { rec };
    } catch (e) {
      const msg = e && e.message ? e.message : "";
      if (/already|InvalidState|mediaElementSource/i.test(msg)) {
        return { error: "This video is already hooked by another audio tool. Reload the page, then set boost once." };
      }
      return { error: msg || "Could not hook audio for this video." };
    }
  }

  async function unlock(rec) {
    try {
      if (rec.ctx.state === "suspended") {
        await rec.ctx.resume();
      }
    } catch { /* ignore */ }
    return rec.ctx.state;
  }

  // [low, mid1, mid2, mid3, high] in dB
  const PRESETS = {
    flat:  [0, 0, 0, 0, 0],
    bass:  [10, 4, 0, -1, 1],
    vocal: [-3, -1, 4, 5, 4],
    treble:[-5, -2, 0, 4, 8],
    loud:  [7, 3, 1, 3, 6],
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
    // Night mode: squash dynamics so quiet dialogue gets loud
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
    const st = window.__popoutAudioState.get(video) || { boost: 100, eq: "flat" };
    const hooked = window.__popoutAudioMap.has(video);
    const ctxState = hooked ? window.__popoutAudioMap.get(video).ctx.state : "unhooked";
    return { ...st, hooked, ctxState };
  }

  if (cmd === "get-state") {
    const states = targets.map((v) => getState(v));
    // Return first target's state for popup UI restore
    return { ok: true, count: targets.length, state: states[0], states };
  }

  let count = 0;
  let lastError = "";
  for (const v of targets) {
    try {
      const out = ensureAudio(v);
      if (out.error || !out.rec) {
        lastError = out.error || "Could not hook audio.";
        continue;
      }
      const rec = out.rec;
      const state = unlock(rec);
      const ctxState = await state;
      if (ctxState === "suspended") {
        lastError = "Browser blocked audio: click Play on the video once (page gesture), keep it playing, then set boost again.";
        continue;
      }
      if (cmd === "boost") {
        const pct = Math.max(100, Math.min(400, Number(value) || 100));
        rec.preGain.gain.setTargetAtTime(pct / 100, rec.ctx.currentTime, 0.02);
        const st = window.__popoutAudioState.get(v) || { boost: 100, eq: "flat" };
        st.boost = pct;
        window.__popoutAudioState.set(v, st);
        count++;
      } else if (cmd === "eq") {
        const name = String(value || "flat");
        applyEQ(rec, name);
        const st = window.__popoutAudioState.get(v) || { boost: 100, eq: "flat" };
        st.eq = name;
        window.__popoutAudioState.set(v, st);
        count++;
      }
    } catch (e) {
      lastError = (e && e.message) || "Could not apply.";
    }
  }
  if (!count) return { ok: false, error: lastError || "Could not apply audio boost. Click Play on the video first, keep it playing, then try again." };
  return { ok: true, count };
})();

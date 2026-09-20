(() => {
  if (window.__popoutCaptionInstalled) return;
  window.__popoutCaptionInstalled = true;

  // Keep one injected track per video to avoid duplicates
  const injectedTrackByVideo = new WeakMap();
  const cueCleanupByVideo = new WeakMap();

  function getVideos() {
    if (typeof window.__popoutCollectMain === "function") {
      try { return window.__popoutCollectMain(); } catch {}
    }
    const bucket = [];
    const seen = new Set();
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

  function enableNativeTracks(video) {
    let enabled = 0;
    try {
      const tracks = video.textTracks ? Array.from(video.textTracks) : [];
      for (const t of tracks) {
        if (t.kind === "captions" || t.kind === "subtitles") {
          // enable first captions track, hide others? we show first
          if (enabled === 0) { t.mode = "showing"; enabled++; }
          else { /* keep hidden to avoid double */ }
        }
      }
      // also enable <track> elements
      const els = video.querySelectorAll ? video.querySelectorAll("track") : [];
      for (const el of els) {
        if ((el.kind === "captions" || el.kind === "subtitles") && el.track) {
          try { el.track.mode = "showing"; enabled++; } catch {}
        }
      }
    } catch {}
    return enabled;
  }

  // Scrape YouTube / generic overlay captions and convert to native TextTrack
  // Returns { ok, count, method }
  function scrapeToTrack(video, idx) {
    // if already injected, update
    let track = injectedTrackByVideo.get(video);
    try {
      if (!track) {
        track = video.addTextTrack("captions", `Popout captions ${idx + 1}`, "en");
        track.mode = "showing";
        injectedTrackByVideo.set(video, track);
      } else {
        track.mode = "showing";
      }
    } catch (e) {
      return { ok: false, error: "Cannot add TextTrack: " + (e.message || "") };
    }

    // clean old cues beyond 30s ago
    try {
      const cues = track.cues ? Array.from(track.cues) : [];
      const now = video.currentTime || 0;
      for (const c of cues) {
        if (c && c.endTime < now - 8) try { track.removeCue(c); } catch {}
      }
    } catch {}

    let scraped = 0;
    let method = "none";
    const host = location.hostname || "";

    // YouTube: .ytp-caption-segment is live
    if (host.includes("youtube.com")) {
      try {
        const segs = document.querySelectorAll(".ytp-caption-segment");
        let text = "";
        for (const s of segs) text += (s.textContent || "") + " ";
        text = text.trim();
        if (text) {
          method = "youtube-dom";
          const now = video.currentTime || 0;
          // avoid duplicate cue
          const lastCue = track.cues && track.cues.length ? track.cues[track.cues.length - 1] : null;
          if (!lastCue || lastCue.text !== text) {
            const cue = new VTTCue(now, now + 3.5, text);
            cue.line = -1; // bottom
            track.addCue(cue);
            scraped = 1;
          } else if (lastCue) {
            // extend last cue
            try { lastCue.endTime = now + 3.5; } catch {}
            scraped = 1;
          }
        }
        // also setup live observer for continuous capture if not already
        if (!cueCleanupByVideo.has(video)) {
          const observer = new MutationObserver(() => {
            try {
              const segs2 = document.querySelectorAll(".ytp-caption-segment");
              let t2 = "";
              for (const s of segs2) t2 += (s.textContent || "") + " ";
              t2 = t2.trim();
              if (t2) {
                const now2 = video.currentTime || 0;
                const tr = injectedTrackByVideo.get(video);
                if (!tr) return;
                const cues2 = tr.cues ? Array.from(tr.cues) : [];
                const last2 = cues2.length ? cues2[cues2.length - 1] : null;
                if (!last2 || last2.text !== t2) {
                  const cue = new VTTCue(now2, now2 + 3.5, t2);
                  cue.line = -1;
                  tr.addCue(cue);
                } else {
                  try { last2.endTime = now2 + 3.5; } catch {}
                }
              }
            } catch {}
          });
          const capWin = document.querySelector(".ytp-caption-window-container, .ytp-caption-window-rollup");
          if (capWin) observer.observe(capWin, { childList: true, subtree: true, characterData: true });
          else {
            const fallback = document.querySelector(".html5-video-player");
            if (fallback) observer.observe(fallback, { childList: true, subtree: true, characterData: true });
          }
          cueCleanupByVideo.set(video, observer);
          // also sync via timeupdate to extend cue lifetime while text persists
          video.addEventListener("timeupdate", () => {
            try {
              const tr = injectedTrackByVideo.get(video);
              if (!tr || !tr.cues || !tr.cues.length) return;
              const last = tr.cues[tr.cues.length - 1];
              if (last && last.endTime < video.currentTime + 0.2) {
                // keep visible a bit longer if still same text on page
                const segsLive = document.querySelectorAll(".ytp-caption-segment");
                let live = "";
                for (const s of segsLive) live += (s.textContent || "") + " ";
                if (live.trim() === last.text) last.endTime = video.currentTime + 3;
              }
            } catch {}
          });
        }
      } catch (e) { /* ignore */ }
    }

    // Generic fallback: look for any visible caption-like div near video
    if (!scraped) {
      try {
        const candidates = document.querySelectorAll(".caption-visual-line, [data-purpose='captions-cue-text'], .jw-text-track-cue, .vjs-text-track-display div, .ytp-caption-segment, .caption-window, [class*='caption']");
        let best = "";
        for (const el of candidates) {
          const t = (el.textContent || "").trim();
          if (t && t.length > best.length && el.offsetParent !== null) best = t;
        }
        if (best) {
          method = "generic-dom";
          const now = video.currentTime || 0;
          const last = track.cues && track.cues.length ? track.cues[track.cues.length - 1] : null;
          if (!last || last.text !== best) {
            const cue = new VTTCue(now, now + 3, best);
            track.addCue(cue);
            scraped++;
          }
        }
      } catch {}
    }

    // If we scraped via DOM, return success; otherwise check if native already showing
    if (scraped) return { ok: true, count: scraped, method };
    // check native
    try {
      const tracks2 = video.textTracks ? Array.from(video.textTracks) : [];
      const showing = tracks2.filter(t => t.mode === "showing").length;
      if (showing) return { ok: true, count: showing, method: "native" };
    } catch {}
    return { ok: false, error: "No captions visible. Turn on CC on the page first." };
  }

  // Main entry: enable captions for given indices or all
  window.__popoutEnableCaptions = function (idxs, enable) {
    const videos = getVideos();
    const targets = (Array.isArray(idxs) && idxs.length ? idxs.map(i => videos[i]).filter(Boolean) : videos);
    if (!targets.length) return { ok: false, error: "No video found." };
    let enabled = 0;
    let lastErr = "";
    for (let i = 0; i < targets.length; i++) {
      const v = targets[i];
      const vidx = videos.indexOf(v);
      if (enable === false) {
        // disable
        try {
          const tr = injectedTrackByVideo.get(v);
          if (tr) tr.mode = "hidden";
          const tracks = v.textTracks ? Array.from(v.textTracks) : [];
          for (const t of tracks) t.mode = "hidden";
          enabled++;
        } catch (e) { lastErr = e.message; }
        continue;
      }
      // try native first
      let n = enableNativeTracks(v);
      if (n > 0) { enabled++; continue; }
      // try scrape -> track
      const res = scrapeToTrack(v, vidx);
      if (res.ok) enabled++;
      else lastErr = res.error || lastErr;
    }
    if (!enabled) return { ok: false, error: lastErr || "No captions found. Turn on CC on the page." };
    return { ok: true, count: enabled };
  };

  window.__popoutGrabCaptions = function (idxs) {
    const videos = getVideos();
    const targets = (Array.isArray(idxs) && idxs.length ? idxs.map(i => videos[i]).filter(Boolean) : videos.slice(0, 1));
    if (!targets.length) return { ok: false, error: "No video found." };
    const out = [];
    for (const v of targets) {
      const info = { label: v.title || "", tracks: [], cues: [], customText: "" };
      try {
        const tracks = v.textTracks ? Array.from(v.textTracks) : [];
        for (const t of tracks) {
          const tr = { kind: t.kind, label: t.label, language: t.language, mode: t.mode, cues: [] };
          try {
            const cues = t.cues ? Array.from(t.cues) : [];
            for (const c of cues) tr.cues.push({ start: c.startTime, end: c.endTime, text: c.text });
          } catch {}
          // also activeCues
          info.tracks.push(tr);
        }
        // child <track> elements src
        const els = v.querySelectorAll ? v.querySelectorAll("track") : [];
        for (const el of els) {
          info.tracks.push({ kind: el.kind, label: el.label, language: el.srclang, src: el.src, mode: el.track ? el.track.mode : "" });
        }
      } catch {}
      // custom overlay current text
      try {
        const host = location.hostname || "";
        if (host.includes("youtube.com")) {
          const segs = document.querySelectorAll(".ytp-caption-segment");
          let t = "";
          for (const s of segs) t += (s.textContent || "") + " ";
          info.customText = t.trim();
        } else {
          const el = document.querySelector(".caption-visual-line, .vjs-text-track-display, .jw-captions");
          if (el) info.customText = el.textContent.trim().slice(0, 400);
        }
      } catch {}
      // collect cues from injected track too
      try {
        const inj = injectedTrackByVideo.get(v);
        if (inj && inj.cues) {
          const cues = Array.from(inj.cues);
          for (const c of cues) info.cues.push({ start: c.startTime, end: c.endTime, text: c.text, injected: true });
        }
      } catch {}
      out.push(info);
    }
    return { ok: true, captions: out };
  };
})();

(async () => {
  const clearFlags = () => {
    try { delete window.__popoutVideoIndex; } catch { window.__popoutVideoIndex = undefined; }
    try { delete window.__popoutEnterOnly; } catch { window.__popoutEnterOnly = undefined; }
  };
  // helpers to remove PiP blocks (disablePictureInPicture, controlsList, attribute)
  function unblockVideo(v) {
    const prev = {};
    try { prev.disable = v.disablePictureInPicture; v.disablePictureInPicture = false; } catch {}
    try { prev.controlsList = v.controlsList ? String(v.controlsList) : null; if (v.controlsList) { try { v.controlsList.remove("nopictureinpicture"); } catch {} } } catch {}
    try { prev.attrDisable = v.hasAttribute("disablepictureinpicture"); if (prev.attrDisable) v.removeAttribute("disablepictureinpicture"); } catch {}
    try { prev.attrControls = v.getAttribute("controlslist") || null; if (prev.attrControls && prev.attrControls.includes("nopictureinpicture")) v.setAttribute("controlslist", prev.attrControls.replace(/nopictureinpicture/g, "").trim()); } catch {}
    return prev;
  }
  function restoreVideo(v, prev) {
    try { if (prev && "disable" in prev) v.disablePictureInPicture = prev.disable; } catch {}
    try { if (prev && prev.attrDisable) v.setAttribute("disablepictureinpicture", ""); } catch {}
    // controlsList restore is not critical
  }
  try {
    const enterOnly = !!window.__popoutEnterOnly;
    if (document.pictureInPictureElement) {
      if (enterOnly) { clearFlags(); return { ok: true, action: "already" }; }
      await document.exitPictureInPicture();
      clearFlags();
      return { ok: true, action: "exited" };
    }
    if (!document.pictureInPictureEnabled) {
      if (window.documentPictureInPicture && typeof documentPictureInPicture.requestWindow === "function") {
        throw new Error("Regular PiP is blocked on this site (Permissions-Policy). Try the hover Pop button or another tab — Document PiP may work for some sites.");
      }
      throw new Error("Picture-in-Picture is blocked on this site (Permissions-Policy). The site owner disabled PiP — try another site.");
    }
    const collectAllVideos = () => {
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
            if (el.tagName === "SLOT" && el.assignedElements) {
              try {
                const assigned = el.assignedElements({ flatten: true });
                for (const a of assigned) {
                  if (a.tagName === "VIDEO" && !seen.has(a)) { seen.add(a); bucket.push(a); }
                  if (a.querySelectorAll) {
                    const inner = a.querySelectorAll("video");
                    for (const v of inner) if (!seen.has(v)) { seen.add(v); bucket.push(v); }
                  }
                  const sr2 = a.shadowRoot || a.__popoutShadow;
                  if (sr2) deep(sr2);
                }
              } catch {}
            }
          }
        } catch {}
      }
      deep(document);
      try { if (document.documentElement && document.documentElement.shadowRoot) deep(document.documentElement.shadowRoot); } catch {}
      // registry fallback (MAIN world hook captures closed shadow / detached)
      try {
        if (window.__popoutRegistry && Array.isArray(window.__popoutRegistry)) {
          for (const v of window.__popoutRegistry) if (v && v.tagName === "VIDEO" && !seen.has(v)) { seen.add(v); bucket.push(v); }
        }
        if (typeof window.__popoutCollectMain === "function") {
          const mainVids = window.__popoutCollectMain();
          for (const v of mainVids) if (!seen.has(v)) { seen.add(v); bucket.push(v); }
        }
      } catch {}
      if (document.pictureInPictureElement && !seen.has(document.pictureInPictureElement)) bucket.push(document.pictureInPictureElement);
      return bucket;
    };
    const videos = collectAllVideos();
    if (!videos.length) {
      throw new Error("No video found in this frame. If video is inside an iframe or shadow DOM, use the popup list (now shows every frame) or hover the video for its on-page Pop button.");
    }
    const targetIndex = Number(window.__popoutVideoIndex);
    let video = null;
    if (Number.isInteger(targetIndex) && videos[targetIndex]) {
      video = videos[targetIndex];
    } else if (Number.isInteger(targetIndex)) {
      // index from popup may be frame-local but registry is global — try by registry order fallback
      const byIdx = videos.find((_, i) => i === targetIndex);
      video = byIdx || null;
    }
    if (!video) {
      const ready = videos.filter((v) => v.readyState > 0 && (v.videoWidth > 0 || v.readyState >= 2 || v.srcObject));
      if (!ready.length) {
        const drm = videos.some((v) => { try { return !!(v.mediaKeys || v.webkitKeys); } catch { return false; } });
        if (drm) throw new Error("DRM-protected video (Netflix/Prime/Disney+): Chrome blocks PiP or shows black. Try YouTube/Vimeo or a non-DRM video.");
        // try waiting briefly for readyState
        let waited = null;
        for (const v of videos) {
          if (v.readyState === 0) {
            try { await new Promise(r => { const on = () => { v.removeEventListener("loadedmetadata", on); r(); }; v.addEventListener("loadedmetadata", on, { once: true }); setTimeout(r, 800); }); } catch {}
            if (v.readyState > 0) waited = v;
          }
        }
        if (waited) video = waited;
        else throw new Error("Start playing the video, then try again. The popup list shows all detected videos — click the specific entry.");
      } else {
        const visible = (v) => {
          try { const r = v.getBoundingClientRect(); return r.width > 10 && r.height > 10 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; } catch { return false; }
        };
        const playing = ready.filter((v) => !v.paused && !v.ended);
        const onscreen = ready.filter(visible);
        const pool = playing.length ? playing : onscreen.length ? onscreen : ready;
        const area = (v) => { try { const r = v.getBoundingClientRect(); return Math.max(r.width * r.height, v.videoWidth * v.videoHeight); } catch { return v.videoWidth * v.videoHeight || 0; } };
        video = pool.sort((a, b) => area(b) - area(a))[0];
      }
    }
    if (!video) throw new Error("Could not select a video.");
    // Wait for ready if needed (up to 1.5s)
    if (video.readyState === 0 || (video.videoWidth === 0 && video.readyState < 3 && !video.srcObject)) {
      try {
        await new Promise((resolve) => {
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(); } };
          video.addEventListener("loadedmetadata", finish, { once: true });
          video.addEventListener("canplay", finish, { once: true });
          setTimeout(finish, 1200);
          // try play to trigger loading
          try { if (video.paused) video.play().catch(() => {}); } catch {}
        });
      } catch {}
      if (video.videoWidth === 0 && video.readyState < 2 && !video.srcObject) {
        const drmHint = (() => { try { return !!(video.mediaKeys || video.webkitKeys); } catch { return false; } })();
        if (drmHint) throw new Error("DRM video — PiP will show black. Use a non-DRM video.");
        throw new Error("Video not ready yet: click Play and wait 1-2 seconds, then Pop again. (Some sites buffer slowly)");
      }
    }
    const prev = unblockVideo(video);
    // --- captions: best effort — enable native tracks, else scrape overlay -> TextTrack so PiP shows subs ---
    try {
      // auto-enable captions if user didn't disable (default on if captions exist)
      const wantCaptions = window.__popoutCaptionsEnabled !== false; // allow page to opt-out via flag, default true
      if (wantCaptions) {
        // 1) enable native tracks
        try {
          const tracks = video.textTracks ? Array.from(video.textTracks) : [];
          let hasShowing = tracks.some(t => t.mode === "showing");
          if (!hasShowing) {
            for (const t of tracks) {
              if (t.kind === "captions" || t.kind === "subtitles") { t.mode = "showing"; hasShowing = true; break; }
            }
          }
          // also enable <track> elements
          if (!hasShowing && video.querySelectorAll) {
            const els = video.querySelectorAll("track[kind='captions'], track[kind='subtitles']");
            for (const el of els) if (el.track) { try { el.track.mode = "showing"; hasShowing = true; break; } catch {} }
          }
          // 2) if no native, try to scrape YouTube/generic overlay -> injected TextTrack
          if (!hasShowing) {
            const host = location.hostname || "";
            const tryInject = () => {
              try {
                if (!video.__popoutCaptionTrack) {
                  const tr = video.addTextTrack("captions", "Popout captions", "en");
                  tr.mode = "showing";
                  video.__popoutCaptionTrack = tr;
                }
                const tr = video.__popoutCaptionTrack;
                // dedup: check last cue text
                const getYTText = () => {
                  const segs = document.querySelectorAll(".ytp-caption-segment");
                  let txt = "";
                  for (const s of segs) txt += (s.textContent || "") + " ";
                  return txt.trim();
                };
                let text = "";
                if (host.includes("youtube.com")) text = getYTText();
                if (!text) {
                  const cand = document.querySelector(".caption-visual-line, [data-purpose='captions-cue-text'], .jw-text-track-cue, .vjs-text-track-display div");
                  if (cand && cand.offsetParent !== null) text = (cand.textContent || "").trim();
                }
                if (text) {
                  const now = video.currentTime || 0;
                  const cues = tr.cues ? Array.from(tr.cues) : [];
                  const last = cues.length ? cues[cues.length - 1] : null;
                  if (!last || last.text !== text) {
                    const cue = new VTTCue(now, now + 4, text);
                    cue.line = -1; // auto bottom
                    tr.addCue(cue);
                  } else {
                    try { last.endTime = now + 4; } catch {}
                  }
                  // setup live observer once
                  if (!video.__popoutCaptionObserver) {
                    const target = document.querySelector(".ytp-caption-window-container, .ytp-caption-window-rollup") || document.querySelector(".html5-video-player") || document.body;
                    if (target) {
                      const obs = new MutationObserver(() => {
                        try {
                          let t2 = "";
                          if (host.includes("youtube.com")) {
                            const segs2 = document.querySelectorAll(".ytp-caption-segment");
                            for (const s of segs2) t2 += (s.textContent || "") + " ";
                            t2 = t2.trim();
                          } else {
                            const c2 = document.querySelector(".caption-visual-line, .jw-text-track-cue");
                            if (c2) t2 = (c2.textContent || "").trim();
                          }
                          if (t2) {
                            const tr2 = video.__popoutCaptionTrack;
                            if (!tr2) return;
                            const now2 = video.currentTime || 0;
                            const cues2 = tr2.cues ? Array.from(tr2.cues) : [];
                            const last2 = cues2.length ? cues2[cues2.length - 1] : null;
                            if (!last2 || last2.text !== t2) {
                              const cue2 = new VTTCue(now2, now2 + 4, t2);
                              cue2.line = -1;
                              tr2.addCue(cue2);
                            } else {
                              try { last2.endTime = now2 + 4; } catch {}
                            }
                          }
                        } catch {}
                      });
                      obs.observe(target, { childList: true, subtree: true, characterData: true });
                      video.__popoutCaptionObserver = obs;
                    }
                  }
                  return true;
                }
                return false;
              } catch { return false; }
            };
            tryInject();
          }
        } catch {}
      }
    } catch {}
    try {
      if (video.paused) { try { await video.play(); } catch {} }
      await video.requestPictureInPicture();
      clearFlags();
      return { ok: true, action: "entered" };
    } catch (e) {
      restoreVideo(video, prev);
      throw e;
    } finally {
      // keep unblocked state for next attempt; do not restore disable flag immediately as it blocks retries
      clearFlags();
    }
  } catch (error) {
    clearFlags();
    const raw = error && error.message ? error.message : "Could not pop out this video.";
    if (/user gesture|user activation|handling a user|transient activation|not allowed/i.test(raw)) {
      return { ok: false, code: "NEEDS_GESTURE", error: "Chrome blocked PiP: it needs a recent click on the page. Click Play on the video once, then click Pop again within a few seconds. Most reliable: hover the video and click its on-page Pop out button, or right-click video > Pop out video." };
    }
    if (/Permissions-Policy|picture-in-picture.*disabled|NotSupportedError.*Picture-in-Picture/i.test(raw)) {
      return { ok: false, error: "This site blocks PiP via Permissions-Policy. Try the hover Pop button, or try in another tab." };
    }
    return { ok: false, error: raw };
  }
})();

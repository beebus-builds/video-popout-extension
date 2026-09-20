(() => {
  function deepVideos(root, out) {
    try {
      const vids = root.querySelectorAll ? root.querySelectorAll("video") : [];
      for (const v of vids) out.push(v);
      const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
      for (const el of all) {
        // open shadow roots
        if (el.shadowRoot) deepVideos(el.shadowRoot, out);
        // slots: assigned elements may contain videos outside shadow DOM tree
        try {
          if (el.tagName === "SLOT" && el.assignedElements) {
            const assigned = el.assignedElements({ flatten: true });
            for (const a of assigned) {
              if (a.tagName === "VIDEO") out.push(a);
              if (a.querySelectorAll) {
                const inner = a.querySelectorAll("video");
                for (const v of inner) out.push(v);
              }
              if (a.shadowRoot) deepVideos(a.shadowRoot, out);
            }
          }
        } catch { /* ignore */ }
      }
    } catch { return; }
  }
  // Also scan for video elements that are not attached but have srcObject (e.g., WebRTC)
  function scanUnattached(out, seen) {
    try {
      // Some players keep video detached or in closed shadow; fallback to global registry
      // Check any video that was ever created via HTMLVideoElement prototype hook? Not needed.
      // Instead, also check picture-in-picture element even if detached from layout
      if (document.pictureInPictureElement && !seen.has(document.pictureInPictureElement)) {
        out.push(document.pictureInPictureElement);
        seen.add(document.pictureInPictureElement);
      }
    } catch { /* ignore */ }
  }
  function thumbnail(video) {
    try {
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
      if (video.videoWidth < 16 || video.videoHeight < 16) return null;
      const canvas = document.createElement("canvas");
      const targetWidth = 112;
      const scale = targetWidth / video.videoWidth;
      canvas.width = targetWidth;
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.52);
    } catch {
      return null;
    }
  }
  function isAdVideo(video) {
    try {
      const host = location.hostname || "";
      if (host.includes("youtube.com")) {
        if (video.closest && video.closest(".ad-showing, .ytp-ad-module")) return true;
        if (video.src && video.src.includes("doubleclick")) return true;
      }
      if (video.duration && video.duration < 6 && video.closest && video.closest("[id*='ad']")) return true;
    } catch { return false; }
    return false;
  }
  function labelFor(video, index) {
    let label = video.getAttribute("aria-label") || video.title || video.getAttribute("alt") || "";
    if (!label) {
      try {
        const host = location.hostname || "";
        if (host.includes("youtube.com") && document.title) {
          label = document.title.replace(/ - YouTube$/, "").slice(0, 48);
        } else if (host.includes("vimeo.com") && document.title) {
          label = document.title.slice(0, 48);
        } else if (host.includes("netflix.com") || host.includes("twitch.tv") || host.includes("disneyplus.com") || host.includes("primevideo.com") || host.includes("hulu.com") || host.includes("hbomax.com") || host.includes("max.com")) {
          const t = document.querySelector("h1, [data-testid='title'], .title, [data-a-target='preview-card-title']");
          if (t && t.textContent) label = t.textContent.trim().slice(0, 48);
        }
        if (!label) {
          const src = video.currentSrc || video.src || "";
          if (src) {
            try {
              const parts = src.split("?")[0].split("/");
              label = decodeURIComponent(parts[parts.length - 1] || "").slice(0, 48);
            } catch { label = ""; }
          }
        }
      } catch { label = ""; }
    }
    return label || `Video ${index + 1}`;
  }
  const bucket = [];
  deepVideos(document, bucket);
  // include documentElement shadow edge case + PiP element
  try { if (document.documentElement && document.documentElement.shadowRoot) deepVideos(document.documentElement.shadowRoot, bucket); } catch { /* ignore */ }
  const seenPre = new Set(bucket);
  scanUnattached(bucket, seenPre);
  const seen = new Set();
  const uniq = bucket.filter((v) => {
    if (seen.has(v)) return false;
    seen.add(v);
    return true;
  });
  const list = uniq.map((video, index) => {
    let rect = { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 };
    try { rect = video.getBoundingClientRect(); } catch { rect = { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 }; }
    const playing = !video.paused && !video.ended;
    const visible = rect.width > 10 && rect.height > 10 && rect.bottom > 0 &&
      rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    // ready = has data; for sites that render via MediaStream/Canvas, videoWidth may be 0 until play — still consider ready if readyState >=2
    const ready = video.readyState > 0 && (video.videoWidth > 0 || video.readyState >= 2);
     const drmHint = (() => {
      try {
        if (video.mediaKeys || video.webkitKeys) return true;
        if (location.hostname.includes("netflix.com") || location.hostname.includes("disneyplus.com")) return ready && video.videoWidth === 0;
      } catch { return false; }
      return false;
    })();
    const captionInfo = (() => {
      try {
        const tracks = video.textTracks ? Array.from(video.textTracks) : [];
        const nativeShowing = tracks.filter(t => (t.kind === "captions" || t.kind === "subtitles") && t.mode === "showing").length;
        const nativeAny = tracks.filter(t => t.kind === "captions" || t.kind === "subtitles").length;
        const elTracks = video.querySelectorAll ? video.querySelectorAll("track[kind='captions'], track[kind='subtitles']").length : 0;
        // custom overlay detection (YouTube, Netflix, Prime, etc.)
        const host = location.hostname || "";
        let customFound = false;
        let customText = "";
        try {
          if (host.includes("youtube.com")) {
            const seg = document.querySelector(".ytp-caption-segment");
            if (seg && seg.textContent.trim()) { customFound = true; customText = seg.textContent.trim().slice(0, 80); }
          }
          if (!customFound) {
            const anyCap = document.querySelector(".caption-visual-line, [data-purpose='captions-cue-text'], .ytp-caption-window-container, .jw-captions, .vjs-text-track-display");
            if (anyCap && anyCap.textContent.trim()) customFound = true;
          }
        } catch {}
        return { hasCaptions: nativeAny > 0 || elTracks > 0 || customFound, nativeCount: nativeAny + elTracks, showingCount: nativeShowing, customFound, sample: customText };
      } catch { return { hasCaptions: false, nativeCount: 0, showingCount: 0, customFound: false }; }
    })();
    return {
      index,
      label: labelFor(video, index),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      playing,
      visible,
      ready,
      muted: !!video.muted,
      volume: typeof video.volume === "number" ? video.volume : 1,
      loop: !!video.loop,
      rate: video.playbackRate || 1,
      currentTime: Math.round(video.currentTime || 0),
      duration: Number.isFinite(video.duration) ? Math.round(video.duration) : 0,
      isAd: isAdVideo(video),
      drm: !!drmHint,
      inPip: document.pictureInPictureElement === video,
      thumb: ready && index < 12 ? thumbnail(video) : null,
      hasCaptions: !!captionInfo.hasCaptions,
      captionCount: captionInfo.nativeCount || 0,
      captionShowing: captionInfo.showingCount > 0,
      captionCustom: !!captionInfo.customFound
    };
  });
  let docPipOpen = false;
  try {
    docPipOpen = !!(window.documentPictureInPicture && window.documentPictureInPicture.window);
  } catch { docPipOpen = false; }
  return { videos: list, docPipOpen, site: location.hostname || "" };
})();

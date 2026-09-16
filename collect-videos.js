(() => {
  function deepVideos(root, out) {
    try {
      const vids = root.querySelectorAll ? root.querySelectorAll("video") : [];
      for (const v of vids) out.push(v);
      const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
      for (const el of all) {
        if (el.shadowRoot) deepVideos(el.shadowRoot, out);
      }
    } catch { return; }
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
    let label = video.getAttribute("aria-label") || video.title || "";
    if (!label) {
      try {
        const host = location.hostname || "";
        if (host.includes("youtube.com") && document.title) {
          label = document.title.replace(/ - YouTube$/, "").slice(0, 48);
        } else if (host.includes("netflix.com") || host.includes("twitch.tv") || host.includes("disneyplus.com") || host.includes("primevideo.com")) {
          const t = document.querySelector("h1, [data-testid='title'], .title");
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
  const seen = new Set();
  const uniq = bucket.filter((v) => {
    if (seen.has(v)) return false;
    seen.add(v);
    return true;
  });
  const list = uniq.map((video, index) => {
    const rect = video.getBoundingClientRect();
    const playing = !video.paused && !video.ended;
    const visible = rect.width > 10 && rect.height > 10 && rect.bottom > 0 &&
      rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    const ready = video.readyState > 0 && video.videoWidth > 0;
    const drmHint = (() => {
      try {
        if (video.mediaKeys || video.webkitKeys) return true;
        if (location.hostname.includes("netflix.com") || location.hostname.includes("disneyplus.com")) return ready && video.videoWidth === 0;
      } catch { return false; }
      return false;
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
      loop: !!video.loop,
      rate: video.playbackRate || 1,
      currentTime: Math.round(video.currentTime || 0),
      duration: Number.isFinite(video.duration) ? Math.round(video.duration) : 0,
      isAd: isAdVideo(video),
      drm: !!drmHint,
      inPip: document.pictureInPictureElement === video,
      thumb: ready && index < 12 ? thumbnail(video) : null
    };
  });
  let docPipOpen = false;
  try {
    docPipOpen = !!(window.documentPictureInPicture && window.documentPictureInPicture.window);
  } catch { docPipOpen = false; }
  return { videos: list, docPipOpen, site: location.hostname || "" };
})();

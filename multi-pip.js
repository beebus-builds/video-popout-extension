(async () => {
  try {
    const DocPip = window.documentPictureInPicture;
    if (!DocPip || typeof DocPip.requestWindow !== "function") {
      throw new Error("Multi-popout needs Chrome 116+. Update Chrome, or pop videos one at a time.");
    }
    if (DocPip.window) {
      DocPip.window.close();
      return { ok: true, action: "closed" };
    }
    if (document.pictureInPictureElement) {
      try { await document.exitPictureInPicture(); } catch { return; }
    }
    const allVideos = Array.from(document.querySelectorAll("video"));
    if (!allVideos.length) {
      throw new Error("No video found in this frame.");
    }
    let indices = window.__popoutVideoIndices;
    if (!Array.isArray(indices) || !indices.length) {
      indices = allVideos
        .map((v, i) => ({ v, i }))
        .filter(({ v }) => v.readyState > 0 && v.videoWidth > 0)
        .map(({ i }) => i);
    }
    indices = [...new Set(indices)].filter((i) => Number.isInteger(i) && allVideos[i]);
    if (!indices.length) {
      throw new Error("Start playing the videos, then try again.");
    }
    const targets = indices
      .map((i) => allVideos[i])
      .filter((v) => v.readyState > 0 && v.videoWidth > 0);
    if (!targets.length) {
      throw new Error("Start playing the videos, then try again.");
    }
    const preset = window.__popoutWindowSize || { width: 640, height: 360 };
    const baseWidth = Math.min(1280, Math.max(320, Number(preset.width) || 640));
    const baseHeight = Math.min(800, Math.max(180, Number(preset.height) || 360));
    const width = baseWidth;
    const height = targets.length === 1 ? baseHeight : Math.min(baseHeight * 2, Math.round(baseHeight * 0.66 * targets.length));
    const pipWindow = await DocPip.requestWindow({ width, height });
    try {
      [...document.styleSheets].forEach((sheet) => {
        try {
          const cssRules = [...sheet.cssRules].map((rule) => rule.cssText).join("");
          const style = pipWindow.document.createElement("style");
          style.textContent = cssRules;
          pipWindow.document.head.appendChild(style);
        } catch { return; }
      });
    } catch { return; }
    const style = pipWindow.document.createElement("style");
    style.textContent = "body{margin:0;background:#000;display:flex;flex-direction:column;gap:4px;padding:4px;box-sizing:border-box}video{width:100%;flex:1;min-height:0;background:#000}video:only-child{height:100%}";
    pipWindow.document.head.appendChild(style);
    const moved = [];
    for (const video of targets) {
      const placeholder = document.createElement("div");
      placeholder.setAttribute("data-popout-placeholder", "1");
      placeholder.style.cssText = "display:none";
      video.parentNode.insertBefore(placeholder, video);
      try { video.disablePictureInPicture = false; } catch { return; }
      pipWindow.document.body.appendChild(video);
      moved.push({ video, placeholder });
      try { await video.play().catch(() => {}); } catch { return; }
    }
    const restore = () => {
      for (const { video, placeholder } of moved) {
        try {
          if (placeholder.parentNode) {
            placeholder.parentNode.insertBefore(video, placeholder);
            placeholder.remove();
          }
        } catch { return; }
      }
    };
    pipWindow.addEventListener("pagehide", restore, { once: true });
    pipWindow.addEventListener("unload", restore, { once: true });
    try { delete window.__popoutVideoIndices; } catch { window.__popoutVideoIndices = undefined; }
    try { delete window.__popoutWindowSize; } catch { window.__popoutWindowSize = undefined; }
    return { ok: true, action: "entered", count: moved.length };
  } catch (error) {
    try { delete window.__popoutVideoIndices; } catch { window.__popoutVideoIndices = undefined; }
    try { delete window.__popoutWindowSize; } catch { window.__popoutWindowSize = undefined; }
    return { ok: false, error: error && error.message ? error.message : "Could not pop out these videos." };
  }
})();

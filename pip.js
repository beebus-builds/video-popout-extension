(async () => {
  const clearFlags = () => {
    try { delete window.__popoutVideoIndex; } catch { window.__popoutVideoIndex = undefined; }
    try { delete window.__popoutEnterOnly; } catch { window.__popoutEnterOnly = undefined; }
  };
  try {
    const enterOnly = !!window.__popoutEnterOnly;
    if (document.pictureInPictureElement) {
      if (enterOnly) {
        clearFlags();
        return { ok: true, action: "already" };
      }
      await document.exitPictureInPicture();
      clearFlags();
      return { ok: true, action: "exited" };
    }
    if (!document.pictureInPictureEnabled) {
      throw new Error("Picture-in-Picture is not supported on this page.");
    }
    const videos = Array.from(document.querySelectorAll("video"));
    if (!videos.length) {
      throw new Error("No video found in this frame.");
    }
    const targetIndex = Number(window.__popoutVideoIndex);
    let video = null;
    if (Number.isInteger(targetIndex) && videos[targetIndex]) {
      video = videos[targetIndex];
    } else {
      const ready = videos.filter((v) => v.readyState > 0 && v.videoWidth > 0);
      if (!ready.length) {
        throw new Error("Start playing the video, then try again.");
      }
      const visible = (v) => {
        const r = v.getBoundingClientRect();
        return r.width > 10 && r.height > 10 && r.bottom > 0 &&
          r.right > 0 && r.top < innerHeight && r.left < innerWidth;
      };
      const playing = ready.filter((v) => !v.paused && !v.ended);
      const onscreen = ready.filter(visible);
      const pool = playing.length ? playing : onscreen.length ? onscreen : ready;
      const area = (v) => {
        const r = v.getBoundingClientRect();
        return r.width * r.height;
      };
      video = pool.sort((a, b) => area(b) - area(a))[0];
    }
    if (!video || video.readyState === 0 || video.videoWidth === 0) {
      throw new Error("Start playing the video, then try again.");
    }
    const disabled = video.disablePictureInPicture;
    try {
      video.disablePictureInPicture = false;
      await video.requestPictureInPicture();
    } finally {
      video.disablePictureInPicture = disabled;
      clearFlags();
    }
    return { ok: true, action: "entered" };
  } catch (error) {
    clearFlags();
    return { ok: false, error: error && error.message ? error.message : "Could not pop out this video." };
  }
})();

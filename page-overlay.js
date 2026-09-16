(() => {
  if (window.__popoutOverlayInstalled) return;
  window.__popoutOverlayInstalled = true;

  const BTN_CLASS = "__popout-hover-btn";

  function isEditable(el) {
    return el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
  }

  function findVideoIndex(video) {
    try {
      const videos = Array.from(document.querySelectorAll("video"));
      return videos.indexOf(video);
    } catch {
      return -1;
    }
  }

  function popVideo(video) {
    const index = findVideoIndex(video);
    if (index < 0) return;
    chrome.runtime.sendMessage({ type: "OVERLAY_POP", index }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && !res.ok) {
        showTip(video, res.error || "Could not pop out this video.");
      }
    });
  }

  function showTip(video, text) {
    try {
      const tip = document.createElement("div");
      tip.textContent = String(text).slice(0, 120);
      tip.style.cssText = "position:fixed;z-index:2147483647;background:#111214;color:#fff;font-size:12px;padding:6px 9px;border-radius:6px;pointer-events:none;max-width:260px";
      const r = video.getBoundingClientRect();
      tip.style.left = Math.max(8, r.left + window.scrollX) + "px";
      tip.style.top = Math.max(8, r.top + window.scrollY) + "px";
      document.documentElement.appendChild(tip);
      setTimeout(() => tip.remove(), 2600);
    } catch { return; }
  }

  function makeButton(video) {
    const btn = document.createElement("button");
    btn.className = BTN_CLASS;
    btn.type = "button";
    btn.textContent = "Pop out";
    btn.style.cssText = "position:absolute;z-index:2147483646;background:rgba(17,18,20,0.92);color:#fff;border:1px solid rgba(255,255,255,0.25);border-radius:7px;padding:5px 9px;font-size:12px;font-weight:600;cursor:pointer;display:none;font-family:system-ui,sans-serif";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      popVideo(video);
    });
    document.documentElement.appendChild(btn);
    return btn;
  }

  const btnByVideo = new WeakMap();

  function buttonFor(video) {
    let btn = btnByVideo.get(video);
    if (!btn || !btn.isConnected) {
      btn = makeButton(video);
      btnByVideo.set(video, btn);
    }
    return btn;
  }

  function positionButton(video) {
    const btn = buttonFor(video);
    const r = video.getBoundingClientRect();
    if (r.width < 60 || r.height < 40) {
      btn.style.display = "none";
      return;
    }
    btn.style.display = "block";
    btn.style.left = (r.left + window.scrollX + Math.max(6, r.width - 96)) + "px";
    btn.style.top = (r.top + window.scrollY + 8) + "px";
  }

  function hideButton(video) {
    const btn = btnByVideo.get(video);
    if (btn) btn.style.display = "none";
  }

  document.addEventListener("mouseover", (e) => {
    if (isEditable(e.target)) return;
    const video = e.target && e.target.closest ? e.target.closest("video") : null;
    if (video) positionButton(video);
  }, true);

  document.addEventListener("mouseout", (e) => {
    const video = e.target && e.target.closest ? e.target.closest("video") : null;
    if (!video) return;
    const to = e.relatedTarget;
    if (to && to.classList && to.classList.contains(BTN_CLASS)) return;
    setTimeout(() => hideButton(video), 120);
  }, true);

  window.addEventListener("scroll", () => {
    document.querySelectorAll("video").forEach((video) => {
      const btn = btnByVideo.get(video);
      if (btn && btn.style.display === "block") positionButton(video);
    });
  }, true);
})();

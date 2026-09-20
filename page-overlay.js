(() => {
  if (window.__popoutOverlayInstalled) return;
  window.__popoutOverlayInstalled = true;

  const BTN_CLASS = "__popout-hover-btn";

  function isEditable(el) {
    return el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
  }

  function findVideoIndex(video) {
    try {
      // For shadow DOM videos, query in same root
      const root = video.getRootNode ? video.getRootNode() : document;
      const vids = root.querySelectorAll ? Array.from(root.querySelectorAll("video")) : Array.from(document.querySelectorAll("video"));
      let idx = vids.indexOf(video);
      if (idx >= 0) return idx;
      // fallback to document index
      return Array.from(document.querySelectorAll("video")).indexOf(video);
    } catch {
      return -1;
    }
  }

  async function popVideo(video) {
    // Try direct PiP first: this click IS a page user gesture,
    // so it satisfies Chrome's requestPictureInPicture gesture requirement.
    // The background round-trip via executeScript loses the gesture.
    try {
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture();
        return;
      }
      if (document.pictureInPictureElement) {
        try { await document.exitPictureInPicture(); } catch { /* continue */ }
      }
      // Some sites set disablePictureInPicture via attribute; try to override
      const prev = video.disablePictureInPicture;
      const prevAttr = video.hasAttribute("disablepictureinpicture");
      try {
        video.disablePictureInPicture = false;
        if (prevAttr) video.removeAttribute("disablepictureinpicture");
        // Ensure video is playing — helps gesture
        if (video.paused) { try { await video.play(); } catch { /* ignore */ } }
        await video.requestPictureInPicture();
        return;
      } catch (directErr) {
        try { video.disablePictureInPicture = prev; } catch { /* ignore */ }
        if (prevAttr) try { video.setAttribute("disablepictureinpicture", ""); } catch { /* ignore */ }
        const msg = directErr && directErr.message ? directErr.message : "";
        // Only fall back to background for non-gesture errors;
        // gesture errors from direct attempt won't succeed via background either.
        if (/user gesture|user activation|handling a user/i.test(msg)) {
          showTip(video, "Chrome needs a page click first: click Play on the video, then Pop again.");
          return;
        }
        if (/Permissions-Policy|picture-in-picture.*disabled/i.test(msg)) {
          showTip(video, "This site blocks PiP (Permissions-Policy). Try another site.");
          return;
        }
      }
    } catch { /* fall through to background */ }
    const index = findVideoIndex(video);
    if (index < 0) {
      // Shadow DOM video index not found — fallback: try direct with frame's index via background helper
      try {
        const vids = Array.from(document.querySelectorAll("video"));
        const altIdx = vids.indexOf(video);
        if (altIdx >= 0) {
          chrome.runtime.sendMessage({ type: "OVERLAY_POP", index: altIdx }, (res) => {
            if (chrome.runtime.lastError) return;
            if (res && !res.ok) showTip(video, res.error || "Could not pop out this video.");
          });
          return;
        }
      } catch { /* ignore */ }
      showTip(video, "Could not find video index.");
      return;
    }
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
      tip.textContent = String(text).slice(0, 160);
      tip.style.cssText = "position:fixed;z-index:2147483647;background:#111214;color:#fff;font-size:12px;padding:6px 9px;border-radius:6px;pointer-events:none;max-width:320px;box-shadow:0 4px 12px rgba(0,0,0,0.3)";
      const r = video.getBoundingClientRect();
      tip.style.left = Math.max(8, r.left + window.scrollX) + "px";
      tip.style.top = Math.max(8, r.top + window.scrollY) + "px";
      document.documentElement.appendChild(tip);
      setTimeout(() => tip.remove(), 3200);
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
    let r;
    try { r = video.getBoundingClientRect(); } catch { btn.style.display = "none"; return; }
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

  // Hover handling — works even for videos added dynamically
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

  // Also watch for dynamically added videos (SPA, YouTube, Twitter, etc.) and shadow roots
  try {
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.tagName === "VIDEO") {
            // pre-warm button so hover is instant
            buttonFor(n);
          }
          if (n.querySelectorAll) {
            const vids = n.querySelectorAll("video");
            for (const v of vids) buttonFor(v);
            // handle shadow roots of added elements
            const all = n.querySelectorAll("*");
            for (const el of all) {
              if (el.shadowRoot) {
                const sv = el.shadowRoot.querySelectorAll("video");
                for (const v of sv) buttonFor(v);
              }
            }
          }
          if (n.shadowRoot) {
            const sv = n.shadowRoot.querySelectorAll("video");
            for (const v of sv) buttonFor(v);
          }
        }
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch { /* ignore */ }

  // Also periodically reposition visible buttons (accounts for video moving without scroll)
  try {
    setInterval(() => {
      const all = (() => {
        const bucket = []; const seen = new Set();
        function deep(root) {
          try {
            const vids = root.querySelectorAll ? root.querySelectorAll("video") : [];
            for (const v of vids) if (!seen.has(v)) { seen.add(v); bucket.push(v); }
            const allEls = root.querySelectorAll ? root.querySelectorAll("*") : [];
            for (const el of allEls) {
              const sr = el.shadowRoot || el.__popoutShadow;
              if (sr) deep(sr);
            }
          } catch {}
        }
        deep(document);
        try { if (window.__popoutRegistry) for (const v of window.__popoutRegistry) if (v && !seen.has(v)) bucket.push(v); } catch {}
        try { if (window.__popoutCollectMain) for (const v of window.__popoutCollectMain()) if (!seen.has(v)) bucket.push(v); } catch {}
        return bucket;
      })();
      all.forEach((video) => {
        const btn = btnByVideo.get(video);
        if (btn && btn.style.display === "block") positionButton(video);
      });
    }, 1000);
  } catch { /* ignore */ }

  // Periodically scan registry for new videos in closed shadow that MutationObserver can't see
  try {
    setInterval(() => {
      try {
        const reg = window.__popoutRegistry || [];
        for (const v of reg) if (v && v.tagName === "VIDEO" && !btnByVideo.has(v)) buttonFor(v);
        if (window.__popoutCollectMain) {
          const mainVids = window.__popoutCollectMain();
          for (const v of mainVids) if (!btnByVideo.has(v)) buttonFor(v);
        }
      } catch {}
    }, 1500);
  } catch { /* ignore */ }
})();

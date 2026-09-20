(() => {
  if (window.__popoutRegistryInstalled) return;
  window.__popoutRegistryInstalled = true;

  // Stores WeakRef-like list; we keep strong refs but deduplicate
  if (!window.__popoutRegistry) window.__popoutRegistry = [];
  const registry = window.__popoutRegistry;
  const seen = new WeakSet();

  function register(v) {
    if (!v || v.tagName !== "VIDEO") return;
    if (seen.has(v)) return;
    seen.add(v);
    registry.push(v);
    // keep last 50 to avoid leak, but keep playing ones
    if (registry.length > 80) {
      // remove first non-playing, non-pip, detached
      for (let i = 0; i < registry.length - 50; i++) {
        const cand = registry[i];
        if (!cand || cand.paused || !cand.isConnected) {
          registry.splice(i, 1);
          break;
        }
      }
    }
  }

  // 1) Patch createElement to catch video before shadow
  try {
    const origCreate = Document.prototype.createElement;
    Document.prototype.createElement = function (tag, opts) {
      const el = origCreate.call(this, tag, opts);
      if (String(tag).toLowerCase() === "video") register(el);
      return el;
    };
  } catch {}

  // 2) Patch attachShadow to observe shadow roots (including closed)
  try {
    const origAttach = Element.prototype.attachShadow;
    if (origAttach) {
      Element.prototype.attachShadow = function (init) {
        const shadow = origAttach.call(this, init);
        try {
          // observe that shadow root for videos
          observeRoot(shadow);
          // also patch shadow's createElement? shadow is DocumentFragment, not needed
          this.__popoutShadow = shadow; // keep ref even if closed
        } catch {}
        return shadow;
      };
    }
  } catch {}

  function observeRoot(root) {
    try {
      // collect existing
      const vids = root.querySelectorAll ? root.querySelectorAll("video") : [];
      for (const v of vids) register(v);
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.tagName === "VIDEO") register(n);
            if (n.querySelectorAll) {
              const inner = n.querySelectorAll("video");
              for (const v of inner) register(v);
            }
            if (n.shadowRoot) observeRoot(n.shadowRoot);
            // if element has __popoutShadow (closed), observe it
            if (n.__popoutShadow) observeRoot(n.__popoutShadow);
          }
        }
      });
      obs.observe(root, { childList: true, subtree: true });
    } catch {}
  }

  // 3) Main document observers
  try {
    observeRoot(document);
    if (document.documentElement && document.documentElement.shadowRoot) observeRoot(document.documentElement.shadowRoot);
  } catch {}

  // 4) Also capture via HTMLVideoElement play/load events
  try {
    document.addEventListener("play", (e) => { if (e.target && e.target.tagName === "VIDEO") register(e.target); }, true);
    document.addEventListener("loadeddata", (e) => { if (e.target && e.target.tagName === "VIDEO") register(e.target); }, true);
    document.addEventListener("loadedmetadata", (e) => { if (e.target && e.target.tagName === "VIDEO") register(e.target); }, true);
  } catch {}

  // Expose helper for MAIN world collection
  window.__popoutCollectMain = function () {
    const out = [];
    const seen2 = new Set();
    function deep(root) {
      try {
        const vids = root.querySelectorAll ? root.querySelectorAll("video") : [];
        for (const v of vids) if (!seen2.has(v)) { seen2.add(v); out.push(v); }
        const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
        for (const el of all) {
          const sr = el.shadowRoot || el.__popoutShadow;
          if (sr) deep(sr);
          if (el.tagName === "SLOT" && el.assignedElements) {
            try {
              const assigned = el.assignedElements({ flatten: true });
              for (const a of assigned) {
                if (a.tagName === "VIDEO" && !seen2.has(a)) { seen2.add(a); out.push(a); }
                if (a.querySelectorAll) {
                  const inner = a.querySelectorAll("video");
                  for (const v of inner) if (!seen2.has(v)) { seen2.add(v); out.push(v); }
                }
                const sr2 = a.shadowRoot || a.__popoutShadow;
                if (sr2) deep(sr2);
              }
            } catch {}
          }
        }
      } catch {}
    }
    try { deep(document); } catch {}
    try { if (document.documentElement && document.documentElement.shadowRoot) deep(document.documentElement.shadowRoot); } catch {}
    // add registry videos that may be detached or in closed shadow
    for (const v of registry) {
      if (v && !seen2.has(v)) {
        // verify it's still a video element
        try { if (v.tagName === "VIDEO") { seen2.add(v); out.push(v); } } catch {}
      }
    }
    // also add current PiP element if detached
    try { if (document.pictureInPictureElement && !seen2.has(document.pictureInPictureElement)) out.push(document.pictureInPictureElement); } catch {}
    return out;
  };
})();

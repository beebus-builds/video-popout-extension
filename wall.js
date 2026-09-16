const grid = document.getElementById("grid");
const countEl = document.getElementById("count");
let ids = [];

function render(list) {
  grid.innerHTML = "";
  countEl.textContent = list.length ? `Video Wall · ${list.length} videos` : "Video Wall";
  for (const id of list) {
    const f = document.createElement("iframe");
    f.src = `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&rel=0&enablejsapi=0`;
    f.allow = "autoplay; fullscreen; picture-in-picture";
    f.loading = "lazy";
    grid.appendChild(f);
  }
  if (!list.length) {
    const p = document.createElement("div");
    p.style.cssText = "color:#9ca3af;padding:20px;text-align:center";
    p.textContent = "No YouTube videos found. Open YouTube tabs, then reopen the wall.";
    grid.appendChild(p);
  }
}

document.getElementById("close").addEventListener("click", () => window.close());
document.getElementById("pip-wall").addEventListener("click", async () => {
  try {
    if (window.documentPictureInPicture && documentPictureInPicture.window) {
      documentPictureInPicture.window.close();
      return;
    }
    if (!window.documentPictureInPicture || typeof documentPictureInPicture.requestWindow !== "function") {
      alert("Always-on-top wall needs Chrome 116+.");
      return;
    }
    const pip = await documentPictureInPicture.requestWindow({ width: 960, height: 540 });
    [...document.styleSheets].forEach((s) => {
      try {
        const css = [...s.cssRules].map((r) => r.cssText).join("");
        const el = pip.document.createElement("style");
        el.textContent = css;
        pip.document.head.appendChild(el);
      } catch { return; }
    });
    const style = pip.document.createElement("style");
    style.textContent = "body{margin:0;background:#000} .grid{display:grid;gap:4px;padding:4px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))} iframe{width:100%;aspect-ratio:16/9;border:0;border-radius:8px}";
    pip.document.head.appendChild(style);
    const clone = grid.cloneNode(true);
    pip.document.body.appendChild(clone);
    pip.addEventListener("pagehide", () => pip.close());
  } catch (e) {
    alert(e.message || "Could not pop the wall.");
  }
});

(async () => {
  try {
    const q = new URLSearchParams(location.search);
    const fromQuery = q.get("ids");
    if (fromQuery) {
      ids = fromQuery.split(",").map((s) => s.trim()).filter(Boolean);
      render(ids);
      return;
    }
    const data = await chrome.storage.session.get({ wallIds: [] }).catch(() => ({ wallIds: [] }));
    ids = (data.wallIds || []).filter(Boolean);
    render(ids);
  } catch {
    render([]);
  }
})();

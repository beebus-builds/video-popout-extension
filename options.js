const DEFAULTS = {
  searchIframes: true,
  showPicker: true,
  autoRepopout: false,
  captureAudio: true,
  showContextMenu: true,
  hoverButtons: true,
  autoPipOnSwitch: false,
  autoPauseBackground: false,
  resumeOnReturn: false,
  docPipSize: "balanced",
  siteRules: {}
};

const CHECKS = ["searchIframes", "showPicker", "autoRepopout", "captureAudio", "showContextMenu", "hoverButtons", "autoPipOnSwitch", "autoPauseBackground", "resumeOnReturn"];

const els = {
  permRow: document.getElementById("permRow"),
  permStatus: document.getElementById("permStatus"),
  grantPerms: document.getElementById("grantPerms"),
  shortcuts: document.getElementById("shortcuts"),
  status: document.getElementById("status"),
  docPipSize: document.getElementById("docPipSize"),
  rules: document.getElementById("rules"),
  exportBtn: document.getElementById("export"),
  importInput: document.getElementById("import")
};
for (const key of CHECKS) {
  els[key] = document.getElementById(key);
}

let saveTimer = null;

function setStatus(text, isError = false) {
  els.status.textContent = text || "";
  els.status.classList.toggle("error", isError);
}

async function refreshPermRow() {
  const hasAccess = await chrome.permissions.contains({ origins: ["<all_urls>"] }).catch(() => false);
  const wantsAuto = els.autoRepopout?.checked || els.autoPipOnSwitch?.checked || els.autoPauseBackground?.checked;
  els.permRow.hidden = !(wantsAuto && !hasAccess);
  els.permStatus.textContent = hasAccess ? "Site access granted." : "Site access is required for automatic features.";
}

function renderRules(rules) {
  els.rules.innerHTML = "";
  const entries = Object.entries(rules || {});
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "lede";
    empty.textContent = "No per-site rules yet. Use the popup’s “This site” selector to add one.";
    els.rules.appendChild(empty);
    return;
  }
  for (const [origin, rule] of entries.sort()) {
    const row = document.createElement("div");
    row.className = "rule-row";
    const name = document.createElement("span");
    name.className = "origin";
    name.textContent = origin;
    name.title = origin;
    const actions = document.createElement("span");
    actions.className = "actions";
    const sel = document.createElement("select");
    for (const value of ["always", "never"]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = value === "always" ? "Always pop" : "Never auto";
      sel.appendChild(opt);
    }
    sel.value = rule;
    sel.addEventListener("change", async () => {
      const current = { ...((await chrome.storage.sync.get({ siteRules: {} }).catch(() => ({ siteRules: {} }))).siteRules || {}) };
      current[origin] = sel.value;
      await chrome.storage.sync.set({ siteRules: current });
      setStatus("Saved.");
    });
    const remove = document.createElement("button");
    remove.className = "secondary";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      const current = { ...((await chrome.storage.sync.get({ siteRules: {} }).catch(() => ({ siteRules: {} }))).siteRules || {}) };
      delete current[origin];
      await chrome.storage.sync.set({ siteRules: current });
      renderRules(current);
      setStatus("Saved.");
    });
    actions.appendChild(sel);
    actions.appendChild(remove);
    row.appendChild(name);
    row.appendChild(actions);
    els.rules.appendChild(row);
  }
}

async function load() {
  const settings = { ...DEFAULTS, ...await chrome.storage.sync.get(DEFAULTS).catch(() => ({})) };
  for (const key of CHECKS) {
    if (els[key]) els[key].checked = !!settings[key];
  }
  if (els.docPipSize) els.docPipSize.value = settings.docPipSize || "balanced";
  renderRules(settings.siteRules);
  await refreshPermRow();
}

async function save() {
  const settings = {};
  for (const key of CHECKS) {
    settings[key] = !!els[key]?.checked;
  }
  settings.docPipSize = els.docPipSize?.value || "balanced";
  const previous = await chrome.storage.sync.get({ siteRules: {} }).catch(() => ({ siteRules: {} }));
  settings.siteRules = previous.siteRules || {};
  await chrome.storage.sync.set(settings);
  if (settings.autoRepopout || settings.autoPipOnSwitch || settings.autoPauseBackground) {
    const hasAccess = await chrome.permissions.contains({ origins: ["<all_urls>"] }).catch(() => false);
    if (!hasAccess) {
      const granted = await chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => false);
      if (!granted) {
        setStatus("Automation is on, but without site access it only works after you click.", true);
        renderRules(settings.siteRules);
        await refreshPermRow();
        return;
      }
    }
  }
  renderRules(settings.siteRules);
  await refreshPermRow();
  setStatus("Saved.");
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => setStatus(""), 1500);
}

for (const key of CHECKS) {
  els[key]?.addEventListener("change", () => { void save(); });
}
els.docPipSize?.addEventListener("change", () => { void save(); });

els.grantPerms.addEventListener("click", async () => {
  const granted = await chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => false);
  setStatus(granted ? "Site access granted." : "Site access was not granted.", !granted);
  await refreshPermRow();
});

els.shortcuts.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

els.exportBtn.addEventListener("click", async () => {
  const data = await chrome.storage.sync.get(null).catch(() => ({}));
  const blob = new Blob([JSON.stringify({ ...DEFAULTS, ...data }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "video-popout-settings.json"; a.click();
  URL.revokeObjectURL(url);
});

els.importInput.addEventListener("change", async () => {
  const file = els.importInput.files && els.importInput.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const toSave = {};
    for (const k of Object.keys(DEFAULTS)) if (k in parsed) toSave[k] = parsed[k];
    await chrome.storage.sync.set(toSave);
    await load();
    setStatus("Imported.");
  } catch {
    setStatus("Import failed — invalid file.", true);
  }
  els.importInput.value = "";
});

void load();

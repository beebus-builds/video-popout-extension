const DEFAULTS = {
  searchIframes: true,
  showPicker: true,
  hoverButtons: true,
  showContextMenu: true
};

const CHECKS = ["searchIframes", "showPicker", "hoverButtons", "showContextMenu"];

const els = {
  status: document.getElementById("status")
};
for (const key of CHECKS) {
  els[key] = document.getElementById(key);
}

let saveTimer = null;

function setStatus(text) {
  els.status.textContent = text || "";
}

async function load() {
  const settings = { ...DEFAULTS, ...await chrome.storage.sync.get(DEFAULTS).catch(() => ({})) };
  for (const key of CHECKS) {
    if (els[key]) els[key].checked = !!settings[key];
  }
}

async function save() {
  const settings = {};
  for (const key of CHECKS) {
    settings[key] = !!els[key]?.checked;
  }
  await chrome.storage.sync.set(settings);
  setStatus("Saved.");
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => setStatus(""), 1500);
}

for (const key of CHECKS) {
  els[key]?.addEventListener("change", () => { void save(); });
}

void load();

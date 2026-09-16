const video = document.getElementById("preview");
const statusEl = document.getElementById("status");
const soundBtn = document.getElementById("sound");
const pipBtn = document.getElementById("pip");
const stopBtn = document.getElementById("stop");

let stream = null;
let audioCtx = null;
let wantAudio = false;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function cleanup() {
  try {
    if (document.pictureInPictureElement) {
      void document.exitPictureInPicture().catch(() => {});
    }
  } catch { return; }
  if (stream) {
    for (const track of stream.getTracks()) {
      try { track.stop(); } catch { return; }
    }
    stream = null;
  }
  if (audioCtx) {
    const ctx = audioCtx;
    audioCtx = null;
    void ctx.close().catch(() => {});
  }
}

window.addEventListener("pagehide", cleanup);

function attachEndedHandler() {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    track.onended = () => {
      setStatus("Source tab closed — this window can be closed.", true);
      pipBtn.disabled = true;
      soundBtn.disabled = true;
    };
  }
}

async function enableAudio() {
  if (!stream || !wantAudio) return;
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    setStatus("Tab has no audio to play.", true);
    soundBtn.disabled = true;
    return;
  }
  try {
    if (!audioCtx) {
      audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(new MediaStream(audioTracks));
      source.connect(audioCtx.destination);
    }
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }
    if (audioCtx.state === "running") {
      soundBtn.disabled = true;
      setStatus("Live tab preview with sound.");
    }
  } catch {
    setStatus("Could not enable sound in this browser.", true);
  }
}

soundBtn.addEventListener("click", () => { void enableAudio(); });

pipBtn.addEventListener("click", async () => {
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      return;
    }
    await video.requestPictureInPicture();
  } catch {
    setStatus("Always-on-top is not available for this preview.", true);
  }
});

stopBtn.addEventListener("click", () => {
  cleanup();
  window.close();
});

(async () => {
  const maxAttempts = 12;
  let info = null;
  let lastError = "";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "CAPTURE_READY" });
      if (res && res.ok && res.streamId) {
        info = res;
        break;
      }
      lastError = (res && res.error) || "Capture not ready yet.";
    } catch (error) {
      lastError = error?.message || "Capture not ready yet.";
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!info) {
    setStatus(lastError || "Capture session expired. Please try again.", true);
    return;
  }
  wantAudio = !!info.audio;
  const constraints = {
    audio: info.audio
      ? { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: info.streamId } }
      : false,
    video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: info.streamId } }
  };
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch {
    setStatus("Could not start tab capture. Try again from the popup.", true);
    return;
  }
  video.srcObject = stream;
  try {
    await video.play();
  } catch { return; }
  attachEndedHandler();
  pipBtn.disabled = false;
  if (wantAudio && stream.getAudioTracks().length) {
    soundBtn.disabled = false;
    setStatus("Live tab preview. Click Enable sound for audio.");
    void enableAudio();
  } else {
    setStatus("Live tab preview.");
  }
})();

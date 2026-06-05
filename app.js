// ═══════════════════════════════════════════════════════════════════
//  Auth module — runs before anything else
// ═══════════════════════════════════════════════════════════════════

let authSession = null;

function showModal(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = false;
}

function hideModal(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}

async function initAuth() {
  try {
    const res = await fetch("/api/auth/status");
    const data = await res.json();
    if (data.authenticated) {
      authSession = data;
      hideModal("loginOverlay");
      if (data.role === "user" && (data.usesLeft ?? 1) <= 0) {
        showModal("paywallOverlay");
      }
    } else {
      showModal("loginOverlay");
    }
  } catch {
    showModal("loginOverlay");
  }
}

// ── Login form handler ──────────────────────────────────────────────

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const emailInput = document.getElementById("loginEmail");
  const passwordInput = document.getElementById("adminPassword");
  const passwordRow = document.getElementById("adminPasswordRow");
  const msg = document.getElementById("loginMessage");
  const btn = document.getElementById("loginBtn");

  const email = emailInput.value.trim();
  if (!email) {
    msg.className = "modal-message error";
    msg.textContent = "Please enter your email address.";
    return;
  }

  btn.disabled = true;
  msg.className = "modal-message";
  msg.textContent = "Checking…";

  const body = { email };
  if (!passwordRow.hidden) body.password = passwordInput.value;

  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json();

    if (!res.ok) {
      msg.className = "modal-message error";
      msg.textContent = data.error || "Something went wrong. Try again.";
      btn.disabled = false;
      return;
    }

    if (data.requiresPassword) {
      passwordRow.hidden = false;
      msg.className = "modal-message";
      msg.textContent = "Enter the admin password to continue.";
      passwordInput.focus();
      btn.disabled = false;
      return;
    }

    if (data.status === "pending") {
      msg.className = "modal-message";
      msg.textContent = "Your access request is pending approval. Check back soon.";
      btn.disabled = false;
      return;
    }

    if (data.ok) {
      authSession = {
        authenticated: true,
        email,
        role: data.role,
        usesLeft: data.usesLeft ?? null
      };
      hideModal("loginOverlay");
      if (data.role === "user" && (data.usesLeft ?? 1) <= 0) {
        showModal("paywallOverlay");
      }
    }
  } catch {
    msg.className = "modal-message error";
    msg.textContent = "Network error. Check your connection and try again.";
    btn.disabled = false;
  }
});

// ── Contact / paywall form handler ─────────────────────────────────

document.getElementById("contactForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("contactFeedback");
  const btn = document.getElementById("contactBtn");

  const name = document.getElementById("contactName").value.trim();
  const phone = document.getElementById("contactPhone").value.trim();
  const message = document.getElementById("contactMsg").value.trim();

  if (!name) {
    msg.className = "modal-message error";
    msg.textContent = "Please enter your name.";
    return;
  }
  if (!message) {
    msg.className = "modal-message error";
    msg.textContent = "Please describe your use case.";
    return;
  }

  btn.disabled = true;
  msg.className = "modal-message";
  msg.textContent = "Sending…";

  try {
    const res = await fetch("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, phone, message })
    });
    const data = await res.json();

    if (!res.ok) {
      msg.className = "modal-message error";
      msg.textContent = data.error || "Could not send. Please try again.";
      btn.disabled = false;
      return;
    }

    msg.className = "modal-message success";
    msg.textContent = "Request sent! We'll be in touch soon.";
    document.getElementById("contactForm")
      .querySelectorAll("input, textarea, button")
      .forEach((el) => { el.disabled = true; });
  } catch {
    msg.className = "modal-message error";
    msg.textContent = "Network error. Please try again.";
    btn.disabled = false;
  }
});

// ═══════════════════════════════════════════════════════════════════
//  Main app
// ═══════════════════════════════════════════════════════════════════

const form = document.querySelector("#transcriptForm");
const input = document.querySelector("#videoUrl");
const output = document.querySelector("#transcriptOutput");
const statusEl = document.querySelector("#status");
const platformEl = document.querySelector("#detectedPlatform");
const progress = document.querySelector("#progress");
const format = document.querySelector("#format");
const language = document.querySelector("#language");
const timestamps = document.querySelector("#timestamps");
const cleanFillers = document.querySelector("#cleanFillers");
const speakerSeparation = document.querySelector("#speakerSeparation");
const copyBtn = document.querySelector("#copyBtn");
const downloadBtn = document.querySelector("#downloadBtn");
const mediaFile = document.querySelector("#mediaFile");
const mediaPreview = document.querySelector("#mediaPreview");
const mediaTitle = document.querySelector("#mediaTitle");
const mediaAccount = document.querySelector("#mediaAccount");
const mediaDescription = document.querySelector("#mediaDescription");
const mediaViews = document.querySelector("#mediaViews");
const mediaLikes = document.querySelector("#mediaLikes");
const mediaComments = document.querySelector("#mediaComments");
const mediaDuration = document.querySelector("#mediaDuration");
const mediaAccountId = document.querySelector("#mediaAccountId");
const mediaId = document.querySelector("#mediaId");
const sourceLink = document.querySelector("#sourceLink");
const processNote = document.querySelector("#processNote");

let transcriptText = "";
let transcriptSegments = [];
let mediaInfo = null;
let timerId = null;

function detectSource(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_error) {
    return "media link";
  }
}

function formatClock(seconds, separator = ",") {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = Math.floor(safeSeconds % 60);
  const millis = Math.round((safeSeconds - Math.floor(safeSeconds)) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}${separator}${String(millis).padStart(3, "0")}`;
}

function renderTranscript() {
  const selectedFormat = format.value;
  const includeTime = timestamps.checked;
  const segments = transcriptSegments.length ? transcriptSegments : [{ start: 0, end: 0, text: transcriptText }];
  const lines = segments.map((segment, index) => {
    const text = cleanFillers.checked ? segment.text.replace(/\b(um|uh|like)\b/gi, "").replace(/\s+/g, " ").trim() : segment.text;
    const speaker = segment.speaker ? `${segment.speaker}: ` : "";

    if (selectedFormat === "srt") {
      return `${index + 1}\n${formatClock(segment.start)} --> ${formatClock(segment.end)}\n${speaker}${text}`;
    }

    if (selectedFormat === "vtt") {
      const cue = `${formatClock(segment.start, ".")} --> ${formatClock(segment.end, ".")}\n${speaker}${text}`;
      return index === 0 ? `WEBVTT\n\n${cue}` : cue;
    }

    if (includeTime && transcriptSegments.length) return `${formatClock(segment.start).slice(3, 8)} ${speaker}${text}`;
    return `${speaker}${text}`;
  });

  return lines.join(selectedFormat === "txt" ? "\n" : "\n\n");
}

function setBusy(isBusy) {
  progress.hidden = !isBusy;
  processNote.hidden = !isBusy;
  statusEl.textContent = isBusy ? "Processing" : "Ready";
  if (!isBusy && timerId) {
    clearInterval(timerId);
    timerId = null;
  }
}

function formatShortTime(seconds) {
  const safeSeconds = Math.max(0, Math.round(seconds || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remaining = safeSeconds % 60;
  if (minutes <= 0) return `${remaining}s`;
  return `${minutes}m ${String(remaining).padStart(2, "0")}s`;
}

function estimateSeconds(durationSeconds = 0) {
  const duration = Number(durationSeconds || 0);
  if (!duration) return 60;
  return Math.max(25, Math.round(duration * 0.7 + 20));
}

function startTimer(message, durationSeconds = 0) {
  if (timerId) clearInterval(timerId);
  const startedAt = Date.now();
  const estimate = estimateSeconds(durationSeconds);

  function tick() {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const remaining = Math.max(0, estimate - elapsed);
    if (remaining === 0) {
      processNote.textContent = `${message} Elapsed ${formatShortTime(elapsed)}. Finishing up, this can take longer than estimated.`;
      return;
    }
    processNote.textContent = `${message} Elapsed ${formatShortTime(elapsed)}. Estimated remaining ${formatShortTime(remaining)}.`;
  }

  tick();
  timerId = setInterval(tick, 1000);
}

function setWaitingTranscript(message) {
  transcriptText = "";
  transcriptSegments = [];
  output.dir = "ltr";
  output.value = message;
}

function isMostlyRtl(text) {
  const rtlMatches = text.match(/[\u0591-\u07ff\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/g) || [];
  return rtlMatches.length > Math.max(4, text.length * 0.15);
}

function trimDescription(text) {
  if (!text) return "No description available.";
  return text.length > 420 ? `${text.slice(0, 420).trim()}...` : text;
}

function compactFileName(name, maxLength = 34) {
  if (!name || name.length <= maxLength) return name || "uploaded file";
  const extensionIndex = name.lastIndexOf(".");
  const extension = extensionIndex > 0 ? name.slice(extensionIndex) : "";
  const base = extension ? name.slice(0, extensionIndex) : name;
  const keep = Math.max(10, maxLength - extension.length - 3);
  return `${base.slice(0, keep)}...${extension}`;
}

function readLocalVideoMetadata(file) {
  return new Promise((resolve) => {
    if (!file.type.startsWith("video/")) {
      resolve({ width: 0, height: 0, durationSeconds: 0, duration: "-" });
      return;
    }

    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const durationSeconds = Number.isFinite(video.duration) ? video.duration : 0;
      URL.revokeObjectURL(video.src);
      resolve({
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        durationSeconds,
        duration: durationSeconds ? formatShortTime(durationSeconds) : "-"
      });
    };
    video.onerror = () => {
      URL.revokeObjectURL(video.src);
      resolve({ width: 0, height: 0, durationSeconds: 0, duration: "-" });
    };
    video.src = URL.createObjectURL(file);
  });
}

function updateDownloadLabel() {
  downloadBtn.textContent = `Export ${format.value.toUpperCase()}`;
}

function updateMediaInfo(info = {}) {
  mediaInfo = info;
  mediaTitle.textContent = info.title || "Untitled media";
  mediaAccount.textContent = info.accountId && info.accountId !== "-" ? `@${info.accountId}` : info.account || "Unknown account";
  mediaDescription.textContent = trimDescription(info.description);
  mediaViews.textContent = info.views || "-";
  mediaLikes.textContent = info.likes || "-";
  mediaComments.textContent = info.comments || "-";
  mediaDuration.textContent = info.duration || "-";
  mediaAccountId.textContent = info.accountId || "-";
  mediaId.textContent = info.id || "-";

  sourceLink.hidden = !info.pageUrl;
  if (info.pageUrl) sourceLink.href = info.pageUrl;

  mediaPreview.innerHTML = "";
  mediaPreview.classList.remove("portrait", "square");
  const ratio = Number(info.aspectRatio || (info.width && info.height ? info.width / info.height : 0));
  if (ratio && ratio < 0.8) {
    mediaPreview.classList.add("portrait");
  } else if (ratio && ratio >= 0.8 && ratio <= 1.25) {
    mediaPreview.classList.add("square");
  }

  if (info.mediaUrl) {
    if (info.thumbnail) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "poster-button";
      button.setAttribute("aria-label", "Play video preview");
      const image = document.createElement("img");
      image.src = info.thumbnail;
      image.alt = info.title || "Media thumbnail";
      button.append(image);
      button.addEventListener("click", () => {
        const video = document.createElement("video");
        video.src = info.mediaUrl;
        video.poster = info.thumbnail;
        video.controls = true;
        video.playsInline = true;
        video.autoplay = true;
        mediaPreview.innerHTML = "";
        mediaPreview.append(video);
        video.play().catch(() => {});
      });
      mediaPreview.append(button);
      return;
    }
    const video = document.createElement("video");
    video.src = info.mediaUrl;
    video.controls = true;
    video.playsInline = true;
    mediaPreview.append(video);
    return;
  }
  if (info.thumbnail) {
    const image = document.createElement("img");
    image.src = info.thumbnail;
    image.alt = info.title || "Media thumbnail";
    mediaPreview.append(image);
    return;
  }
  const fallback = document.createElement("span");
  fallback.textContent = "Preview unavailable";
  mediaPreview.append(fallback);
}

function updateTranscript(payload, sourceLabel) {
  transcriptText = payload.text || "";
  transcriptSegments = Array.isArray(payload.segments) ? payload.segments : [];
  output.value = renderTranscript();
  output.dir = isMostlyRtl(output.value) ? "rtl" : "ltr";
  platformEl.textContent = sourceLabel;
  statusEl.textContent = "Complete";
}

async function generateTranscript(event) {
  event.preventDefault();
  if (!input.value.trim()) return;

  setBusy(true);
  const url = input.value.trim();
  platformEl.textContent = `Loading preview from ${detectSource(url)}...`;
  setWaitingTranscript("Loading video preview and information...");
  processNote.textContent = "Loading preview...";
  mediaPreview.classList.add("loading");
  mediaPreview.innerHTML = "<span>Loading preview...</span>";

  try {
    const infoResponse = await fetch("/api/media-info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    const infoPayload = await infoResponse.json();
    if (!infoResponse.ok) throw new Error(infoPayload.error || "Preview failed.");

    updateMediaInfo(infoPayload.info);
    mediaPreview.classList.remove("loading");
    platformEl.textContent = `Preview loaded from ${detectSource(url)}`;
    setWaitingTranscript("Preview loaded. Transcription is running now...");
    startTimer(speakerSeparation.checked ? "Separating speakers with OpenAI." : "Transcribing with OpenAI.", infoPayload.info?.durationSeconds);

    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, language: language.value, speed: "accurate", diarize: speakerSeparation.checked })
    });
    const payload = await response.json();
    if (response.status === 401) { showModal("loginOverlay"); return; }
    if (response.status === 402) { showModal("paywallOverlay"); return; }
    if (!response.ok) throw new Error(payload.error || "Transcription failed.");

    updateMediaInfo(payload.info || infoPayload.info);
    updateTranscript(payload, `Transcript from ${detectSource(url)}`);
    processNote.textContent = "Transcription complete.";
    document.querySelector("#toolPanel").scrollIntoView({ behavior: "smooth", block: "start" });

    if (authSession?.role === "user") {
      authSession.usesLeft = Math.max(0, (authSession.usesLeft ?? 1) - 1);
      if (authSession.usesLeft <= 0) {
        setTimeout(() => showModal("paywallOverlay"), 900);
      }
    }
  } catch (error) {
    mediaPreview.classList.remove("loading");
    platformEl.textContent = "Transcription failed";
    output.value = error.message;
    statusEl.textContent = "Error";
  } finally {
    setBusy(false);
  }
}

async function generateUploadTranscript() {
  if (!mediaFile.files?.length) return;

  setBusy(true);
  const file = mediaFile.files[0];
  platformEl.textContent = `Uploading ${compactFileName(file.name)}...`;
  output.value = "";

  const localUrl = URL.createObjectURL(file);
  const localMeta = await readLocalVideoMetadata(file);
  startTimer("Transcribing uploaded file.", localMeta.durationSeconds);
  updateMediaInfo({
    title: file.name,
    description: "Uploaded local file",
    account: "Local upload",
    accountId: "-",
    id: "-",
    duration: "-",
    durationSeconds: localMeta.durationSeconds,
    duration: localMeta.duration,
    width: localMeta.width,
    height: localMeta.height,
    aspectRatio: localMeta.width && localMeta.height ? localMeta.width / localMeta.height : null,
    views: "-",
    likes: "-",
    comments: "-",
    mediaUrl: file.type.startsWith("video/") || file.type.startsWith("audio/") ? localUrl : "",
    thumbnail: "",
    pageUrl: ""
  });

  try {
    const body = new FormData();
    body.append("media", file);
    body.append("language", language.value);
    body.append("speed", "accurate");
    body.append("diarize", speakerSeparation.checked ? "true" : "false");

    const response = await fetch("/api/transcribe-upload", {
      method: "POST",
      body
    });
    const payload = await response.json();
    if (response.status === 401) { showModal("loginOverlay"); return; }
    if (response.status === 402) { showModal("paywallOverlay"); return; }
    if (!response.ok) throw new Error(payload.error || "Transcription failed.");

    updateMediaInfo(payload.info);
    updateTranscript(payload, "Uploaded media transcript");
    processNote.textContent = "Transcription complete.";
    document.querySelector("#toolPanel").scrollIntoView({ behavior: "smooth", block: "start" });

    if (authSession?.role === "user") {
      authSession.usesLeft = Math.max(0, (authSession.usesLeft ?? 1) - 1);
      if (authSession.usesLeft <= 0) {
        setTimeout(() => showModal("paywallOverlay"), 900);
      }
    }
  } catch (error) {
    platformEl.textContent = "Transcription failed";
    output.value = error.message;
    statusEl.textContent = "Error";
  } finally {
    setBusy(false);
    setTimeout(() => URL.revokeObjectURL(localUrl), 1000);
  }
}

function downloadTranscript() {
  const extension = format.value === "txt" ? "txt" : format.value;
  const mime = format.value === "txt" ? "text/plain" : "text/vtt";
  const blob = new Blob([output.value || renderTranscript()], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `voxtext-export.${extension}`;
  link.click();
  URL.revokeObjectURL(url);
}

form.addEventListener("submit", generateTranscript);

format.addEventListener("change", () => {
  updateDownloadLabel();
  if (transcriptText) output.value = renderTranscript();
});

timestamps.addEventListener("change", () => {
  if (transcriptText) output.value = renderTranscript();
});

cleanFillers.addEventListener("change", () => {
  if (transcriptText) output.value = renderTranscript();
});

speakerSeparation.addEventListener("change", () => {
  processNote.hidden = false;
  processNote.textContent = speakerSeparation.checked
    ? "Speaker separation uses OpenAI cloud transcription and requires API billing."
    : "Local transcription mode is active.";
});

copyBtn.addEventListener("click", async () => {
  const text = output.value || "";
  await navigator.clipboard.writeText(text);
  statusEl.textContent = "Copied";
  setTimeout(() => {
    statusEl.textContent = "Ready";
  }, 1400);
});

downloadBtn.addEventListener("click", downloadTranscript);
mediaFile.addEventListener("change", generateUploadTranscript);
updateDownloadLabel();

// Start auth check — shows login modal if not authenticated
initAuth();

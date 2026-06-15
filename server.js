import "dotenv/config";
import express from "express";
import multer from "multer";
import OpenAI from "openai";
import session from "express-session";
import { default as FileStoreFactory } from "session-file-store";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  requireAuth,
  requireAdminSession,
  handleLogin,
  handleAdminApprove,
  handleAdminPending,
  handleAdminReject,
  handleContactSubmit,
  incrementUserUses
} from "./auth.js";

const app = express();
const root = resolve(".");
const tmpRoot = join(root, ".tmp");
const upload = multer({
  dest: join(tmpRoot, "uploads"),
  limits: { fileSize: 25 * 1024 * 1024 }
});

const FileStore = FileStoreFactory(session);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(root));

app.use(session({
  secret: process.env.SESSION_SECRET || "dev-fallback-secret-change-me",
  resave: false,
  saveUninitialized: false,
  store: new FileStore({ path: join(root, ".sessions"), ttl: 7 * 24 * 60 * 60, logFn: () => {} }),
  cookie: { httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

function proxiedUrl(url) {
  return url ? `/api/proxy-image?url=${encodeURIComponent(url)}` : "";
}

function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("Missing OPENAI_API_KEY. Add it to a .env file, then restart the server.");
    error.status = 500;
    throw error;
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function requireApiKey() {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("Missing OPENAI_API_KEY. Add it to a .env file, then restart the server.");
    error.status = 500;
    throw error;
  }
}

const LANGUAGE_CODES = {
  "Arabic": "ar",
  "Chinese": "zh",
  "English": "en",
  "French": "fr",
  "German": "de",
  "Italian": "it",
  "Portuguese": "pt",
  "Spanish": "es"
};

function languageCode(language) {
  if (!language || language === "Auto detect") return undefined;
  return LANGUAGE_CODES[language] || String(language).toLowerCase().slice(0, 2);
}

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolveRun({ stdout, stderr });
        return;
      }
      const error = new Error(stderr || stdout || `${command} exited with code ${code}`);
      error.status = 422;
      reject(error);
    });
  });
}

function transcribeLocally(filePath, language, speed = "balanced") {
  return new Promise((resolveRun, reject) => {
    const args = ["transcribe_local.py", filePath, language || "Auto detect", speed || "balanced"];
    const child = spawn("python", args, { cwd: root, shell: false });
    const timeoutMs = speed === "accurate" ? 12 * 60 * 1000 : 7 * 60 * 1000;
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      const error = new Error("Local transcription took too long. Try Fast mode, a shorter video, or a cloud transcription provider.");
      error.status = 504;
      reject(error);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const error = new Error(stderr || stdout || `Local Whisper exited with code ${code}`);
        error.status = 500;
        reject(error);
        return;
      }

      try {
        resolveRun(JSON.parse(stdout));
      } catch (_error) {
        const error = new Error("Local Whisper finished, but the transcript output could not be read.");
        error.status = 500;
        reject(error);
      }
    });
  });
}

async function downloadVideo(url) {
  const jobDir = join(tmpRoot, randomUUID());
  await mkdir(jobDir, { recursive: true });

  await run("yt-dlp", [
    "--no-playlist",
    "--max-filesize",
    "24M",
    "--format",
    "bestaudio/best",
    "--output",
    "%(id)s.%(ext)s",
    url
  ], jobDir);

  const files = await readdir(jobDir);
  const mediaFile = files.find((file) => !file.endsWith(".part") && !file.endsWith(".ytdl"));
  if (!mediaFile) {
    const error = new Error("The video could not be downloaded. It may be private, blocked, or too large.");
    error.status = 422;
    throw error;
  }

  const filePath = join(jobDir, mediaFile);
  const info = await stat(filePath);
  if (info.size > 25 * 1024 * 1024) {
    const error = new Error("The downloaded media is larger than 25MB. Try a shorter video or install ffmpeg so the server can compress audio.");
    error.status = 413;
    throw error;
  }

  return { filePath, jobDir };
}

function compactNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value));
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return "-";
  const total = Math.round(Number(seconds));
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

function normalizeMediaInfo(info, sourceUrl) {
  return {
    id: info.id || "-",
    title: info.title || info.fulltitle || "Untitled media",
    description: info.description || "",
    account: info.uploader || info.channel || info.uploader_id || "Unknown account",
    accountId: info.uploader_id || info.channel_id || info.channel || "-",
    duration: formatDuration(info.duration),
    durationSeconds: Number(info.duration || 0),
    width: Number(info.width || 0),
    height: Number(info.height || 0),
    aspectRatio: info.width && info.height ? Number(info.width) / Number(info.height) : null,
    views: compactNumber(info.view_count),
    likes: compactNumber(info.like_count),
    comments: compactNumber(info.comment_count),
    thumbnail: proxiedUrl(info.thumbnail || info.thumbnails?.at?.(-1)?.url || ""),
    mediaUrl: info.url || "",
    pageUrl: info.webpage_url || sourceUrl
  };
}

async function getMediaInfo(url) {
  try {
    const { stdout } = await run("yt-dlp", [
      "--no-playlist",
      "--skip-download",
      "--dump-single-json",
      "--no-write-comments",
      url
    ], root);
    return normalizeMediaInfo(JSON.parse(stdout), url);
  } catch (_error) {
    return normalizeMediaInfo({ webpage_url: url }, url);
  }
}

function formatSegments(transcription) {
  if (!Array.isArray(transcription.segments)) return [];
  return transcription.segments.map((segment) => ({
    start: Number(segment.start || 0),
    end: Number(segment.end || 0),
    text: String(segment.text || "").trim(),
    speaker: segment.speaker ? `Speaker ${segment.speaker}` : undefined
  }));
}

async function transcribeFile(filePath, language, speed, diarize = false) {
  if (diarize) {
    requireApiKey();
    const client = getClient();
    const request = {
      file: createReadStream(filePath),
      model: process.env.DIARIZATION_MODEL || "gpt-4o-transcribe-diarize",
      response_format: "diarized_json",
      chunking_strategy: "auto"
    };
    const code = languageCode(language);
    if (code) request.language = code;
    const transcription = await client.audio.transcriptions.create(request);
    return {
      text: transcription.text || "",
      segments: formatSegments(transcription),
      diarized: true
    };
  }

  if ((process.env.TRANSCRIPTION_PROVIDER || "local").toLowerCase() === "local") {
    const result = await transcribeLocally(filePath, language, speed);
    const hallucinatedPrompt = /transcribe only the spoken english words/i.test(result.text || "");
    if (language === "English" && hallucinatedPrompt) {
      return transcribeLocally(filePath, "Auto detect", speed);
    }
    return result;
  }

  const client = getClient();
  const request = {
    file: createReadStream(filePath),
    model: process.env.TRANSCRIPTION_MODEL || "gpt-4o-transcribe",
    response_format: "json"
  };

  const code = languageCode(language);
  if (code) request.language = code;

  const transcription = await client.audio.transcriptions.create(request);
  return {
    text: transcription.text || "",
    segments: formatSegments(transcription)
  };
}

// ─── Auth routes ─────────────────────────────────────────────────────────────

app.get("/api/auth/status", (req, res) => {
  if (!req.session || !req.session.email) {
    return res.json({ authenticated: false });
  }
  res.json({
    authenticated: true,
    email: req.session.email,
    role: req.session.role,
    usesLeft: req.session.usesLeft
  });
});

app.post("/api/auth/login", handleLogin);

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ─── Admin routes ─────────────────────────────────────────────────────────────

app.post("/api/admin/approve", requireAdminSession, handleAdminApprove);
app.post("/api/admin/reject", requireAdminSession, handleAdminReject);
app.get("/api/admin/pending", requireAdminSession, handleAdminPending);

// ─── Contact / paywall form ───────────────────────────────────────────────────

app.post("/api/contact", handleContactSubmit);

// ─── Transcription routes (auth-gated) ───────────────────────────────────────

app.post("/api/transcribe", requireAuth, async (req, res, next) => {
  let jobDir;
  let succeeded = false;
  try {
    const { url, language, speed, diarize } = req.body;
    if (!url || typeof url !== "string") {
      const error = new Error("Paste a public video URL first.");
      error.status = 400;
      throw error;
    }
    const wantsDiarization = diarize === true || diarize === "true";
    if (wantsDiarization || (process.env.TRANSCRIPTION_PROVIDER || "local").toLowerCase() !== "local") {
      requireApiKey();
    }

    const mediaInfo = await getMediaInfo(url);
    const downloaded = await downloadVideo(url);
    jobDir = downloaded.jobDir;
    const result = await transcribeFile(downloaded.filePath, language, speed, wantsDiarization);
    result.info = mediaInfo;
    res.json(result);
    succeeded = true;
  } catch (error) {
    next(error);
  } finally {
    if (succeeded && req.session?.role === "user") {
      const used = await incrementUserUses(req.session.email);
      if (used && !used.unlimited) {
        req.session.usesLeft = Math.max(0, (used.trialLimit ?? 3) - (used.trialsUsed ?? 0));
      } else {
        req.session.usesLeft = Math.max(0, (req.session.usesLeft ?? 1) - 1);
      }
    }
    if (jobDir) {
      await rm(jobDir, { recursive: true, force: true });
    }
  }
});

app.post("/api/media-info", async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== "string") {
      const error = new Error("Paste a public video URL first.");
      error.status = 400;
      throw error;
    }
    const info = await getMediaInfo(url);
    res.json({ info });
  } catch (error) {
    next(error);
  }
});

app.get("/api/proxy-image", async (req, res, next) => {
  try {
    const imageUrl = String(req.query.url || "");
    if (!/^https?:\/\//i.test(imageUrl)) {
      const error = new Error("Invalid image URL.");
      error.status = 400;
      throw error;
    }

    const response = await fetch(imageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Referer": "https://www.instagram.com/"
      }
    });

    if (!response.ok) {
      const error = new Error("Thumbnail could not be loaded.");
      error.status = response.status;
      throw error;
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=300");
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (error) {
    next(error);
  }
});

app.post("/api/transcribe-upload", requireAuth, upload.single("media"), async (req, res, next) => {
  let succeeded = false;
  try {
    if (!req.file) {
      const error = new Error("Choose a video or audio file first.");
      error.status = 400;
      throw error;
    }
    if ((process.env.TRANSCRIPTION_PROVIDER || "local").toLowerCase() !== "local") {
      requireApiKey();
    }
    const allowed = new Set([".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm"]);
    if (!allowed.has(extname(req.file.originalname).toLowerCase())) {
      const error = new Error("Use MP3, MP4, MPEG, MPGA, M4A, WAV, or WEBM media.");
      error.status = 400;
      throw error;
    }
    const wantsDiarization = req.body.diarize === "true" || req.body.diarize === true;
    if (wantsDiarization) requireApiKey();
    const result = await transcribeFile(req.file.path, req.body.language, req.body.speed, wantsDiarization);
    result.info = {
      id: "-",
      title: req.file.originalname,
      description: "Uploaded local file",
      account: "Local upload",
      accountId: "-",
      duration: "-",
      durationSeconds: 0,
      width: 0,
      height: 0,
      aspectRatio: null,
      views: "-",
      likes: "-",
      comments: "-",
      thumbnail: "",
      mediaUrl: "",
      pageUrl: ""
    };
    res.json(result);
    succeeded = true;
  } catch (error) {
    next(error);
  } finally {
    if (succeeded && req.session?.role === "user") {
      const used = await incrementUserUses(req.session.email);
      if (used && !used.unlimited) {
        req.session.usesLeft = Math.max(0, (used.trialLimit ?? 3) - (used.trialsUsed ?? 0));
      } else {
        req.session.usesLeft = Math.max(0, (req.session.usesLeft ?? 1) - 1);
      }
    }
    if (req.file?.path) {
      await rm(req.file.path, { force: true });
    }
  }
});

app.use((error, _req, res, _next) => {
  let message = error.message || "Transcription failed.";
  if (error.status === 401 || /api key/i.test(message)) {
    message = "OpenAI rejected the API key. Check that the key is active, copied correctly, and has billing enabled.";
  } else if (error.status === 429 || /quota|billing|plan/i.test(message)) {
    message = "The cloud transcription provider has no available quota. Switch to local mode or add provider billing.";
  }

  res.status(error.status || 500).json({
    error: message
  });
});

const port = Number(process.env.PORT || 4174);
await mkdir(join(tmpRoot, "uploads"), { recursive: true });
app.listen(port, "0.0.0.0", () => {
  console.log(`VoxText Studio running at http://0.0.0.0:${port}`);
});

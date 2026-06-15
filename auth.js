/*
 * tool4 auth — backed by the Creativity Solutions Google Sheet.
 *
 * The Sheet (via the Apps Script web app) is the single source of truth for
 * who is approved, their role (user | staff), trial usage, and payment state.
 * This module never stores users locally; it just calls the Sheet API.
 *
 * Required env:
 *   SHEET_API_URL      — the Apps Script /exec URL (same as the website's apiUrl)
 *   SHEET_SERVER_SECRET — matches the Apps Script Script Property SERVER_SECRET
 *   ADMIN_EMAILS       — comma-separated owner emails (full access in the tool)
 *   ADMIN_PASSWORD     — shared password those admins type after their email
 */

const TRIAL_LIMIT = 3;

const SHEET_API_URL = process.env.SHEET_API_URL || "";
const SHEET_SERVER_SECRET = process.env.SHEET_SERVER_SECRET || "";

// ─── Sheet API client ──────────────────────────────────────────────────────

async function sheetApi(action, body = {}) {
  if (!SHEET_API_URL) {
    const error = new Error("Access service is not configured (missing SHEET_API_URL).");
    error.status = 500;
    throw error;
  }
  let res;
  try {
    res = await fetch(SHEET_API_URL, {
      method: "POST",
      // text/plain avoids an Apps Script CORS preflight; the body is still JSON.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, ...body })
    });
  } catch (err) {
    const error = new Error("Could not reach the access service. Try again shortly.");
    error.status = 502;
    throw error;
  }
  if (!res.ok) {
    const error = new Error("The access service returned an error.");
    error.status = 502;
    throw error;
  }
  const data = await res.json();
  if (data && data.error) {
    const error = new Error(data.error);
    error.status = data.error === "forbidden" ? 403 : 400;
    throw error;
  }
  return data;
}

// ─── Admin helpers ────────────────────────────────────────────────────────

function getAdminEmails() {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function isAdmin(email) {
  return getAdminEmails().includes(email.toLowerCase());
}

function usesLeftFor(record) {
  // Staff and paid users are unlimited (null = no cap).
  if (record.role === "staff" || record.paid === "yes") return null;
  const limit = Number(record.trialLimit || TRIAL_LIMIT);
  return Math.max(0, limit - Number(record.trialsUsed || 0));
}

// ─── Exported middleware ─────────────────────────────────────────────────────

export function requireAuth(req, res, next) {
  if (!req.session || !req.session.email) {
    return res.status(401).json({ error: "Please log in first.", code: "UNAUTHENTICATED" });
  }
  if (req.session.role === "user" && (req.session.usesLeft ?? 0) <= 0) {
    return res.status(402).json({ error: "Trial limit reached. Fill out the form to request extended access.", code: "LIMIT_REACHED" });
  }
  next();
}

export function requireAdminSession(req, res, next) {
  if (!req.session || req.session.role !== "admin") {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

// ─── Route handlers ───────────────────────────────────────────────────────

export async function handleLogin(req, res, next) {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  // ── Admin path (tool owners — full unlimited access) ──
  if (isAdmin(email)) {
    if (!password) return res.json({ requiresPassword: true });
    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ error: "Incorrect admin password." });
    }
    req.session.email = email;
    req.session.role = "admin";
    req.session.usesLeft = null;
    return res.json({ ok: true, role: "admin" });
  }

  // ── Everyone else: ask the Sheet ──
  try {
    let record = await sheetApi("check", { email });

    if (record.status === "unknown") {
      // First time here: register them as pending so an admin can approve.
      await sheetApi("request", { email });
      return res.json({ status: "pending" });
    }
    if (record.status === "pending") {
      return res.json({ status: "pending" });
    }
    if (record.status === "rejected") {
      return res.status(403).json({ error: "Access denied." });
    }
    if (record.status === "approved") {
      const usesLeft = usesLeftFor(record);
      req.session.email = email;
      req.session.role = record.role === "staff" ? "staff" : "user";
      req.session.usesLeft = usesLeft;
      return res.json({ ok: true, role: req.session.role, usesLeft });
    }
    return res.status(403).json({ error: "Access denied." });
  } catch (error) {
    return next(error);
  }
}

export async function handleAdminApprove(req, res, next) {
  const email = (req.body.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "Email required." });
  try {
    await sheetApi("approve", { email, secret: SHEET_SERVER_SECRET });
    res.json({ ok: true, email });
  } catch (error) {
    next(error);
  }
}

export async function handleAdminReject(req, res, next) {
  const email = (req.body.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "Email required." });
  try {
    await sheetApi("reject", { email, secret: SHEET_SERVER_SECRET });
    res.json({ ok: true, email });
  } catch (error) {
    next(error);
  }
}

export async function handleAdminPending(req, res, next) {
  try {
    const data = await sheetApi("list", { secret: SHEET_SERVER_SECRET });
    const pending = (data.items || [])
      .filter((it) => it.status === "pending")
      .map((it) => ({ email: it.email, requestedAt: it.createdAt }));
    res.json({ pending });
  } catch (error) {
    next(error);
  }
}

export async function handleContactSubmit(req, res, next) {
  const { name, phone, message } = req.body || {};
  const email = req.session?.email || (req.body?.email || "").trim().toLowerCase();

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "Name is required." });
  }
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: "Message is required." });
  }
  if (!email) {
    return res.status(400).json({ error: "Email is required." });
  }

  try {
    await sheetApi("contact", {
      secret: SHEET_SERVER_SECRET,
      email,
      name: String(name).trim(),
      phone: String(phone || "").trim(),
      message: String(message).trim()
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
}

// Called after a successful transcription for normal users. Returns the
// updated trial state so the caller can refresh the session's usesLeft.
export async function incrementUserUses(email) {
  if (!email) return null;
  try {
    return await sheetApi("consume", { email, secret: SHEET_SERVER_SECRET });
  } catch (error) {
    console.error("[Auth] consume failed:", error.message);
    return null;
  }
}

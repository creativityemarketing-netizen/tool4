import nodemailer from "nodemailer";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const root = resolve(".");
const dataDir = join(root, "data");
const usersFile = join(dataDir, "users.json");
const contactsFile = join(dataDir, "contacts.json");
const requestsCsv = join(dataDir, "requests.csv");

// Ensure data/ exists on startup
await mkdir(dataDir, { recursive: true });

// ─── Data helpers ────────────────────────────────────────────────────────────

async function readUsers() {
  try {
    return JSON.parse(await readFile(usersFile, "utf8"));
  } catch {
    return {};
  }
}

async function writeUsers(data) {
  await writeFile(usersFile, JSON.stringify(data, null, 2), "utf8");
}

async function readContacts() {
  try {
    return JSON.parse(await readFile(contactsFile, "utf8"));
  } catch {
    return [];
  }
}

async function writeContacts(data) {
  await writeFile(contactsFile, JSON.stringify(data, null, 2), "utf8");
}

async function appendRequestCsv(email) {
  try {
    // Write CSV header if file is new
    let needsHeader = false;
    try {
      await readFile(requestsCsv, "utf8");
    } catch {
      needsHeader = true;
    }
    const line = `${needsHeader ? "email,requestedAt\n" : ""}${email},${new Date().toISOString()}\n`;
    await appendFile(requestsCsv, line, "utf8");
  } catch (err) {
    console.error("[Auth] Could not write requests.csv:", err.message);
  }
}

// ─── Admin helpers ────────────────────────────────────────────────────────────

function getAdminEmails() {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function isAdmin(email) {
  return getAdminEmails().includes(email.toLowerCase());
}

// ─── Nodemailer ───────────────────────────────────────────────────────────────

function createTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}

export async function sendOwnerNotification(newUserEmail) {
  const transport = createTransport();
  const ownerEmail = process.env.OWNER_EMAIL;

  // Always write to CSV
  await appendRequestCsv(newUserEmail);

  if (!transport || !ownerEmail) {
    console.log(`[Auth] New pending user (no SMTP configured): ${newUserEmail}`);
    return;
  }

  await transport.sendMail({
    from: `"VoxText Studio" <${process.env.SMTP_USER}>`,
    to: ownerEmail,
    subject: "VoxText Studio: New access request",
    text: [
      `${newUserEmail} has requested access to VoxText Studio.`,
      ``,
      `To approve them, open your browser console while logged in as admin and run:`,
      ``,
      `fetch("/api/admin/approve", {`,
      `  method: "POST",`,
      `  headers: { "Content-Type": "application/json" },`,
      `  body: JSON.stringify({ email: "${newUserEmail}" })`,
      `}).then(r => r.json()).then(console.log)`,
      ``,
      `Or use the /api/admin/pending endpoint to see all pending requests.`
    ].join("\n")
  });
}

export async function sendContactNotification(contact) {
  const transport = createTransport();
  const ownerEmail = process.env.OWNER_EMAIL;

  if (!transport || !ownerEmail) {
    console.log(`[Auth] Contact form submission (no SMTP configured): ${JSON.stringify(contact)}`);
    return;
  }

  await transport.sendMail({
    from: `"VoxText Studio" <${process.env.SMTP_USER}>`,
    to: ownerEmail,
    subject: "VoxText Studio: Trial upgrade request",
    text: [
      `A user has submitted an upgrade request after reaching their trial limit.`,
      ``,
      `Name:    ${contact.name}`,
      `Phone:   ${contact.phone || "—"}`,
      `Email:   ${contact.email || "—"}`,
      `Message: ${contact.message}`
    ].join("\n")
  });
}

// ─── Exported middleware ───────────────────────────────────────────────────────

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

// ─── Route handlers ───────────────────────────────────────────────────────────

export async function handleLogin(req, res) {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  // ── Admin path ──
  if (isAdmin(email)) {
    if (!password) {
      // Tell frontend to show the password field
      return res.json({ requiresPassword: true });
    }
    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ error: "Incorrect admin password." });
    }
    req.session.email = email;
    req.session.role = "admin";
    req.session.usesLeft = null; // unlimited
    return res.json({ ok: true, role: "admin" });
  }

  // ── Regular user path ──
  const users = await readUsers();
  const record = users[email];

  if (!record) {
    // Unknown user: add as pending and notify owner
    users[email] = {
      status: "pending",
      uses: 0,
      requestedAt: new Date().toISOString(),
      approvedAt: null
    };
    await writeUsers(users);
    sendOwnerNotification(email).catch(console.error);
    return res.json({ status: "pending" });
  }

  if (record.status === "pending") {
    return res.json({ status: "pending" });
  }

  if (record.status === "approved") {
    const usesLeft = Math.max(0, 2 - (record.uses || 0));
    req.session.email = email;
    req.session.role = "user";
    req.session.usesLeft = usesLeft;
    return res.json({ ok: true, role: "user", usesLeft });
  }

  return res.status(403).json({ error: "Access denied." });
}

export async function handleAdminApprove(req, res) {
  const email = (req.body.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "Email required." });

  const users = await readUsers();
  if (!users[email]) {
    // Allow approving an email that hasn't requested yet (pre-approve)
    users[email] = {
      status: "approved",
      uses: 0,
      requestedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString()
    };
  } else {
    users[email].status = "approved";
    users[email].approvedAt = new Date().toISOString();
  }
  await writeUsers(users);
  res.json({ ok: true, email });
}

export async function handleAdminPending(req, res) {
  const users = await readUsers();
  const pending = Object.entries(users)
    .filter(([, v]) => v.status === "pending")
    .map(([email, v]) => ({ email, requestedAt: v.requestedAt }))
    .sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
  res.json({ pending });
}

export async function handleContactSubmit(req, res) {
  const { name, phone, message } = req.body || {};
  const email = req.session?.email || (req.body?.email || "").trim().toLowerCase();

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "Name is required." });
  }
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: "Message is required." });
  }

  const contacts = await readContacts();
  const entry = {
    id: randomUUID(),
    email: email || "—",
    name: String(name).trim(),
    phone: String(phone || "").trim(),
    message: String(message).trim(),
    submittedAt: new Date().toISOString()
  };
  contacts.push(entry);
  await writeContacts(contacts);
  sendContactNotification(entry).catch(console.error);
  res.json({ ok: true });
}

export async function incrementUserUses(email) {
  if (!email) return;
  const users = await readUsers();
  if (users[email]) {
    users[email].uses = (users[email].uses || 0) + 1;
    await writeUsers(users);
  }
}

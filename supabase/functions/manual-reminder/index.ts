// Manual reminder emails (sent only when a person clicks "Send Manual Reminder" in the tracker).
// Independent of the automatic anchor reminders. Gmail SMTP credentials come from Supabase secrets:
//   GMAIL_USER, GMAIL_APP_PASSWORD, and REMINDER_PIN (the passcode the person types in the tracker).
import nodemailer from "npm:nodemailer@6.9.16";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const MAX_RECIPIENTS = 20;
const DAILY_MANUAL_CAP = 50;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }

  // Anyone can reach this function with the public key, so the PIN is the real gate. Fail closed if it is not set.
  const expectedPin = Deno.env.get("REMINDER_PIN");
  if (!expectedPin) {
    return json({ ok: false, error: "Reminders are not set up yet: the REMINDER_PIN secret is missing in Supabase." }, 503);
  }
  if (typeof body.pin !== "string" || !safeEqual(body.pin, expectedPin)) {
    return json({ ok: false, error: "Incorrect reminder PIN." }, 401);
  }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const bidId = typeof body.bid_id === "string" ? body.bid_id : "";
  if (!bidId) return json({ ok: false, error: "Missing bid." }, 400);

  // ── History for one bid (manual and automatic) ──
  if (body.action === "history") {
    const { data, error } = await db
      .from("reminder_log")
      .select("id, kind, recipients, subject, status, error, run_date, created_at")
      .eq("bid_id", bidId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) return json({ ok: false, error: "Could not load history." }, 500);
    return json({ ok: true, history: data });
  }

  // ── Send ──
  const rawRecipients = Array.isArray(body.recipients) ? body.recipients : [];
  const recipients = [...new Set(rawRecipients.map((r) => String(r).trim().toLowerCase()).filter(Boolean))];
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (recipients.length === 0) return json({ ok: false, error: "Enter at least one recipient email address." }, 400);
  if (recipients.length > MAX_RECIPIENTS) return json({ ok: false, error: `Too many recipients (max ${MAX_RECIPIENTS}).` }, 400);
  const bad = recipients.filter((r) => !EMAIL_RE.test(r));
  if (bad.length) return json({ ok: false, error: `Invalid email address: ${bad.join(", ")}` }, 400);
  if (!subject || subject.length > 200) return json({ ok: false, error: "Subject is required (max 200 characters)." }, 400);
  if (!message || message.length > 5000) return json({ ok: false, error: "Message is required (max 5000 characters)." }, 400);

  const { data: bid } = await db.from("bids").select("id, name").eq("id", bidId).maybeSingle();
  if (!bid) return json({ ok: false, error: "That bid no longer exists." }, 404);

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count } = await db
    .from("reminder_log")
    .select("id", { count: "exact", head: true })
    .eq("kind", "manual")
    .gte("created_at", since);
  if ((count ?? 0) >= DAILY_MANUAL_CAP) {
    return json({ ok: false, error: "Daily limit for manual reminders reached. Try again tomorrow." }, 429);
  }

  const log = async (status: "sent" | "failed", error?: string) => {
    const { error: logErr } = await db.from("reminder_log").insert({
      bid_id: bid.id, bid_name: bid.name, kind: "manual", recipients, subject, body: message,
      status, error: error ? error.slice(0, 500) : null,
    });
    return !logErr;
  };

  const user = Deno.env.get("GMAIL_USER");
  const pass = Deno.env.get("GMAIL_APP_PASSWORD");
  if (!user || !pass) {
    await log("failed", "Gmail SMTP secrets are not configured.");
    return json({ ok: false, error: "Email is not set up yet: Gmail SMTP secrets are missing in Supabase." }, 503);
  }

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass },
      connectionTimeout: 15000, socketTimeout: 20000,
    });
    await transporter.sendMail({
      from: `"Prado Power Bid Tracker" <${user}>`,
      to: recipients,
      subject,
      text: message,
      html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${escapeHtml(message)}</div>`,
    });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    await log("failed", msg);
    return json({ ok: false, error: `Sending failed: ${msg}` }, 502);
  }

  const logged = await log("sent");
  return json({
    ok: true,
    message: `Reminder sent to ${recipients.length} recipient${recipients.length === 1 ? "" : "s"}.`,
    warning: logged ? undefined : "The email was sent but could not be saved to the history.",
  });
});

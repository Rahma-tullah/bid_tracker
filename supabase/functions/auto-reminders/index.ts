// Automatic reminder emails to bid anchors. Run once or twice a day by pg_cron; nobody has to open the website.
//
// A bid gets a reminder when ALL of these hold (dates are Africa/Lagos calendar days):
//   - today is after its internal_deadline
//   - its external deadline is a real date that is today or later
//   - it is not Submitted and not Missed
//   - its anchor has an email (anchor_contacts), or the bid is unassigned and a fallback email is set
//   - no reminder was sent within the last `frequency_days` days
// Marking a bid Submitted/Missed, or the external deadline passing, therefore stops its reminders by itself.
//
// Safe to run repeatedly: a database rule allows only one pending/sent automatic reminder per bid per day.
// Body options (testing only): { "dry_run": true, "today": "YYYY-MM-DD" } reports what would be sent and writes nothing.
import nodemailer from "npm:nodemailer@6.9.16";
import { createClient } from "npm:@supabase/supabase-js@2";

const TZ = "Africa/Lagos";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });

const todayLagos = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const utcMs = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const daysBetween = (a: string, b: string) => Math.round((utcMs(b) - utcMs(a)) / 86400000);
const addDays = (iso: string, n: number) => new Date(utcMs(iso) + n * 86400000).toISOString().slice(0, 10);
const longDate = (iso: string) =>
  new Date(utcMs(iso)).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

// SMTP settings come from Supabase secrets (never from the code or the website):
//   required: SMTP_HOST, SMTP_USER, SMTP_PASSWORD
//   optional: SMTP_PORT (default 465, TLS from the start), SMTP_FROM_NAME (default "Bid Tracker Reminder"),
//             SMTP_FROM_EMAIL (default: SMTP_USER)
function smtpConfig() {
  const host = Deno.env.get("SMTP_HOST")?.trim();
  const user = Deno.env.get("SMTP_USER")?.trim();
  const pass = Deno.env.get("SMTP_PASSWORD");
  if (!host || !user || !pass) return null;
  const port = Number(Deno.env.get("SMTP_PORT")) || 465;
  const fromName = (Deno.env.get("SMTP_FROM_NAME") || "Bid Tracker Reminder").replace(/["\r\n<>]/g, "");
  const fromEmail = Deno.env.get("SMTP_FROM_EMAIL")?.trim() || user;
  return {
    from: `"${fromName}" <${fromEmail}>`,
    transport: { host, port, secure: port === 465, auth: { user, pass }, connectionTimeout: 15000, socketTimeout: 20000 },
  };
}

const isUnassigned = (a: string | null) => !a || ["", "-", "—"].includes(a.trim());

function buildEmail(bid: { name: string; client: string | null; anchor: string | null; internal_deadline: string; deadline: string },
                    today: string, frequencyDays: number) {
  const left = daysBetween(today, bid.deadline);
  const remaining = left === 0 ? "due today" : left === 1 ? "1 day left" : `${left} days left`;
  const cadence = frequencyDays === 1 ? "daily" : `every ${frequencyDays} days`;
  const greeting = isUnassigned(bid.anchor) ? "Hello," : `Hello ${bid.anchor},`;
  const subject = `Action needed: internal deadline passed – ${bid.name}`;
  const text =
`${greeting}

The internal deadline for "${bid.name}"${bid.client ? ` (${bid.client})` : ""} was ${longDate(bid.internal_deadline)} and has now passed. This bid has not yet been marked as submitted.

External / main submission deadline: ${longDate(bid.deadline)} (${remaining})

Please complete the outstanding documents and submit before the external deadline. You will receive this reminder ${cadence} until the bid is marked as Submitted or Missed, or the external deadline passes.

Prado Power Bid Tracker`;
  return { subject, text };
}

Deno.serve(async (req: Request) => {
  let opts: Record<string, unknown> = {};
  try { opts = await req.json(); } catch { /* cron sends an empty body */ }
  const dry = opts.dry_run === true;
  const today = dry && typeof opts.today === "string" && DATE_RE.test(opts.today) ? opts.today : todayLagos();

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const summary = { today, dry_run: dry, due: 0, sent: 0, would_send: 0, failed: 0, skipped: 0, not_yet_due: 0, details: [] as unknown[] };

  // A run that crashed mid-send leaves a 'pending' row that would block the day; release stale ones.
  if (!dry) {
    await db.from("reminder_log").update({ status: "failed", error: "Interrupted before completion." })
      .eq("kind", "auto").eq("status", "pending")
      .lt("created_at", new Date(Date.now() - 30 * 60 * 1000).toISOString());
  }

  const { data: settings } = await db.from("reminder_settings").select("*").eq("id", 1).maybeSingle();
  const frequencyDays = settings?.frequency_days ?? 1;
  const maxAttempts = settings?.max_attempts_per_day ?? 3;
  const fallbackEmail: string | null = settings?.fallback_email ?? null;
  const ccEmail: string | null = settings?.cc_email ?? null;

  const { data: contacts } = await db.from("anchor_contacts").select("anchor, email");
  const emailByAnchor = new Map((contacts ?? []).map((c) => [c.anchor.trim().toLowerCase(), c.email]));

  const { data: bids, error: bidsErr } = await db
    .from("bids")
    .select("id, name, client, anchor, deadline, internal_deadline")
    .eq("submitted", false).eq("missed", false)
    .not("internal_deadline", "is", null).lt("internal_deadline", today);
  if (bidsErr) return json({ ...summary, error: "Could not read bids." }, 500);

  // External deadline must be a real date and not yet passed (today itself still counts).
  const due = (bids ?? []).filter((b) => DATE_RE.test(b.deadline ?? "") && b.deadline >= today);
  summary.due = due.length;

  const smtp = smtpConfig();
  if (!dry && due.length && !smtp) {
    return json({ ...summary, error: "SMTP settings are not configured (SMTP_HOST, SMTP_USER, SMTP_PASSWORD)." }, 503);
  }
  const transporter = !dry && smtp ? nodemailer.createTransport(smtp.transport) : null;

  for (const bid of due) {
    const to = isUnassigned(bid.anchor) ? fallbackEmail : emailByAnchor.get(bid.anchor.trim().toLowerCase());
    const { subject, text } = buildEmail(bid, today, frequencyDays);

    // Missing/invalid address: record it once per day so it shows up in the history instead of failing silently.
    if (!to || !EMAIL_RE.test(to)) {
      summary.skipped++;
      summary.details.push({ bid: bid.name, anchor: bid.anchor, result: "skipped: no email address for this anchor" });
      if (!dry) {
        const { count } = await db.from("reminder_log").select("id", { count: "exact", head: true })
          .eq("bid_id", bid.id).eq("kind", "auto").eq("status", "skipped").eq("run_date", today);
        if (!count) {
          await db.from("reminder_log").insert({
            bid_id: bid.id, bid_name: bid.name, kind: "auto", recipients: [], subject, body: text,
            status: "skipped", error: `No email address for anchor "${bid.anchor ?? "—"}".`, run_date: today,
          });
        }
      }
      continue;
    }

    // Frequency: skip if a reminder was already sent within the last `frequency_days` days.
    const { count: recent } = await db.from("reminder_log").select("id", { count: "exact", head: true })
      .eq("bid_id", bid.id).eq("kind", "auto").eq("status", "sent").gt("run_date", addDays(today, -frequencyDays));
    if (recent) { summary.not_yet_due++; continue; }

    // Retry cap: stop after N failed attempts today.
    const { count: failedToday } = await db.from("reminder_log").select("id", { count: "exact", head: true })
      .eq("bid_id", bid.id).eq("kind", "auto").eq("status", "failed").eq("run_date", today);
    if ((failedToday ?? 0) >= maxAttempts) {
      summary.skipped++;
      summary.details.push({ bid: bid.name, result: `skipped: ${maxAttempts} failed attempts today` });
      continue;
    }

    if (dry) {
      summary.would_send++;
      summary.details.push({ bid: bid.name, anchor: bid.anchor, result: "would send", subject, preview: text });
      continue;
    }

    // Claim the slot BEFORE sending. The unique index rejects a second claim for the same bid and day,
    // so overlapping or repeated runs can never double-send.
    const recipients = ccEmail && EMAIL_RE.test(ccEmail) ? [to, ccEmail] : [to];
    const { data: claim, error: claimErr } = await db.from("reminder_log").insert({
      bid_id: bid.id, bid_name: bid.name, kind: "auto", recipients, subject, body: text, status: "pending", run_date: today,
    }).select("id").single();
    if (claimErr) {
      const duplicate = claimErr.code === "23505";
      summary.skipped++;
      summary.details.push({ bid: bid.name, result: duplicate ? "skipped: already handled today" : "skipped: could not record attempt" });
      continue;
    }

    try {
      await transporter!.sendMail({
        from: smtp!.from,
        to,
        cc: recipients.length > 1 ? ccEmail! : undefined,
        subject,
        text,
      });
      await db.from("reminder_log").update({ status: "sent" }).eq("id", claim.id);
      summary.sent++;
      summary.details.push({ bid: bid.name, result: "sent" });
    } catch (e) {
      const msg = String((e as Error).message ?? e).slice(0, 500);
      await db.from("reminder_log").update({ status: "failed", error: msg }).eq("id", claim.id);   // frees the slot for the retry run
      summary.failed++;
      summary.details.push({ bid: bid.name, result: "failed", error: msg });
    }
  }

  return json(summary);
});

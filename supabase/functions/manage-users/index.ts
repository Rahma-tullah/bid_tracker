// Admin-only user management for the Bid Tracker: list people, invite new ones, resend invites, change role, switch access on/off.
// The caller must be signed in AND be an active admin in public.app_users (checked here, with the service role).
// Invites go out through the project's own Auth SMTP settings. Admin accounts can't be created or changed from the website
// (do that with SQL), and nobody can change their own account here.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const ROLES = ["editor", "viewer"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  // ── who is calling? must be a signed-in, active admin ──
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: who, error: whoErr } = await db.auth.getUser(token);
  if (whoErr || !who?.user) return json({ ok: false, error: "Please sign in again." }, 401);
  const { data: me } = await db.from("app_users").select("email, role, active").eq("user_id", who.user.id).maybeSingle();
  if (!me || !me.active || me.role !== "admin") return json({ ok: false, error: "Only an administrator can manage users." }, 403);

  const audit = async (action: string, recordId: string, label: string, note: string, changes: unknown = null) => {
    await db.from("audit_log").insert({
      actor_id: who.user.id, actor_email: me.email, actor_role: "admin", source: "app", action,
      table_name: "app_users", record_id: recordId, record_label: label, note, changes,
    });
  };
  const authUsers = async () => {
    const { data } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    return data?.users ?? [];
  };

  const action = body.action;

  // ── list ──
  if (action === "list") {
    const [users, { data: rows }] = await Promise.all([authUsers(), db.from("app_users").select("user_id, email, full_name, role, active")]);
    const byId = new Map((rows ?? []).map((r) => [r.user_id, r]));
    const list = users.map((u) => {
      const r = byId.get(u.id);
      return {
        user_id: u.id, email: u.email, full_name: r?.full_name ?? "", role: r?.role ?? null, active: r?.active ?? false,
        status: u.last_sign_in_at ? "active" : "invited", invited_at: u.invited_at ?? u.created_at, last_sign_in_at: u.last_sign_in_at ?? null,
      };
    }).sort((a, b) => (a.email ?? "").localeCompare(b.email ?? ""));
    return json({ ok: true, users: list, me: who.user.id });
  }

  // ── invite ──
  if (action === "invite") {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const name = typeof body.full_name === "string" ? body.full_name.trim() : "";
    const role = String(body.role ?? "");
    if (!EMAIL_RE.test(email) || email.length > 200) return json({ ok: false, error: "Enter a valid email address." }, 400);
    if (!name || name.length > 80) return json({ ok: false, error: "Enter the person's name (max 80 characters)." }, 400);
    if (!ROLES.includes(role)) return json({ ok: false, error: "Choose Editor or Viewer." }, 400);

    const existing = (await authUsers()).find((u) => (u.email ?? "").toLowerCase() === email);
    let userId = existing?.id;
    let message = `Invitation sent to ${email}.`;
    if (existing) {
      const { data: has } = await db.from("app_users").select("user_id").eq("user_id", existing.id).maybeSingle();
      if (has) return json({ ok: false, error: `${email} already has access. Use the list below to change their role.` }, 409);
      message = `${email} already had an account, so they have simply been given access (no new email was sent).`;
    } else {
      const { data, error } = await db.auth.admin.inviteUserByEmail(email, { data: { full_name: name } });
      if (error || !data?.user) return json({ ok: false, error: `Could not send the invitation: ${error?.message ?? "unknown error"}` }, 502);
      userId = data.user.id;
    }
    const { error: insErr } = await db.from("app_users").insert({ user_id: userId, email, full_name: name, role, active: true });
    if (insErr) return json({ ok: false, error: `The invitation went out but the role could not be saved: ${insErr.message}` }, 500);
    await audit("invite", userId!, name, `Invited ${email} as ${role}`, { email, role });
    return json({ ok: true, message });
  }

  // ── actions on an existing person ──
  const userId = typeof body.user_id === "string" ? body.user_id : "";
  if (!userId) return json({ ok: false, error: "Missing user." }, 400);
  if (userId === who.user.id) return json({ ok: false, error: "You can't change your own account here." }, 400);
  const { data: target } = await db.from("app_users").select("user_id, email, full_name, role, active").eq("user_id", userId).maybeSingle();
  if (!target) return json({ ok: false, error: "That person has no access record." }, 404);
  if (target.role === "admin") return json({ ok: false, error: "Administrator accounts can't be changed here." }, 403);

  if (action === "resend") {
    const u = (await authUsers()).find((x) => x.id === userId);
    if (!u) return json({ ok: false, error: "Account not found." }, 404);
    if (u.last_sign_in_at) return json({ ok: false, error: "They have already signed in. If they forgot their password, they can use 'Forgot password' on the login page." }, 400);
    const { error } = await db.auth.admin.inviteUserByEmail(target.email, { data: { full_name: target.full_name } });
    if (error) return json({ ok: false, error: `Could not resend: ${error.message}` }, 502);
    await audit("invite", userId, target.full_name, `Resent invitation to ${target.email}`);
    return json({ ok: true, message: `Invitation resent to ${target.email}.` });
  }

  if (action === "update") {
    const patch: Record<string, unknown> = {};
    if (body.role !== undefined) {
      if (!ROLES.includes(String(body.role))) return json({ ok: false, error: "Choose Editor or Viewer." }, 400);
      patch.role = body.role;
    }
    if (body.active !== undefined) patch.active = body.active === true;
    if (!Object.keys(patch).length) return json({ ok: false, error: "Nothing to change." }, 400);
    const { error } = await db.from("app_users").update(patch).eq("user_id", userId);
    if (error) return json({ ok: false, error: "Could not save the change." }, 500);
    await audit("update", userId, target.full_name, `Changed access for ${target.email}`, patch);
    return json({ ok: true, message: "Saved." });
  }

  return json({ ok: false, error: "Unknown action." }, 400);
});

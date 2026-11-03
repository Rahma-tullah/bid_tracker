/* Prado Power - shared sign-in support for every page (start page, Bid Tracker, Project Tracker, login page).
 *
 * THE SWITCH: REQUIRE_LOGIN below.
 *   false (today): the site works exactly as before. If someone happens to be signed in, their name and a
 *                  Sign out button appear in the header and the role rules below apply.
 *   true:          every page except login.html sends visitors who are not signed in to the login page,
 *                  and shows nothing until the person's account and role have been checked.
 * The real protection is in the database (row-level security). Hiding buttons here is only a convenience.
 *
 * Roles (stored in the app_users table):  admin = everything | editor = add and edit, no deleting | viewer = read only.
 * Tests may set window.PP_REQUIRE_LOGIN before this file loads to override the switch.
 */
(function () {
  'use strict';
  const SUPABASE_URL = 'https://sspdpjrytzyqklwevuil.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNzcGRwanJ5dHp5cWtsd2V2dWlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0OTIyNDYsImV4cCI6MjEwNzA2ODI0Nn0.lYk5wjhNZ4tOynK7Zt1dPwO8epvo1EFr5tnAD9o5EUI';   // the public (anon) key; it is safe to ship in the page
  const REQUIRE_LOGIN = (typeof window.PP_REQUIRE_LOGIN === 'boolean') ? window.PP_REQUIRE_LOGIN : false;
  const IS_LOGIN_PAGE = /(^|\/)login\.html$/.test(location.pathname);

  // Invite, password-reset and expired-link emails land on the Site URL (the start page), with the person's token in the
  // address. Hand them to the login page straight away, token intact, before anything else reads or clears it.
  if (!IS_LOGIN_PAGE && /[#&](type=(invite|recovery)|error_code=|error_description=)/.test(location.hash || '')) {
    document.documentElement.style.visibility = 'hidden';
    location.replace('login.html' + location.hash);
    return;
  }

  const PPAuth = window.PPAuth = { requireLogin: REQUIRE_LOGIN, client: null, user: null, role: null, ready: null };

  // One shared database client for the page, so every request carries the signed-in person's token.
  try { PPAuth.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY); }
  catch (e) { console.error('Sign-in support could not start:', e); }
  const client = PPAuth.client;
  const hasAuth = !!(client && client.auth && client.auth.getSession);

  // While we check who is looking, show nothing (only when sign-in is required).
  if (REQUIRE_LOGIN && !IS_LOGIN_PAGE) document.documentElement.style.visibility = 'hidden';
  const reveal = () => { document.documentElement.style.visibility = ''; };

  PPAuth.accessToken = async () => {
    if (!hasAuth) return null;
    try { const { data } = await client.auth.getSession(); return (data && data.session && data.session.access_token) || null; }
    catch (e) { return null; }
  };
  PPAuth.signOut = async () => {
    try { if (hasAuth) await client.auth.signOut(); } catch (e) { console.error(e); }
    location.replace('login.html');
  };

  const goToLogin = () => {
    const page = (location.pathname.split('/').pop() || 'index.html');
    location.replace('login.html?next=' + encodeURIComponent(/^[A-Za-z0-9_-]+\.html$/.test(page) ? page : 'index.html'));
  };

  // ── role rules: hide what a role may not use (the database enforces the same rules) ──
  const style = document.createElement('style');
  style.textContent = `
    html[data-role="viewer"] #open-form-btn,
    html[data-role="viewer"] [data-act="edit"], html[data-role="viewer"] [data-act="remind"],
    html[data-role="viewer"] [data-act="submit"], html[data-role="viewer"] [data-act="missed"],
    html[data-role="viewer"] [data-act="revert"], html[data-role="viewer"] [data-act="delete"],
    html[data-role="viewer"] [data-act="outcome"], html[data-role="viewer"] [data-act="add-report"],
    html[data-role="viewer"] [data-act="remove-section"], html[data-role="viewer"] [data-act="add-section"],
    html[data-role="viewer"] .add-item-row, html[data-role="viewer"] .item-remove, html[data-role="viewer"] .item-na { display: none !important; }
    html[data-role="viewer"] .chk { pointer-events: none; }
    html[data-role="editor"] [data-act="delete"], html[data-role="editor"] [data-act="delete-report"] { display: none !important; }
    .auth-who { color: var(--g200, #bbf7d0); font-size: .75rem; white-space: nowrap; }
    .auth-out { color: var(--g200, #bbf7d0); font-size: .75rem; font-weight: 600; border: 1px solid rgba(255,255,255,.22); border-radius: 6px; padding: 5px 11px; background: none; cursor: pointer; white-space: nowrap; }
    .auth-link { color: var(--g200, #bbf7d0); font-size: .75rem; font-weight: 600; border: 1px solid rgba(255,255,255,.22); border-radius: 6px; padding: 5px 11px; white-space: nowrap; }
    .auth-link:hover { background: rgba(255,255,255,.12); }
    .auth-out:hover { background: rgba(255,255,255,.12); }
    @media (max-width: 600px) { .auth-who { display: none; } }`;
  document.head.appendChild(style);

  const onDom = fn => (document.readyState === 'loading') ? document.addEventListener('DOMContentLoaded', fn) : fn();

  function showWho(name, role) {
    onDom(() => {
      const nav = document.querySelector('.nav-right');
      if (!nav || nav.querySelector('.auth-who')) return;
      const who = document.createElement('span');
      who.className = 'auth-who'; who.textContent = name + ' · ' + role;
      const out = document.createElement('button');
      out.className = 'auth-out'; out.type = 'button'; out.textContent = 'Sign out';
      out.addEventListener('click', PPAuth.signOut);
      nav.prepend(out); nav.prepend(who);
      if (role === 'admin' && !/(^|\/)audit\.html$/.test(location.pathname)) {      // admins get a link to the audit log
        const a = document.createElement('a');
        a.className = 'auth-link'; a.href = 'audit.html'; a.textContent = 'Audit log'; a.style.textDecoration = 'none';
        nav.prepend(a);
      }
    });
  }

  function showNoAccess(email) {
    onDom(() => {
      document.body.innerHTML = '';
      const box = document.createElement('div');
      box.style.cssText = 'max-width:460px;margin:12vh auto;padding:28px;font-family:system-ui,sans-serif;text-align:center;line-height:1.6';
      const h = document.createElement('h2'); h.textContent = 'No access yet';
      const p = document.createElement('p');
      p.textContent = (email ? email + ' is signed in, but ' : 'This account ') + 'has not been given access to the tracker. Please ask an administrator to add you.';
      const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Sign out';
      b.style.cssText = 'margin-top:12px;padding:10px 22px;border-radius:8px;border:1px solid #999;background:#fff;cursor:pointer;font-size:.9rem';
      b.addEventListener('click', PPAuth.signOut);
      box.append(h, p, b); document.body.appendChild(box); reveal();
    });
  }

  async function loadProfile(userId) {
    try {
      const { data, error } = await client.from('app_users').select('role, full_name, active').eq('user_id', userId).maybeSingle();
      if (error) { console.error('Could not read the account role:', error.message); return null; }
      return data || null;
    } catch (e) { console.error(e); return null; }
  }

  PPAuth.ready = (async () => {
    if (!hasAuth) return true;                                   // no sign-in support in this environment: carry on as before
    let session = null;
    try { const r = await client.auth.getSession(); session = r && r.data && r.data.session; } catch (e) { /* treated as signed out */ }

    if (!session) {
      if (REQUIRE_LOGIN && !IS_LOGIN_PAGE) { goToLogin(); return false; }
      reveal(); return true;
    }
    if (IS_LOGIN_PAGE) return true;

    const prof = await loadProfile(session.user.id);
    const allowed = !!(prof && prof.active !== false && ['admin', 'editor', 'viewer'].includes(prof.role));
    if (REQUIRE_LOGIN && !allowed) { showNoAccess(session.user.email); return false; }
    if (allowed) {
      PPAuth.role = prof.role;
      PPAuth.user = { id: session.user.id, email: session.user.email, name: prof.full_name || session.user.email, role: prof.role };
      document.documentElement.dataset.role = prof.role;
      showWho(PPAuth.user.name, prof.role);
    }
    reveal(); return true;
  })();

  // Signed out in another tab, or the session ended: go back to the login page.
  if (hasAuth && client.auth.onAuthStateChange) {
    client.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT' && REQUIRE_LOGIN && !IS_LOGIN_PAGE) goToLogin(); });
  }
})();

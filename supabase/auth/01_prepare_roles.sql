-- STEP 1 of the login: roles table. SAFE TO RUN NOW - it changes nothing about how the site behaves.
-- Creates app_users (who has which role), the app_role() helper the access rules will use, and records role changes in the audit log.

create table public.app_users (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  full_name  text not null default '',
  role       text not null check (role in ('admin', 'editor', 'viewer')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index app_users_email_key on public.app_users (lower(email));

alter table public.app_users enable row level security;
revoke all on public.app_users from anon;

-- The role of whoever is signed in (null if they have no active account). SECURITY DEFINER so the access rules can use it without recursion.
create function public.app_role() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select role from public.app_users where user_id = auth.uid() and active
$$;
revoke all on function public.app_role() from public, anon;
grant execute on function public.app_role() to authenticated;

-- Everyone signed in can read their own row (the site uses it to show their name and role); admins can read and manage all rows.
create policy app_users_read_self on public.app_users for select to authenticated using (user_id = auth.uid());
create policy app_users_admin_all on public.app_users for all    to authenticated using (public.app_role() = 'admin') with check (public.app_role() = 'admin');

-- Role changes are recorded in the audit log (the audit function now also understands this table's key and email).
create or replace function public.audit_row_change() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_old     jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new     jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row     jsonb := coalesce(v_new, v_old);
  v_claims  jsonb;
  v_headers jsonb;
  v_role    text;
  v_changes jsonb;
  v_ip      inet;
begin
  begin v_claims  := nullif(current_setting('request.jwt.claims',  true), '')::jsonb; exception when others then v_claims  := null; end;
  begin v_headers := nullif(current_setting('request.headers',     true), '')::jsonb; exception when others then v_headers := null; end;
  v_role := v_claims->>'role';

  if tg_op = 'UPDATE' then
    v_changes := public.audit_row_diff(v_old, v_new);
    if v_changes = '{}'::jsonb then return null; end if;      -- nothing really changed: don't log noise
  else
    v_changes := v_row;                                        -- insert: the new row; delete: the full old row (a restore copy)
  end if;

  begin v_ip := nullif(trim(split_part(coalesce(v_headers->>'x-forwarded-for', v_headers->>'x-real-ip', ''), ',', 1)), '')::inet;
  exception when others then v_ip := null; end;

  insert into public.audit_log
    (actor_id, actor_email, actor_role, source, action, table_name, record_id, record_label, changes, ip, user_agent, request_id)
  values (
    auth.uid(), v_claims->>'email', v_role,
    case when v_claims is null then 'sql-editor' when v_role = 'service_role' then 'edge-function' else 'app' end,
    lower(tg_op), tg_table_name,
    coalesce(v_row->>'id', v_row->>'anchor', v_row->>'user_id', '?'),
    coalesce(v_row->>'name', v_row->>'project_name', v_row->>'anchor', v_row->>'email', tg_table_name),
    v_changes, v_ip, left(v_headers->>'user-agent', 300),
    coalesce(v_headers->>'x-request-id', 'tx-' || txid_current())
  );
  return null;
end $$;

create trigger audit_app_users after insert or update or delete on public.app_users
  for each row execute function public.audit_row_change();

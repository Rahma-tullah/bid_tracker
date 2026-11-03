-- STEP 3 of the login: THE SWITCH. Run only when everyone can sign in and has a role (step 2).
-- Replaces "anyone with the page can read and edit" with role-based rules:
--   viewer: read  |  editor: read, add, edit  |  admin: everything, including delete and the audit log.
-- Anonymous visitors (no login) can no longer read or change bids, projects or progress reports.
-- Emergency undo: 04_rollback.sql.
-- (If 05_interim_signed_in_access.sql was applied, this step removes that interim rule too.)

-- bids
drop policy if exists public_all on public.bids;
drop policy if exists signed_in_open on public.bids;   -- the interim rule (05_interim_signed_in_access.sql)
create policy bids_read   on public.bids for select to authenticated using (public.app_role() is not null);
create policy bids_insert on public.bids for insert to authenticated with check (public.app_role() in ('editor', 'admin'));
create policy bids_update on public.bids for update to authenticated using (public.app_role() in ('editor', 'admin')) with check (public.app_role() in ('editor', 'admin'));
create policy bids_delete on public.bids for delete to authenticated using (public.app_role() = 'admin');

-- projects
drop policy if exists public_all on public.projects;
drop policy if exists signed_in_open on public.projects;   -- the interim rule (05_interim_signed_in_access.sql)
create policy projects_read   on public.projects for select to authenticated using (public.app_role() is not null);
create policy projects_insert on public.projects for insert to authenticated with check (public.app_role() in ('editor', 'admin'));
create policy projects_update on public.projects for update to authenticated using (public.app_role() in ('editor', 'admin')) with check (public.app_role() in ('editor', 'admin'));
create policy projects_delete on public.projects for delete to authenticated using (public.app_role() = 'admin');

-- bid_progress_reports
drop policy if exists public_all on public.bid_progress_reports;
drop policy if exists signed_in_open on public.bid_progress_reports;   -- the interim rule (05_interim_signed_in_access.sql)
create policy bid_progress_reports_read   on public.bid_progress_reports for select to authenticated using (public.app_role() is not null);
create policy bid_progress_reports_insert on public.bid_progress_reports for insert to authenticated with check (public.app_role() in ('editor', 'admin'));
create policy bid_progress_reports_update on public.bid_progress_reports for update to authenticated using (public.app_role() in ('editor', 'admin')) with check (public.app_role() in ('editor', 'admin'));
create policy bid_progress_reports_delete on public.bid_progress_reports for delete to authenticated using (public.app_role() = 'admin');

-- Admins can read the audit log (nobody else, and nobody can change it).
grant select on public.audit_log to authenticated;
create policy audit_admin_read on public.audit_log for select to authenticated using (public.app_role() = 'admin');

-- EMERGENCY UNDO of step 3: puts back the old "anyone with the page can read and edit" rules so the site works without sign-in again.
-- (Also set REQUIRE_LOGIN back to false in auth.js, or visitors will still be sent to the login page.)

drop policy if exists bids_read on public.bids; drop policy if exists bids_insert on public.bids;
drop policy if exists bids_update on public.bids; drop policy if exists bids_delete on public.bids;
create policy public_all on public.bids for all to anon using (true) with check (true);
create policy signed_in_open on public.bids for all to authenticated using (true) with check (true);
drop policy if exists projects_read on public.projects; drop policy if exists projects_insert on public.projects;
drop policy if exists projects_update on public.projects; drop policy if exists projects_delete on public.projects;
create policy public_all on public.projects for all to anon using (true) with check (true);
create policy signed_in_open on public.projects for all to authenticated using (true) with check (true);
drop policy if exists bid_progress_reports_read on public.bid_progress_reports; drop policy if exists bid_progress_reports_insert on public.bid_progress_reports;
drop policy if exists bid_progress_reports_update on public.bid_progress_reports; drop policy if exists bid_progress_reports_delete on public.bid_progress_reports;
create policy public_all on public.bid_progress_reports for all to anon using (true) with check (true);
create policy signed_in_open on public.bid_progress_reports for all to authenticated using (true) with check (true);
drop policy if exists audit_admin_read on public.audit_log;
revoke select on public.audit_log from authenticated;

-- INTERIM (between "people start signing in" and the final cutover): signed-in people get the same open access that anonymous
-- visitors have today. Without this, a signed-in person is treated as a different database role and sees nothing at all.
-- This adds NO new exposure (anonymous visitors already have this access). Step 3 (03_cutover.sql) replaces it with role-based rules.

create policy signed_in_open on public.bids for all to authenticated using (true) with check (true);
create policy signed_in_open on public.projects for all to authenticated using (true) with check (true);
create policy signed_in_open on public.bid_progress_reports for all to authenticated using (true) with check (true);

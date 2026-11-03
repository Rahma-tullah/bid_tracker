-- STEP 2 of the login: give each invited person their role. RUN AFTER the invites have been sent and accepted.
-- It matches people by email, so it only affects accounts that already exist (an account that has not been invited yet is skipped).
insert into public.app_users (user_id, email, full_name, role)
select u.id, u.email, v.full_name, v.role
from auth.users u
join (values
  ('r.hassan@pradopower.org',   'Rahma',   'admin'),
  ('s.ufomba@pradopower.org',   'Samuel',  'editor'),
  ('e.atobatele@pradopower.org','Esther',  'editor'),
  ('o.ezekiel@pradopower.org',  'Ezekiel', 'editor'),
  ('t.ivande@pradopower.org',   'Mr TK',   'viewer')
) as v(email, full_name, role) on lower(u.email) = lower(v.email)
on conflict (user_id) do update set full_name = excluded.full_name, role = excluded.role, active = true;

-- Check: who has which role
select email, role, active from public.app_users order by role, email;

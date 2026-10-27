-- =============================================================================
-- NZ Charities Map — annual return checks, for the admin area only
--
-- Apply after 20261027000000_charity_socials.sql with the Supabase CLI
-- (`supabase db push`) or paste into the SQL editor. Idempotent: re-running is safe.
--
-- scripts/return_checks.py fills the table each week (GitHub Actions, service role);
-- /admin/returns reads it through get_return_checks(), which only answers admins.
-- The public site never sees these results: an automated check can be wrong.
-- =============================================================================

create table if not exists public.return_checks (
  id               bigint generated always as identity primary key,
  check_name       text not null,          -- year_end_mismatch | overdue | tier_over_limit
  cc_number        text not null,
  charity_name     text not null,
  annual_return_id bigint,                 -- the return the finding is about, when there is one
  year_ended       date,
  summary          text not null,          -- one plain sentence for the admin page
  details          jsonb not null default '{}'::jsonb,
  checked_at       timestamptz not null default now()
);

create index if not exists return_checks_check_idx on public.return_checks (check_name, cc_number);

-- No policies: nothing reaches the table through the API except the two functions below.
alter table public.return_checks enable row level security;
revoke all on public.return_checks from anon, authenticated;

-- The checker swaps in a whole run at once, so the page never shows half of one.
create or replace function public.replace_return_checks(p_findings jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  stored integer;
begin
  if jsonb_typeof(p_findings) is distinct from 'array' then
    raise exception 'p_findings must be a JSON array' using errcode = '22023';
  end if;
  delete from public.return_checks where true;
  insert into public.return_checks (check_name, cc_number, charity_name, annual_return_id, year_ended, summary, details)
  select f->>'check_name', f->>'cc_number', f->>'charity_name', (f->>'annual_return_id')::bigint,
         (f->>'year_ended')::date, f->>'summary', coalesce(f->'details', '{}'::jsonb)
    from jsonb_array_elements(p_findings) as f;
  get diagnostics stored = row_count;
  return stored;
end;
$$;

create or replace function public.get_return_checks()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'checked_at', (select max(c.checked_at) from public.return_checks c),
    'findings', coalesce((
      select jsonb_agg(jsonb_build_object(
               'check', c.check_name, 'cc', c.cc_number, 'name', c.charity_name,
               'return_id', c.annual_return_id, 'year_ended', c.year_ended,
               'summary', c.summary, 'details', c.details)
             order by c.check_name, c.cc_number)
        from public.return_checks c), '[]'::jsonb));
end;
$$;

-- Supabase grants EXECUTE on new functions to anon/authenticated by default,
-- so revoke first and then grant precisely.
revoke execute on function public.replace_return_checks(jsonb) from public, anon, authenticated;
revoke execute on function public.get_return_checks() from public, anon;
grant execute on function public.replace_return_checks(jsonb) to service_role;
grant execute on function public.get_return_checks() to authenticated;

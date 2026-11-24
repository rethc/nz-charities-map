-- =============================================================================
-- NZ Charities Map — intelligence, for the admin area only
--
-- Apply after 20261030000000_usage_counts.sql with the Supabase CLI
-- (`supabase db push`) or paste into the SQL editor. Idempotent: re-running is safe.
--
-- scripts/intelligence.py fills the tables each week (GitHub Actions, service role):
-- one row per registered charity, with its measures and its last five years.
-- /admin/intelligence reads them through get_intel_snapshot() and get_intel_charity(),
-- which only answer admins. The public site never sees these results: a measure is a
-- reason to look, not a finding.
-- =============================================================================

-- One row per run of the script. The pages read the latest published one.
create table if not exists public.intel_runs (
  run_id      bigint primary key,           -- the run's start, in seconds
  as_of       date not null,                -- the day the register was read
  meta        jsonb not null,               -- the years, the signals' thresholds, sector-wide totals
  published   boolean not null default false,
  computed_at timestamptz not null default now()
);

create table if not exists public.intel_charities (
  run_id    bigint not null references public.intel_runs (run_id) on delete cascade,
  cc_number text not null,
  summary   jsonb not null,                 -- the charity's row in the snapshot: an array, in meta.columns order
  detail    jsonb not null,                 -- its last five years, and the sentence behind each signal
  primary key (run_id, cc_number)
);

-- No policies: nothing reaches the tables through the API except the functions below
-- (and the script, whose service role skips row level security).
alter table public.intel_runs enable row level security;
alter table public.intel_charities enable row level security;
revoke all on public.intel_runs from anon, authenticated;
revoke all on public.intel_charities from anon, authenticated;
grant select, insert, update, delete on public.intel_runs to service_role;
grant select, insert, update, delete on public.intel_charities to service_role;

-- The script uploads a whole run, then switches the pages over to it at once, so they
-- never show half of one. Earlier runs go, and with them their charities.
create or replace function public.publish_intel_run(p_run_id bigint)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  stored integer;
begin
  select count(*) into stored from public.intel_charities c where c.run_id = p_run_id;
  if stored = 0 then
    raise exception 'Run % has no charities', p_run_id using errcode = '22023';
  end if;
  update public.intel_runs set published = true where run_id = p_run_id;
  if not found then
    raise exception 'Run % does not exist', p_run_id using errcode = '22023';
  end if;
  delete from public.intel_runs where run_id <> p_run_id;
  return stored;
end;
$$;

-- Every charity's measures in one answer (about 1 MB compressed): the pages sort, filter
-- and compare in the browser. Null before the first run.
create or replace function public.get_intel_snapshot()
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

  return (
    select jsonb_build_object(
             'computed_at', r.computed_at,
             'meta', r.meta,
             'rows', coalesce((select jsonb_agg(c.summary) from public.intel_charities c where c.run_id = r.run_id), '[]'::jsonb))
      from public.intel_runs r
     where r.published
     order by r.run_id desc
     limit 1);
end;
$$;

-- One charity: its years, what the annual return checks found, and what the map knows of it.
create or replace function public.get_intel_charity(p_cc text)
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

  return (
    select jsonb_build_object(
             'detail', c.detail,
             'purpose', (select ch.purpose from public.charities ch where ch.cc_number = c.cc_number),
             'on_map', exists (select 1 from public.charities ch
                                where ch.cc_number = c.cc_number
                                  and ch.geocode_status in ('SUCCESS', 'MANUALLY_VERIFIED')),
             'checks', coalesce((
               select jsonb_agg(jsonb_build_object('check', k.check_name, 'summary', k.summary, 'year_ended', k.year_ended)
                                order by k.check_name)
                 from public.return_checks k
                where k.cc_number = c.cc_number), '[]'::jsonb))
      from public.intel_charities c
      join public.intel_runs r on r.run_id = c.run_id and r.published
     where c.cc_number = upper(p_cc)
     order by r.run_id desc
     limit 1);
end;
$$;

-- Supabase grants EXECUTE on new functions to anon/authenticated by default,
-- so revoke first and then grant precisely.
revoke execute on function public.publish_intel_run(bigint) from public, anon, authenticated;
revoke execute on function public.get_intel_snapshot() from public, anon;
revoke execute on function public.get_intel_charity(text) from public, anon;
grant execute on function public.publish_intel_run(bigint) to service_role;
grant execute on function public.get_intel_snapshot() to authenticated;
grant execute on function public.get_intel_charity(text) to authenticated;

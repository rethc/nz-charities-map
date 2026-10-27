-- =============================================================================
-- NZ Charities Map — statement reviews, for the admin area only
--
-- Apply after 20261027010000_return_checks.sql with the Supabase CLI
-- (`supabase db push`) or paste into the SQL editor. Idempotent: re-running is safe.
--
-- Each row is one charity's published financial statements, read and checked
-- against the annual return they were filed with: a verdict, a written
-- assessment, the checks, the figures and quotes from the statement. An admin
-- uploads a results file on /admin/returns (Statements tab); the page reads it
-- back through get_statement_reviews(). Neither function answers anyone else,
-- and the public site never sees these results: a reading can be wrong.
-- =============================================================================

create table if not exists public.statement_reviews (
  cc_number    text not null,
  year_ended   date not null,                 -- the return the statements were filed with
  charity_name text not null,
  tier         smallint,
  verdict      text not null check (verdict in ('look', 'minor', 'fine', 'unread')),
  review       jsonb not null default '{}'::jsonb,  -- top, assessment, confidence, checks, figures, evidence
  reviewed_at  timestamptz not null default now(),
  primary key (cc_number, year_ended)
);

-- No policies: nothing reaches the table through the API except the two functions below.
alter table public.statement_reviews enable row level security;
revoke all on public.statement_reviews from anon, authenticated;

-- Adds a batch of reviews, replacing any earlier review of the same charity and year,
-- so batches can be uploaded one after another.
create or replace function public.upsert_statement_reviews(p_reviews jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  stored integer;
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  if jsonb_typeof(p_reviews) is distinct from 'array' then
    raise exception 'p_reviews must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_reviews) > 500 then
    raise exception 'At most 500 reviews at a time' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_reviews) as r
     where coalesce(r->>'cc', '') !~ '^CC[0-9]{4,6}$'
        or coalesce(r->>'year_ended', '') !~ '^\d{4}-\d{2}-\d{2}$'
        or coalesce(r->>'name', '') = ''
        or coalesce(r->>'verdict', '') not in ('look', 'minor', 'fine', 'unread')
        or jsonb_typeof(r->'review') is distinct from 'object'
  ) then
    raise exception 'Each review needs cc, year_ended, name, verdict and a review object' using errcode = '22023';
  end if;

  insert into public.statement_reviews (cc_number, year_ended, charity_name, tier, verdict, review, reviewed_at)
  select r->>'cc', (r->>'year_ended')::date, r->>'name', (r->>'tier')::smallint, r->>'verdict', r->'review', now()
    from jsonb_array_elements(p_reviews) as r
  on conflict (cc_number, year_ended) do update
    set charity_name = excluded.charity_name, tier = excluded.tier, verdict = excluded.verdict,
        review = excluded.review, reviewed_at = excluded.reviewed_at;
  get diagnostics stored = row_count;
  return stored;
end;
$$;

create or replace function public.get_statement_reviews()
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
    'reviewed_at', (select max(s.reviewed_at) from public.statement_reviews s),
    'reviews', coalesce((
      select jsonb_agg(jsonb_build_object(
               'cc', s.cc_number, 'year_ended', s.year_ended, 'name', s.charity_name,
               'tier', s.tier, 'verdict', s.verdict, 'review', s.review, 'reviewed_at', s.reviewed_at)
             order by s.charity_name, s.year_ended)
        from public.statement_reviews s), '[]'::jsonb));
end;
$$;

-- Supabase grants EXECUTE on new functions to anon/authenticated by default,
-- so revoke first and then grant precisely. Both functions check is_admin() themselves.
revoke execute on function public.upsert_statement_reviews(jsonb) from public, anon;
revoke execute on function public.get_statement_reviews() from public, anon;
grant execute on function public.upsert_statement_reviews(jsonb) to authenticated;
grant execute on function public.get_statement_reviews() to authenticated;

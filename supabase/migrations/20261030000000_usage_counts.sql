-- =============================================================================
-- NZ Charities Map — anonymous counts of what people press on the map
--
-- Apply after 20261028000000_statement_reviews.sql with the Supabase CLI
-- (`supabase db push`) or paste into the SQL editor. Idempotent: re-running is safe.
--
-- One number per kind of press per day (New Zealand time), e.g. "a charity's pin
-- was opened 212 times on 30 October". Nothing about who pressed it: no IP
-- address, no visitor ID, no cookie, no search text. The public map calls
-- count_use() with the kind; admins read the totals on /admin/usage through
-- get_usage_counts(). Only the kinds listed in count_use() are kept, so the
-- table can't grow past one row per kind per day, whatever anyone sends.
-- =============================================================================

create table if not exists public.usage_counts (
  day   date   not null,              -- New Zealand date
  kind  text   not null,              -- one of the kinds in count_use()
  count bigint not null default 0,
  primary key (day, kind)
);

-- No policies: nothing reaches the table through the API except the two functions below.
alter table public.usage_counts enable row level security;
revoke all on public.usage_counts from anon, authenticated;

-- Adds one to today's count for a kind of press. Unknown kinds are ignored, not refused,
-- so a page newer than the database never shows an error.
create or replace function public.count_use(p_kind text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_kind is null or not (p_kind = any (array[
    -- finding charities
    'search', 'sector', 'zoom_to', 'clear_filters', 'locate', 'cluster', 'browse',
    -- opening a charity
    'pin', 'shared_pin', 'shared_list', 'search_pick', 'related', 'shared_link',
    -- in a charity's details
    'summary', 'directions', 'copy_link', 'website', 'social', 'phone', 'email', 'show_more'
  ])) then
    return;
  end if;

  insert into public.usage_counts as u (day, kind, count)
  values ((now() at time zone 'Pacific/Auckland')::date, p_kind, 1)
  on conflict (day, kind) do update set count = u.count + 1;
end;
$$;

-- For the admin page: each kind's total over the last 7 days, the last 30 days and the
-- last 12 months (this month and the 11 before it), every kind added up per day for the
-- last 30 days and per month for those 12 months, and the first day anything was counted.
create or replace function public.get_usage_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  today date := (now() at time zone 'Pacific/Auckland')::date;
  months_from date := (date_trunc('month', today) - interval '11 months')::date;
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'today', today,
    'since', (select min(u.day) from public.usage_counts u),
    'kinds', coalesce((
      select jsonb_agg(jsonb_build_object('kind', k.kind, 'd7', k.d7, 'd30', k.d30, 'm12', k.m12) order by k.kind)
        from (
          select u.kind,
                 coalesce(sum(u.count) filter (where u.day > today - 7), 0) as d7,
                 coalesce(sum(u.count) filter (where u.day > today - 30), 0) as d30,
                 sum(u.count) as m12
            from public.usage_counts u
           where u.day >= months_from
           group by u.kind
        ) k), '[]'::jsonb),
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('day', d.day, 'count', d.total) order by d.day)
        from (
          select u.day, sum(u.count) as total
            from public.usage_counts u
           where u.day > today - 30
           group by u.day
        ) d), '[]'::jsonb),
    'months', coalesce((
      select jsonb_agg(jsonb_build_object('month', m.month, 'count', m.total) order by m.month)
        from (
          select date_trunc('month', u.day)::date as month, sum(u.count) as total
            from public.usage_counts u
           where u.day >= months_from
           group by 1
        ) m), '[]'::jsonb));
end;
$$;

-- Supabase grants EXECUTE on new functions to anon/authenticated by default,
-- so revoke first and then grant precisely. Anyone may count; only admins may read.
revoke execute on function public.count_use(text) from public;
revoke execute on function public.get_usage_counts() from public, anon;
grant execute on function public.count_use(text) to anon, authenticated;
grant execute on function public.get_usage_counts() to authenticated;

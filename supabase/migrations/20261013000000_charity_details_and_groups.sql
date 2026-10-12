-- =============================================================================
-- NZ Charities Map — what each charity does, how to reach it, and registered groups
--
-- Apply after 20260928000000_charities_map.sql with the Supabase CLI
-- (`supabase db push`) or paste into the SQL editor. Idempotent: re-running is safe.
--
-- The sync job and the site both keep working before this is applied — they
-- simply leave these details out — so it can go in before or after a deploy.
-- Existing rows are filled in by the next full sync (`--mode full`).
-- =============================================================================

-- 1. Columns --------------------------------------------------------------------
-- Only what the register's own public summary page shows. (The feed also carries a
-- contact email, EMailAddress1, that the register does not publish: it is not stored.)
alter table public.charities
  add column if not exists purpose     text,
  add column if not exists activity    text,
  add column if not exists beneficiary text,
  add column if not exists phone       text,
  add column if not exists email       text,
  add column if not exists website     text,
  add column if not exists is_group    boolean not null default false,
  add column if not exists group_cc    text;

comment on column public.charities.purpose     is 'The charity''s own statement of its charitable purpose.';
comment on column public.charities.activity    is 'Main activity, e.g. "Provides services (e.g. care / counselling)".';
comment on column public.charities.beneficiary is 'Main beneficiary, e.g. "Children / young people".';
comment on column public.charities.is_group    is 'A registered group: a parent charity and its members under one registration.';
comment on column public.charities.group_cc    is 'For a member charity, the cc_number of its registered group. Not a foreign key: the group may be missing or deregistered.';

-- Links are rendered as <a href>, so nothing but http(s) may be stored.
alter table public.charities drop constraint if exists charities_website_is_http;
alter table public.charities add constraint charities_website_is_http
  check (website is null or website ~* '^https?://[^[:space:]]+$');

-- 2. Group registration numbers -----------------------------------------------------
-- A registered group can carry a suffixed number (CC11026-0).
alter table public.charities drop constraint if exists charities_cc_number_format;
alter table public.charities add constraint charities_cc_number_format
  check (cc_number ~ '^CC[0-9]+(-[0-9]+)?$');

create index if not exists charities_group_cc_idx on public.charities (group_cc) where group_cc is not null;

-- 3. Group names -------------------------------------------------------------------
-- { "CC24831": "Abbeyfield New Zealand Group", ... } for every registered group,
-- including those without a pin, so a member can always say which group it is part of.
-- Security definer because row level security hides rows that aren't on the map;
-- it exposes nothing beyond a group's number and name, both public on the register.
create or replace function public.charity_group_names()
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(json_object_agg(c.cc_number, c.name), '{}'::json)
    from public.charities c
   where c.is_group;
$$;

-- 4. Public RPC: charities inside a bounding box ---------------------------------------
-- As before, plus the group links:
--   compact: { v, generated_at, count, groups: { cc: name }, rows: [[cc, name, sector, lon, lat, place, group_cc], ...] }
--   geojson: each feature's properties gain group_cc
-- A row whose cc is a key of `groups` is itself a group; `group_cc` names the group a member belongs to.
create or replace function public.get_charities_in_view(
  min_lon double precision,
  min_lat double precision,
  max_lon double precision,
  max_lat double precision,
  format  text default 'compact'
)
returns json
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  box_a  geometry;
  box_b  geometry;
  result json;
begin
  if min_lat is null or max_lat is null or min_lon is null or max_lon is null then
    raise exception 'All four bounds are required' using errcode = '22023';
  end if;
  if min_lat > max_lat then
    raise exception 'min_lat (%) must be <= max_lat (%)', min_lat, max_lat using errcode = '22023';
  end if;
  if format not in ('compact', 'geojson') then
    raise exception 'format must be compact or geojson' using errcode = '22023';
  end if;

  min_lat := greatest(min_lat, -90);  max_lat := least(max_lat, 90);
  min_lon := greatest(least(min_lon, 180), -180);
  max_lon := greatest(least(max_lon, 180), -180);

  if min_lon <= max_lon then
    box_a := ST_MakeEnvelope(min_lon, min_lat, max_lon, max_lat, 4326);
  else
    box_a := ST_MakeEnvelope(min_lon, min_lat, 180, max_lat, 4326);
    box_b := ST_MakeEnvelope(-180, min_lat, max_lon, max_lat, 4326);
  end if;

  if format = 'geojson' then
    select json_build_object(
             'type', 'FeatureCollection',
             'features', coalesce(json_agg(json_build_object(
                 'type', 'Feature',
                 'id', c.cc_number,
                 'geometry', ST_AsGeoJSON(c.coordinates, 5)::json,
                 'properties', json_build_object(
                     'cc_number', c.cc_number,
                     'name', c.name,
                     'sector', c.sector,
                     'place', coalesce(nullif(c.city, ''), c.suburb),
                     'group_cc', c.group_cc)
               ) order by c.cc_number), '[]'::json))
      into result
      from public.charities c
     where c.geocode_status in ('SUCCESS', 'MANUALLY_VERIFIED')
       and (c.coordinates && box_a or (box_b is not null and c.coordinates && box_b));
  else
    select json_build_object(
             'v', 2,
             'generated_at', now(),
             'count', count(*),
             'groups', public.charity_group_names(),
             'rows', coalesce(json_agg(json_build_array(
                 c.cc_number,
                 c.name,
                 c.sector,
                 round(ST_X(c.coordinates)::numeric, 5)::float8,  -- ~1 m precision, no trailing zeros
                 round(ST_Y(c.coordinates)::numeric, 5)::float8,
                 coalesce(nullif(c.city, ''), c.suburb),
                 c.group_cc
               ) order by c.cc_number), '[]'::json))
      into result
      from public.charities c
     where c.geocode_status in ('SUCCESS', 'MANUALLY_VERIFIED')
       and (c.coordinates && box_a or (box_b is not null and c.coordinates && box_b));
  end if;

  -- Let browsers reuse the response for 5 minutes when called with GET.
  perform set_config(
    'response.headers',
    '[{"Cache-Control": "public, max-age=300, stale-while-revalidate=3600"}]',
    true);

  return result;
end;
$$;

-- 5. Function privileges ------------------------------------------------------------
revoke execute on function public.charity_group_names() from public;
grant execute on function public.charity_group_names() to anon, authenticated, service_role;

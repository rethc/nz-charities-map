-- =============================================================================
-- NZ Charities Map — database schema, security and RPCs
--
-- Apply with the Supabase CLI (`supabase db push`) or paste into the SQL editor.
-- The script is idempotent: re-running it is safe.
--
-- Status model (charities.geocode_status)
--   NULL               queued — the next sync run will geocode it
--   SUCCESS            geocoded automatically with high confidence  → public map
--   MANUALLY_VERIFIED  pin placed by an admin in /admin/triage       → public map
--   NEEDS_REVIEW       low confidence / not found / timed out        → triage queue
--   FAILED             an admin decided it can't be located (e.g. PO Box only)
-- =============================================================================

-- 1. Extensions ---------------------------------------------------------------
-- Supabase recommends the `extensions` schema. If PostGIS is already installed
-- in `public`, this is a no-op and everything below still resolves, because
-- every function pins search_path to `public, extensions`.
create extension if not exists postgis with schema extensions;

-- 2. Table --------------------------------------------------------------------
create table if not exists public.charities (
  id             uuid primary key default gen_random_uuid(),
  cc_number      text not null unique,
  name           text not null,
  sector         text,
  address_raw    text,
  street         text,
  suburb         text,
  city           text,
  postcode       text,
  coordinates    geometry(Point, 4326),
  geocode_status text,
  geocode_error  text,
  last_synced_at timestamptz not null default now(),

  constraint charities_cc_number_format check (cc_number ~ '^CC[0-9]+$'),
  constraint charities_geocode_status_check check (
    geocode_status in ('SUCCESS', 'NEEDS_REVIEW', 'MANUALLY_VERIFIED', 'FAILED')
  ),
  -- A record can only be "resolved" if it actually has a point.
  constraint charities_resolved_has_point check (
    geocode_status is null
    or geocode_status not in ('SUCCESS', 'MANUALLY_VERIFIED')
    or coordinates is not null
  )
);

comment on table  public.charities is 'Registered NZ charities (Charities Services open data, CC BY 3.0 NZ) with geocoded locations.';
comment on column public.charities.address_raw is 'Normalised street address exactly as published on the register. The sync job compares it to detect moves — do not edit by hand.';
comment on column public.charities.geocode_status is 'NULL = queued for geocoding. See the status model at the top of the migration.';

-- 3. Indexes ------------------------------------------------------------------
create index if not exists charities_coordinates_gix on public.charities using gist (coordinates);
create index if not exists charities_geocode_status_idx on public.charities (geocode_status);

-- 4. Reset the geocode whenever the published address changes ------------------
-- The ETL upserts address_raw every run. If a charity moves, its old pin (even a
-- manually verified one) is wrong, so it goes back into the geocoding queue.
create or replace function public.charities_reset_geocode_on_address_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.address_raw is distinct from old.address_raw then
    new.coordinates    := null;
    new.geocode_status := null;
    new.geocode_error  := null;
  end if;
  return new;
end;
$$;

drop trigger if exists charities_reset_geocode on public.charities;
create trigger charities_reset_geocode
  before update of address_raw on public.charities
  for each row execute function public.charities_reset_geocode_on_address_change();

-- 5. Admins -------------------------------------------------------------------
-- Add an admin (after they've signed in once, or created in Auth → Users):
--   insert into public.admins (user_id)
--   select id from auth.users where email = 'you@example.org';
create table if not exists public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;  -- no policies: invisible to the API

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins a where a.user_id = (select auth.uid()));
$$;

-- 6. Sync run log ---------------------------------------------------------------
create table if not exists public.sync_runs (
  id               bigint generated always as identity primary key,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  mode             text not null check (mode in ('incremental', 'full')),
  status           text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  source_watermark timestamptz,          -- max ModifiedOn seen from the register
  fetched          integer not null default 0,
  upserted         integer not null default 0,
  deleted          integer not null default 0,
  geocoded         integer not null default 0,
  succeeded        integer not null default 0,
  needs_review     integer not null default 0,
  error            text
);
alter table public.sync_runs enable row level security;  -- service role only

-- 7. Row level security on charities -------------------------------------------
-- Everything on the Charities Register is public, but the API only exposes
-- resolved rows. All admin reads and writes go through the security-definer
-- RPCs below, each of which checks is_admin(). Inserts/deletes are service-role only.
alter table public.charities enable row level security;

drop policy if exists "Public can read resolved charities" on public.charities;
create policy "Public can read resolved charities"
  on public.charities for select
  to anon, authenticated
  using (geocode_status in ('SUCCESS', 'MANUALLY_VERIFIED'));

revoke insert, update, delete, truncate on public.charities from anon, authenticated;

-- 8. Public RPC: charities inside a bounding box --------------------------------
-- Longitudes are expected in [-180, 180]. A box that crosses the antimeridian —
-- e.g. mainland NZ plus the Chatham Islands (165 → -175) — is passed with
-- min_lon > max_lon and is split into two envelopes.
--
-- format => 'compact' (default): { v, generated_at, count, rows: [[cc, name, sector, lon, lat, place], ...] }
-- format => 'geojson':           a GeoJSON FeatureCollection (handy for QGIS / debugging)
--
-- Returns a single JSON value, so PostgREST's max-rows cap doesn't truncate it.
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
                     'place', coalesce(nullif(c.city, ''), c.suburb))
               ) order by c.cc_number), '[]'::json))
      into result
      from public.charities c
     where c.geocode_status in ('SUCCESS', 'MANUALLY_VERIFIED')
       and (c.coordinates && box_a or (box_b is not null and c.coordinates && box_b));
  else
    select json_build_object(
             'v', 1,
             'generated_at', now(),
             'count', count(*),
             'rows', coalesce(json_agg(json_build_array(
                 c.cc_number,
                 c.name,
                 c.sector,
                 round(ST_X(c.coordinates)::numeric, 5)::float8,  -- ~1 m precision, no trailing zeros
                 round(ST_Y(c.coordinates)::numeric, 5)::float8,
                 coalesce(nullif(c.city, ''), c.suburb)
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

-- 9. Admin RPCs -------------------------------------------------------------------
create or replace function public.get_review_queue(p_limit integer default 500)
returns table (
  id             uuid,
  cc_number      text,
  name           text,
  sector         text,
  address_raw    text,
  street         text,
  suburb         text,
  city           text,
  postcode       text,
  geocode_error  text,
  lon            double precision,
  lat            double precision,
  last_synced_at timestamptz,
  queue_total    bigint
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  return query
    select c.id, c.cc_number, c.name, c.sector, c.address_raw, c.street, c.suburb,
           c.city, c.postcode, c.geocode_error,
           ST_X(c.coordinates), ST_Y(c.coordinates),
           c.last_synced_at,
           count(*) over ()
      from public.charities c
     where c.geocode_status = 'NEEDS_REVIEW'
     order by c.name
     limit greatest(1, least(coalesce(p_limit, 500), 2000));
end;
$$;

-- NB: PostGIS points are (x = longitude, y = latitude).
create or replace function public.verify_charity_location(
  p_id  uuid,
  p_lon double precision,
  p_lat double precision
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  -- NZ incl. Chatham Islands (east of the antimeridian) and the subantarctic islands.
  if p_lat is null or p_lon is null
     or p_lat not between -53.0 and -28.0
     or not (p_lon between 160.0 and 180.0 or p_lon between -180.0 and -170.0) then
    raise exception 'Point (lon %, lat %) is outside New Zealand', p_lon, p_lat using errcode = '22023';
  end if;

  update public.charities
     set coordinates    = ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326),
         geocode_status = 'MANUALLY_VERIFIED',
         geocode_error  = null
   where id = p_id;

  if not found then
    raise exception 'Charity % not found', p_id using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.mark_charity_unlocatable(p_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  update public.charities
     set coordinates    = null,
         geocode_status = 'FAILED',
         geocode_error  = coalesce(nullif(trim(p_reason), ''), 'Marked as not locatable by an admin')
   where id = p_id;

  if not found then
    raise exception 'Charity % not found', p_id using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.get_sync_status()
returns json
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  return json_build_object(
    'counts', (
      select coalesce(json_object_agg(s.status, s.n), '{}'::json)
        from (select coalesce(geocode_status, 'PENDING') as status, count(*) as n
                from public.charities group by 1) s),
    'last_run', (
      select row_to_json(r)
        from (select * from public.sync_runs order by started_at desc limit 1) r)
  );
end;
$$;

-- 10. ETL RPC (service role only) -------------------------------------------------
-- Bulk-applies geocoding results. Guards make it safe to run while an admin is
-- working the triage queue: a result is skipped if the address changed since it
-- was read, or if an admin has already verified or dismissed the record.
create or replace function public.apply_geocode_results(p_results jsonb)
returns integer
language plpgsql
set search_path = public, extensions
as $$
declare
  n integer;
begin
  update public.charities c
     set coordinates    = case when r.lon is not null and r.lat is not null
                               then ST_SetSRID(ST_MakePoint(r.lon, r.lat), 4326) end,
         geocode_status = r.status,
         geocode_error  = r.error,
         last_synced_at = now()
    from jsonb_to_recordset(p_results) as r(
           cc_number   text,
           address_raw text,
           lon         double precision,
           lat         double precision,
           status      text,
           error       text)
   where c.cc_number = r.cc_number
     and c.address_raw is not distinct from r.address_raw
     and c.geocode_status is distinct from 'MANUALLY_VERIFIED'
     and c.geocode_status is distinct from 'FAILED';
  get diagnostics n = row_count;
  return n;
end;
$$;

-- 11. Optional CDN snapshot bucket ---------------------------------------------------
-- `sync_charities.py --publish-snapshot` uploads the national dataset here so the
-- public map can load it from Supabase's CDN (separate "cached egress" quota)
-- instead of hitting Postgres on every visit. Public read; writes are service-role only.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public)
    values ('public-data', 'public-data', true)
    on conflict (id) do nothing;
  end if;
end
$$;

-- 12. Function privileges ------------------------------------------------------------
-- Supabase grants EXECUTE on new functions to anon/authenticated by default,
-- so revoke first and then grant precisely.
revoke execute on function public.get_charities_in_view(double precision, double precision, double precision, double precision, text) from public;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.get_review_queue(integer) from public, anon;
revoke execute on function public.verify_charity_location(uuid, double precision, double precision) from public, anon;
revoke execute on function public.mark_charity_unlocatable(uuid, text) from public, anon;
revoke execute on function public.get_sync_status() from public, anon;
revoke execute on function public.apply_geocode_results(jsonb) from public, anon, authenticated;
revoke execute on function public.charities_reset_geocode_on_address_change() from public, anon, authenticated;

grant execute on function public.get_charities_in_view(double precision, double precision, double precision, double precision, text) to anon, authenticated, service_role;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.get_review_queue(integer) to authenticated;
grant execute on function public.verify_charity_location(uuid, double precision, double precision) to authenticated;
grant execute on function public.mark_charity_unlocatable(uuid, text) to authenticated;
grant execute on function public.get_sync_status() to authenticated;
grant execute on function public.apply_geocode_results(jsonb) to service_role;

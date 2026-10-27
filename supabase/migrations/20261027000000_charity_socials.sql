-- =============================================================================
-- NZ Charities Map — links to each charity's social pages (Facebook, Instagram, X …)
--
-- Apply after 20261013000000_charity_details_and_groups.sql with the Supabase CLI
-- (`supabase db push`) or paste into the SQL editor. Idempotent: re-running is safe.
--
-- The sync job and the site both keep working before this is applied — they
-- simply leave the links out — so it can go in before or after a deploy.
-- Existing rows are filled in by the next full sync (`--mode full`).
-- =============================================================================

alter table public.charities
  add column if not exists socials text[];

comment on column public.charities.socials is
  'Links to the charity''s social pages, one per platform, cleaned up by the sync from the register''s Facebook, Twitter and social network fields. Null when there are none.';

-- Links are rendered as <a href>, so nothing but https:// addresses may be stored.
alter table public.charities drop constraint if exists charities_socials_are_https;
alter table public.charities add constraint charities_socials_are_https
  check (socials is null
         or array_to_string(socials, ' ') ~ '^https://[^[:space:]]+( https://[^[:space:]]+)*$');

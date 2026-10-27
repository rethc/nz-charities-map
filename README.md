# NZ Charities Map

An interactive map of every registered charity and group in Aotearoa New Zealand that has a street address,
built from the Charities Services register and kept up to date nightly. Visitors can search by name
or registration number (CC12345), filter by sector, and open any charity's register profile.
Admins get a triage screen for the addresses the geocoder couldn't place with confidence.

Everything runs on free tiers: Supabase (Postgres + PostGIS + Auth + Storage), GitHub Actions,
Netlify, OpenFreeMap and LINZ.

```
Charities Services OData ──► GitHub Actions, nightly ──────────────► Supabase Postgres + PostGIS
 (the public register)       scripts/sync\_charities.py                  │ RLS, RPCs, Auth, Storage
                             clean address → LINZ → Photon              │
                             SUCCESS / NEEDS\_REVIEW                     ├──► public map  (/)
                                                                        │    Vite + React 19 + MapLibre 6 on Netlify
                                                                        └──► admin triage (/admin/triage)
                                                                             Supabase Auth + Netlify Function geocoder
```

&#x20;
```

## Pages for search engines

The map runs in JavaScript, so search engines and AI crawlers can't read it on their own. After
`vite build`, `npm run build` runs `scripts/seo/build-pages.mts`, which reads the same public data
as the map and writes plain HTML pages into `dist/`:

* `/charity/CC12345/`: one page per charity, with its purpose, address and nearby charities
* `/region/wellington/` and `/region/wellington/lower-hutt-city/`: Stats NZ's 16 regions (plus the Chatham Islands) and their districts and cities, with Auckland split into its 21 local board areas. Each charity is placed by its pin, using the official boundaries saved in `scripts/seo/areas.json` (© Stats NZ, CC BY 4.0). Stats NZ updates them each year: run `npm run seo:areas` and commit the new file.
* `/in/nelson/`: one page per town with 3 or more charities, listing all of them by sector. "Wellington CBD", "Auckland Central" and the like count as the town itself (see `townKey` in `scripts/seo/model.mts`). Towns with more than 400 also get one page per sector (`/in/auckland/health/`)
* `/sector/health/` and `/browse/`: the index pages (the map's header links to `/browse/`)
* `/sitemap.xml`, plus a `Sitemap:` line added to `robots.txt`

The pages are rebuilt on every deploy. To refresh them weekly between code changes, create a
build hook in Netlify and save its URL as the `NETLIFY_BUILD_HOOK` repository secret; the
Saturday full sync then triggers a deploy. Builds without Supabase settings skip this step, and
`SEO_PAGES=off` turns it off. If the data can't be loaded, the build fails, so Netlify keeps
the current site live. Tests: `npm run test:pages`.

## Data licences

* **Charity data:** © Charities Services, licensed under CC BY 3.0 NZ.
* **Address points:** from LINZ, licensed under CC BY 4.0.
* **Region and district boundaries:** © Stats NZ – Tatauranga Aotearoa, licensed under CC BY 4.0.
* **Basemap:** OpenFreeMap, using © OpenMapTiles and © OpenStreetMap contributors data.

The map shows all of these credits in its attribution control.


# NZ Charities Map

An interactive map of every registered charity in Aotearoa New Zealand that has a street address,
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

## Data licences

* **Charity data:** © Charities Services, licensed under CC BY 3.0 NZ.
* **Address points:** from LINZ, licensed under CC BY 4.0.
* **Basemap:** OpenFreeMap, using © OpenMapTiles and © OpenStreetMap contributors data.

The map shows all of these credits in its attribution control.


#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "supabase>=2.31,<3",
#   "httpx>=0.28,<1",
# ]
# ///
"""
Sync registered New Zealand charities into Supabase and geocode their street addresses.

Pipeline
  1. Fetch changed organisations from the Charities Services OData API (keyset-paged).
  2. Clean each street address (strip levels / PO boxes / RD numbers / care-of lines).
  3. Upsert into `public.charities`. A database trigger re-queues a record for
     geocoding whenever its published address changes (geocode_status -> NULL).
  4. Geocode queued records: LINZ NZ Addresses (authoritative) first, then Photon,
     optionally Nominatim. Anything uncertain becomes NEEDS_REVIEW with a reason —
     the job never crashes on a bad address or a slow geocoder.
  5. Record the run in `public.sync_runs`; optionally publish a CDN snapshot.

Usage
  uv run scripts/sync_charities.py                      # incremental since last good run
  uv run scripts/sync_charities.py --mode full          # full reconciliation + prune deregistered
  uv run scripts/sync_charities.py --retry-review       # also re-try the NEEDS_REVIEW queue
  uv run scripts/sync_charities.py --dry-run --limit 25 # fetch + geocode + print, write nothing
  uv run scripts/sync_charities.py --source-csv data.csv --dry-run   # test the cleaner offline

Environment
  SUPABASE_URL                 https://<project>.supabase.co
  SUPABASE_SERVICE_ROLE_KEY    service_role JWT or a new-style sb_secret_… key (never ship to a browser)
  LINZ_API_KEY                 free LINZ Data Service key — strongly recommended
  GEOCODERS                    provider order, default "linz,photon" (add "nominatim" to opt in)
  GEOCODER_CONTACT             email or URL identifying you in User-Agent headers
  LINZ_ADDRESS_LAYER           default 123113 (NZ Addresses; 105689 was deprecated in March 2026)
  SECTOR_NAMES_JSON            optional {"<MainSectorId>": "<name>"} override for the sector lookup
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import math
import os
import re
import sys
import threading
import time
import unicodedata
from collections.abc import Iterable, Iterator
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from difflib import SequenceMatcher
from statistics import median
from typing import Any, Literal

import httpx

log = logging.getLogger("sync_charities")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ODATA_BASE = "https://www.odata.charities.govt.nz"
ODATA_FIELDS = (
    "OrganisationId",
    "CharityRegistrationNumber",
    "Name",
    "RegistrationStatus",
    "StreetAddressLine1",
    "StreetAddressLine2",
    "StreetAddressSuburb",
    "StreetAddressCity",
    "StreetAddressPostcode",
    "StreetAddressCountry",
    "MainSectorId",
    "ModifiedOn",
)
ODATA_PAGE_SIZE = 1000  # the service caps un-flagged queries at 1000 rows

LINZ_WFS = "https://data.linz.govt.nz/services;key={key}/wfs"
PHOTON_URL = "https://photon.komoot.io/api/"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"

# Whole of NZ incl. Chatham Islands (east of the antimeridian) and the subantarctic islands.
# Mirrors public.verify_charity_location() in the migration.
NZ_LAT_RANGE = (-53.0, -28.0)
# get_charities_in_view() bounds used for the snapshot: 165°E → 175°W wraps the antimeridian.
NZ_VIEW_BOUNDS = {"min_lon": 165.0, "min_lat": -53.0, "max_lon": -175.0, "max_lat": -28.0}

SUCCESS_THRESHOLD = 0.85        # combined score needed for an automatic SUCCESS
AMBIGUITY_MARGIN = 0.05         # rivals scoring within this of the best are "ties"...
AMBIGUITY_DISTANCE_M = 300      # ...and only matter if they're further away than this
UPSERT_BATCH = 500
RESULT_BATCH = 200

Status = Literal["SUCCESS", "NEEDS_REVIEW"]
Precision = Literal["address", "street", "locality"]


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class CleanAddress:
    raw: str | None                 # normalised published address — the change-detection key
    street: str | None = None       # "4/5 Moana Avenue", "23-29 Albert Street", "State Highway 2"
    unit: str | None = None
    number: int | None = None
    suffix: str | None = None
    number_high: int | None = None
    road: str | None = None         # "Moana Avenue"
    suburb: str | None = None
    city: str | None = None
    postcode: str | None = None
    po_box: bool = False
    rural_delivery: str | None = None
    overseas_country: str | None = None
    corner: bool = False

    @property
    def localities(self) -> list[str]:
        return [p for p in (self.suburb, self.city) if p]

    def query_line(self) -> str:
        base = f"{self.number}{self.suffix or ''} {self.road}" if self.number is not None and self.road else self.street
        parts = [base, self.suburb, self.city]
        text = ", ".join(p for p in parts if p)
        if self.postcode:
            text = f"{text} {self.postcode}" if text else self.postcode
        return f"{text}, New Zealand" if text else "New Zealand"


@dataclass(slots=True)
class SourceCharity:
    cc_number: str
    name: str
    registered: bool
    sector: str | None
    modified_on: datetime | None
    address: CleanAddress

    def db_row(self, synced_at: str, *, include_sector: bool = True) -> dict[str, Any]:
        a = self.address
        row = {
            "cc_number": self.cc_number,
            "name": self.name,
            "sector": self.sector,
            "address_raw": a.raw,
            "street": a.street,
            "suburb": a.suburb,
            "city": a.city,
            "postcode": a.postcode,
            "last_synced_at": synced_at,
        }
        if not include_sector:  # lookup failed this run: don't blank out stored sectors
            del row["sector"]
        return row


@dataclass(slots=True)
class Candidate:
    lon: float
    lat: float
    label: str
    source: str
    precision: Precision = "address"
    number: int | None = None
    suffix: str | None = None
    road: str | None = None
    suburb: str | None = None
    city: str | None = None
    unit: str | None = None
    score: float = 0.0


@dataclass(slots=True)
class GeocodeOutcome:
    status: Status
    lon: float | None = None
    lat: float | None = None
    reason: str | None = None
    source: str | None = None
    score: float = 0.0
    precision: Precision | None = None

    @property
    def has_point(self) -> bool:
        return self.lon is not None and self.lat is not None


# ---------------------------------------------------------------------------
# Text normalisation helpers
# ---------------------------------------------------------------------------

_PLACEHOLDERS = {"", "-", "--", ".", "n/a", "na", "nil", "none", "null", "tba", "tbc", "unknown", "not applicable"}
_NZ_NAMES = {"new zealand", "nz", "aotearoa", "new zealand aotearoa", "aotearoa new zealand", "n.z.", "nzl"}


def clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = unicodedata.normalize("NFC", str(value))
    text = re.sub(r"\s+", " ", text).strip(" ,;")
    return None if text.lower() in _PLACEHOLDERS else text


def ascii_fold(text: str) -> str:
    """Ōhope -> Ohope. LINZ's *_ascii columns are macron-free."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def is_nz_country(country: str | None) -> bool:
    if not country:
        return True
    return re.sub(r"[^a-z. ]", " ", country.lower()).strip() in _NZ_NAMES or "zealand" in country.lower()


_ROAD_TYPES: dict[str, str] = {
    "st": "Street", "str": "Street", "rd": "Road", "ave": "Avenue", "av": "Avenue", "dr": "Drive",
    "drv": "Drive", "pl": "Place", "tce": "Terrace", "terr": "Terrace", "cres": "Crescent",
    "cr": "Crescent", "hwy": "Highway", "ln": "Lane", "pde": "Parade", "blvd": "Boulevard",
    "cl": "Close", "ct": "Court", "crt": "Court", "gr": "Grove", "gdns": "Gardens",
    "hts": "Heights", "esp": "Esplanade", "sq": "Square", "wy": "Way", "prom": "Promenade",
}
_ROAD_WORDS = {
    "street", "road", "avenue", "drive", "place", "terrace", "crescent", "lane", "way", "highway",
    "parade", "quay", "close", "grove", "rise", "square", "boulevard", "esplanade", "mews", "track",
    "court", "heights", "view", "glade", "common", "loop", "row", "walk", "circle", "green", "mall",
    "promenade", "strand", "line", "valley", "gardens", "wharf", "access", "motorway", "crest",
    "ridge", "vale", "wynd", "path", "lookout", "bay", "place", "junction", "mount", "hill",
} | set(_ROAD_TYPES)

_GENERIC_ROAD_TOKENS = {
    "street", "road", "avenue", "drive", "place", "terrace", "crescent", "lane", "way", "highway",
    "parade", "quay", "close", "grove", "rise", "square", "boulevard", "the", "saint", "st", "mount",
    "mt", "north", "south", "east", "west", "upper", "lower", "old", "new", "state", "great", "little",
}


def expand_road(road: str) -> str:
    """'Queen St' -> 'Queen Street', 'SH 1' -> 'State Highway 1'. Leading 'St' (Saint) is kept."""
    road = road.strip(" .,")
    fix_case = road.isupper() or road.islower()  # decide before expansion adds capitals
    road = re.sub(r"^(?:s\.?h\.?)\s*(\d+[a-z]?)$", r"State Highway \1", road, flags=re.I)
    tokens = road.split()
    if len(tokens) >= 2:
        last = tokens[-1].rstrip(".").lower()
        if last in _ROAD_TYPES:
            tokens[-1] = _ROAD_TYPES[last]
    road = " ".join(tokens)
    if fix_case:
        road = re.sub(r"\b([A-Za-z])([A-Za-z']*)", lambda m: m.group(1).upper() + m.group(2).lower(), road)
        road = re.sub(r"\bMc([a-z])", lambda m: "Mc" + m.group(1).upper(), road)
    return road


def norm_road(road: str | None) -> str:
    if not road:
        return ""
    text = ascii_fold(expand_road(road)).lower()
    text = re.sub(r"[^a-z0-9 ]", " ", text)
    tokens = text.split()
    if tokens and tokens[0] in {"st", "saint"}:
        tokens[0] = "saint"
    if tokens and tokens[0] in {"mt", "mount"}:
        tokens[0] = "mount"
    return " ".join(tokens)


def norm_place(place: str | None) -> str:
    if not place:
        return ""
    text = ascii_fold(place).lower()
    text = re.sub(r"[^a-z0-9 ]", " ", text)
    tokens = [t for t in text.split() if t not in {"city", "central", "centre", "center", "cbd"}]
    tokens = ["saint" if t == "st" else "mount" if t == "mt" else t for t in tokens]
    return " ".join(tokens)


def similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def place_similarity(a: str | None, b: str | None) -> float:
    na, nb = norm_place(a), norm_place(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    ta, tb = set(na.split()), set(nb.split())
    if ta <= tb or tb <= ta:
        return 0.9
    return SequenceMatcher(None, na, nb).ratio()


def haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def in_nz(lon: float, lat: float) -> bool:
    return NZ_LAT_RANGE[0] <= lat <= NZ_LAT_RANGE[1] and (160.0 <= lon <= 180.0 or -180.0 <= lon <= -170.0)


def fix_axis_order(x: float, y: float) -> tuple[float, float]:
    """Return (lon, lat). NZ latitudes (-28..-53) and longitudes (160..180 / -170..-180)
    never overlap, so a WFS server answering in lat/lon order can be detected safely."""
    if -60 <= x <= -20 and (y >= 150 or y <= -150):
        return y, x
    return x, y


# ---------------------------------------------------------------------------
# Address cleaning
# ---------------------------------------------------------------------------

PO_BOX_RE = re.compile(r"\b(?:p\.?\s*o\.?\s*box|po\s*box|post\s*office\s*box|private\s+bag|locked\s+bag|box\s+\d+)\b", re.I)
RD_RE = re.compile(r"^(?:r\.?\s?d\.?|rural\s+delivery)\s*(\d+)$", re.I)
CARE_OF_RE = re.compile(r"^(?:c/-|c/o|c\\-|care\s+of|attn:?|attention:?)\s*", re.I)
PLACE_POSTCODE_RE = re.compile(r"^(?P<place>[^\d,]+?)\s+(?P<pc>\d{4})$")
POSTCODE_RE = re.compile(r"\b(\d{4})\b")
CORNER_RE = re.compile(r"^(?:cnr\.?|corner)(?:\s+of)?\s+(?P<a>.+?)\s+(?:and|&)\s+(?P<b>.+)$", re.I)
SUBPREMISE_RE = re.compile(
    r"""^(?:
          (?P<unit_kind>flat|unit|apartment|apt|villa|townhouse)\s*(?P<unit>[a-z]?\d+[a-z]?)
        | (?:suite|ste|shop|office|room|rm|kiosk)\s*[a-z]?\d+[a-z]?
        | (?:level|lvl|floor|flr|fl)\.?\s*(?:\d+[a-z]?|one|two|three|four|five|six|seven|eight|nine|ten|ground)\b
        | l\d{1,2}\b
        | (?:ground|first|second|third|fourth|fifth|sixth|top|lower|upper|mezzanine|basement)\s+(?:floor|level)
      )\s*(?:[,/\-]\s*)?""",
    re.I | re.X,
)
STREET_RE = re.compile(
    r"""^(?:(?P<unit>[a-z]?\d+[a-z]?)\s*/\s*)?        # 4/  or 4B/
         (?P<number>\d{1,6})(?P<suffix>[a-z])?        # 12 or 12A
         (?:\s*[-\u2013]\s*(?P<high>\d{1,6})[a-z]?)?  # 23-29
         \s+(?P<road>[^\d\s].*)$""",
    re.I | re.X,
)
_SEGMENT_SPLIT = re.compile(r"\s*[,;]\s*|\s+/\s+|(?<=[A-Za-z])/(?=[A-Za-z ])|(?<=\d)/(?=\s*[A-Za-z]{2,})")
_COUNTRY_HINTS = {
    "australia", "united states", "usa", "united kingdom", "uk", "england", "scotland", "wales",
    "canada", "fiji", "samoa", "tonga", "cook islands", "niue", "india", "china", "philippines",
    "singapore", "hong kong", "japan", "south africa", "germany", "france", "netherlands",
    "switzerland", "ireland", "papua new guinea", "vanuatu", "solomon islands", "kiribati",
}


def parse_street(line: str) -> dict[str, Any] | None:
    m = STREET_RE.match(line.strip())
    if not m or not re.search(r"[A-Za-z]{2,}", m.group("road")):
        return None
    return {
        "unit": m.group("unit"),
        "number": int(m.group("number")),
        "suffix": (m.group("suffix") or "").upper() or None,
        "number_high": int(m.group("high")) if m.group("high") else None,
        "road": expand_road(m.group("road")),
    }


def _looks_like_road(segment: str) -> bool:
    words = re.findall(r"[a-z]+", ascii_fold(segment).lower())
    return bool(words) and any(w in _ROAD_WORDS for w in words[-2:]) and len(words) <= 7


def _corner_road(segment: str) -> str | None:
    m = CORNER_RE.match(segment)
    if not m:
        return None
    first, second = m.group("a").strip(), m.group("b").strip()
    if not _looks_like_road(first):
        plural = re.search(r"\b(streets|roads|avenues|drives|places|terraces)\b", second, re.I)
        type_word = plural.group(1)[:-1].title() if plural else "Road"
        first = f"{first} {type_word}"
    return expand_road(first)


def build_address_raw(parts: Iterable[str | None]) -> str | None:
    out: list[str] = []
    for part in parts:
        if part and (not out or out[-1].lower() != part.lower()):
            out.append(part)
    return ", ".join(out) or None


def clean_address(
    line1: Any, line2: Any, suburb: Any, city: Any, postcode: Any, country: Any = None
) -> CleanAddress:
    l1, l2 = clean_text(line1), clean_text(line2)
    sub, cty, pc_field, ctry = clean_text(suburb), clean_text(city), clean_text(postcode), clean_text(country)

    overseas = ctry if ctry and not is_nz_country(ctry) and ascii_fold(ctry).lower().strip(" .") in _COUNTRY_HINTS else None
    raw = build_address_raw([l1, l2, sub, cty, pc_field, overseas])

    postcode_value = None
    if pc_field and (m := POSTCODE_RE.search(pc_field)):
        postcode_value = m.group(1)
    # "Auckland 1010" in the city field
    if cty and (m := PLACE_POSTCODE_RE.match(cty)):
        cty = m.group("place").strip()
        postcode_value = postcode_value or m.group("pc")
    if sub and RD_RE.match(sub):
        sub = None
    if sub and cty and sub.lower() == cty.lower():
        sub = None

    addr = CleanAddress(raw=raw, suburb=sub, city=cty, postcode=postcode_value, overseas_country=overseas)
    known_places = {p.lower() for p in (sub, cty) if p}

    numbered: dict[str, Any] | None = None
    unnumbered: str | None = None
    pending_unit: str | None = None

    for line in (l1, l2):
        if not line:
            continue
        for segment in _SEGMENT_SPLIT.split(line):
            seg = segment.strip(" .")
            if not seg:
                continue
            if PO_BOX_RE.search(seg):
                addr.po_box = True
                continue
            if m := RD_RE.match(seg):
                addr.rural_delivery = f"RD {m.group(1)}"
                continue
            if m := CARE_OF_RE.match(seg):  # "C/- 100 Malfroy Road" keeps the street
                seg = seg[m.end():].strip()
                if not seg:
                    continue
            if seg.lower() in known_places:
                continue
            if m := PLACE_POSTCODE_RE.match(seg):
                if m.group("place").strip().lower() in known_places or m.group("pc") == postcode_value:
                    addr.postcode = addr.postcode or m.group("pc")
                    continue
            while m := SUBPREMISE_RE.match(seg):
                if m.group("unit"):
                    pending_unit = m.group("unit").upper()
                seg = seg[m.end():].strip(" ,-/")
            if not seg:
                continue
            if numbered is None and (parsed := parse_street(seg)):
                numbered = parsed
                continue
            if unnumbered is None:
                if corner := _corner_road(seg):
                    unnumbered, addr.corner = corner, True
                elif _looks_like_road(seg) and not re.search(r"\d{3,}", seg):
                    unnumbered = expand_road(seg)

    if numbered:
        addr.unit = numbered["unit"] or pending_unit
        addr.number, addr.suffix = numbered["number"], numbered["suffix"]
        addr.number_high, addr.road = numbered["number_high"], numbered["road"]
        number_text = f"{addr.number}{addr.suffix or ''}"
        if addr.number_high:
            number_text += f"-{addr.number_high}"
        addr.street = f"{addr.unit + '/' if addr.unit else ''}{number_text} {addr.road}"
    elif unnumbered:
        addr.road = unnumbered
        addr.street = unnumbered
    return addr


def address_from_row(row: dict[str, Any]) -> CleanAddress:
    """Rebuild a CleanAddress from stored columns (for records queued in earlier runs)."""
    raw = row.get("address_raw")
    addr = CleanAddress(
        raw=raw, street=row.get("street"), suburb=row.get("suburb"),
        city=row.get("city"), postcode=row.get("postcode"),
    )
    if addr.street and (parsed := parse_street(addr.street)):
        addr.unit, addr.number, addr.suffix = parsed["unit"], parsed["number"], parsed["suffix"]
        addr.number_high, addr.road = parsed["number_high"], parsed["road"]
    elif addr.street:
        addr.road = addr.street
    if raw:
        addr.po_box = bool(PO_BOX_RE.search(raw))
        tail = raw.rsplit(",", 1)[-1].strip().lower()
        if tail in _COUNTRY_HINTS:
            addr.overseas_country = raw.rsplit(",", 1)[-1].strip()
    return addr


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------


class ProviderError(Exception):
    """A geocoder or API call failed in a way worth recording."""


class ProviderAuthError(ProviderError):
    """Credentials were rejected — disable the provider for the rest of the run."""


class RateLimiter:
    def __init__(self, min_interval_s: float) -> None:
        self.min_interval = min_interval_s
        self._lock = threading.Lock()
        self._next = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            delay = self._next - now
            self._next = max(now, self._next) + self.min_interval
        if delay > 0:
            time.sleep(delay)


def request_json(
    client: httpx.Client,
    url: str,
    *,
    params: dict[str, str] | None = None,
    headers: dict[str, str] | None = None,
    attempts: int = 3,
    limiter: RateLimiter | None = None,
    what: str = "request",
) -> Any:
    last_error = "unknown error"
    for attempt in range(1, attempts + 1):
        if limiter:
            limiter.wait()
        delay = 2.0 ** attempt
        try:
            response = client.get(url, params=params, headers=headers)
        except httpx.TimeoutException:
            last_error = f"{what} timed out"
        except httpx.TransportError as exc:
            last_error = f"{what} network error ({type(exc).__name__})"
        else:
            if response.status_code in (401, 403):
                raise ProviderAuthError(f"{what} rejected the credentials (HTTP {response.status_code})")
            if response.status_code == 429 or response.status_code >= 500:
                last_error = f"{what} HTTP {response.status_code}"
                retry_after = response.headers.get("retry-after", "")
                if retry_after.isdigit():
                    delay = min(float(retry_after), 60.0)
            elif response.status_code >= 400:
                raise ProviderError(f"{what} HTTP {response.status_code}: {response.text[:160].strip()}")
            else:
                try:
                    return response.json()
                except ValueError:
                    raise ProviderError(f"{what} returned non-JSON: {response.text[:160].strip()}") from None
        if attempt < attempts:
            time.sleep(delay)
    raise ProviderError(last_error)


# ---------------------------------------------------------------------------
# Charities Services OData
# ---------------------------------------------------------------------------


def odata_results(payload: Any) -> list[dict[str, Any]]:
    """Handle OData v2 verbose ({d: {results}} / {d: [...]}) and v3+ light ({value: [...]})."""
    if isinstance(payload, dict):
        if "d" in payload:
            inner = payload["d"]
            if isinstance(inner, dict):
                return list(inner.get("results") or [])
            return list(inner or [])
        if "value" in payload:
            return list(payload["value"] or [])
    if isinstance(payload, list):
        return payload
    raise ValueError("Unrecognised OData payload")


_MS_DATE_RE = re.compile(r"/Date\((-?\d+)(?:[+-]\d{4})?\)/")


def parse_odata_datetime(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    text = str(value)
    if m := _MS_DATE_RE.search(text):
        return datetime.fromtimestamp(int(m.group(1)) / 1000, tz=UTC)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def odata_datetime_literal(ts: datetime) -> str:
    return f"datetime'{ts.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%S')}'"


def fetch_organisations(
    client: httpx.Client, *, since: datetime | None, registered_only: bool, limit: int | None = None
) -> Iterator[dict[str, Any]]:
    """Keyset pagination on OrganisationId: robust to the service's 1000-row cap and to
    records changing between pages (no $skip drift)."""
    last_id, yielded = 0, 0
    while True:
        clauses = [f"OrganisationId gt {last_id}"]
        if registered_only:
            clauses.append("RegistrationStatus eq 'Registered'")
        if since:
            clauses.append(f"ModifiedOn gt {odata_datetime_literal(since)}")
        params = {
            "$filter": " and ".join(clauses),
            "$orderby": "OrganisationId",
            "$top": str(ODATA_PAGE_SIZE),
            "$select": ",".join(ODATA_FIELDS),
            "$format": "json",
        }
        page = odata_results(request_json(
            client, f"{ODATA_BASE}/Organisations", params=params,
            headers={"Accept": "application/json"}, attempts=4, what="Charities OData",
        ))
        if not page:
            return
        for record in page:
            yield record
            yielded += 1
            if limit and yielded >= limit:
                return
        last_id = max(int(r["OrganisationId"]) for r in page)
        log.info("  …fetched %s organisations (last OrganisationId %s)", yielded, last_id)


def fetch_sector_names(client: httpx.Client) -> dict[int, str]:
    override = os.environ.get("SECTOR_NAMES_JSON")
    if override:
        return {int(k): str(v) for k, v in json.loads(override).items()}
    try:
        rows = odata_results(request_json(
            client, f"{ODATA_BASE}/Sectors", params={"$format": "json"},
            headers={"Accept": "application/json"}, what="Charities OData sectors",
        ))
    except (ProviderError, ValueError) as exc:
        log.warning("Sector lookup unavailable (%s) — sectors will be left blank", exc)
        return {}
    return sector_lookup_from_rows(rows)


def sector_lookup_from_rows(rows: list[dict[str, Any]]) -> dict[int, str]:
    """The lookup entity's column names aren't documented, so detect them: the integer
    key ending in 'Id' and the most name-like string column."""
    lookup: dict[int, str] = {}
    for row in rows:
        fields = {k: v for k, v in row.items() if not k.startswith("__")}
        key = next((v for k, v in fields.items() if k.lower() in {"sectorid", "id"} and isinstance(v, int)), None)
        if key is None:
            key = next((v for k, v in fields.items() if k.lower().endswith("id") and isinstance(v, int)), None)
        name = next(
            (fields[k].strip() for k in ("Name", "SectorName", "Description", "Sector", "Title")
             if isinstance(fields.get(k), str) and fields[k].strip()),
            None,
        )
        if name is None:
            name = next((v.strip() for v in fields.values() if isinstance(v, str) and v.strip()), None)
        if key is not None and name:
            lookup[key] = name
    return lookup


def to_source_charity(record: dict[str, Any], sectors: dict[int, str]) -> SourceCharity | None:
    cc = (clean_text(record.get("CharityRegistrationNumber")) or "").upper().replace(" ", "")
    name = clean_text(record.get("Name"))
    if not re.fullmatch(r"CC\d+", cc) or not name:
        return None
    sector_id = record.get("MainSectorId")
    try:
        sector = sectors.get(int(sector_id)) if sector_id not in (None, "") else None
    except (TypeError, ValueError):
        sector = None
    status = (record.get("RegistrationStatus") or "Registered").strip().lower()
    return SourceCharity(
        cc_number=cc,
        name=name,
        registered=status == "registered",
        sector=sector,
        modified_on=parse_odata_datetime(record.get("ModifiedOn")),
        address=clean_address(
            record.get("StreetAddressLine1"), record.get("StreetAddressLine2"),
            record.get("StreetAddressSuburb"), record.get("StreetAddressCity"),
            record.get("StreetAddressPostcode"), record.get("StreetAddressCountry"),
        ),
    )


# ---------------------------------------------------------------------------
# Scoring & decisions (shared by all providers)
# ---------------------------------------------------------------------------


def locality_score(addr: CleanAddress, cand_suburb: str | None, cand_city: str | None) -> float:
    wanted = addr.localities
    if not wanted:
        return 0.5  # nothing to confirm or contradict
    best = max(
        (place_similarity(w, c) for w in wanted for c in (cand_suburb, cand_city) if c),
        default=0.0,
    )
    if best >= 0.9:
        return 1.0
    if best >= 0.75:
        return 0.6
    return 0.0


def score_candidate(addr: CleanAddress, cand: Candidate) -> float:
    """0..1. Road name 0.45, house number 0.20 + suffix 0.05, locality 0.30."""
    score = 0.45 * similarity(norm_road(addr.road), norm_road(cand.road))
    if addr.number is not None and cand.number is not None:
        in_range = addr.number_high and addr.number <= cand.number <= addr.number_high
        if cand.number == addr.number or in_range:
            score += 0.20
            if (addr.suffix or "").upper() == (cand.suffix or "").upper():
                score += 0.05
    score += 0.30 * locality_score(addr, cand.suburb, cand.city)
    return round(score, 3)


def decide(addr: CleanAddress, candidates: list[Candidate]) -> GeocodeOutcome | None:
    cands = [c for c in candidates if in_nz(c.lon, c.lat)]
    if not cands:
        return None
    for c in cands:
        c.score = score_candidate(addr, c)
    # Highest score first; among equals prefer the base address over a unit.
    cands.sort(key=lambda c: (-c.score, c.unit is not None))
    best = cands[0]
    rivals = [
        c for c in cands[1:]
        if c.score >= best.score - AMBIGUITY_MARGIN
        and haversine_m(best.lon, best.lat, c.lon, c.lat) > AMBIGUITY_DISTANCE_M
    ]
    where = ", ".join(p for p in (best.suburb, best.city) if p)

    if best.precision == "address" and best.score >= SUCCESS_THRESHOLD and not rivals:
        return GeocodeOutcome("SUCCESS", best.lon, best.lat, None, best.source, best.score, "address")
    if rivals:
        places = sorted({", ".join(p for p in (c.suburb, c.city) if p) or c.label for c in [best, *rivals]})
        hint = "" if best.score >= SUCCESS_THRESHOLD else " and none clearly matches the register's suburb/town"
        return GeocodeOutcome(
            "NEEDS_REVIEW", best.lon, best.lat,
            f"Ambiguous match: {len(places)} places have '{addr.street}'{hint} ({'; '.join(places[:4])})",
            best.source, best.score, best.precision,
        )
    return GeocodeOutcome(
        "NEEDS_REVIEW", best.lon, best.lat,
        f"Low-confidence match (score {best.score:.2f}): closest was '{best.label}'" + (f" in {where}" if where and where not in best.label else ""),
        best.source, best.score, best.precision,
    )


# ---------------------------------------------------------------------------
# Geocoders
# ---------------------------------------------------------------------------


class Geocoder:
    name = "geocoder"

    def geocode(self, addr: CleanAddress) -> GeocodeOutcome | None:  # pragma: no cover - interface
        raise NotImplementedError


def _cql(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


class LinzGeocoder(Geocoder):
    """LINZ NZ Addresses via the LDS WFS (GeoServer CQL). Authoritative for NZ street addresses."""

    name = "linz"

    def __init__(self, client: httpx.Client, api_key: str, layer: str = "123113") -> None:
        self.client = client
        self.url = LINZ_WFS.format(key=api_key)
        self.type_name = f"layer-{layer}"
        self.limiter = RateLimiter(0.25)

    def _query(self, cql: str, count: int = 50) -> list[Candidate]:
        payload = request_json(
            self.client, self.url,
            params={
                "service": "WFS", "version": "2.0.0", "request": "GetFeature",
                "typeNames": self.type_name, "outputFormat": "application/json",
                "srsName": "EPSG:4326", "count": str(count), "cql_filter": cql,
            },
            limiter=self.limiter, what="LINZ",
        )
        return self.parse(payload)

    @staticmethod
    def parse(payload: Any) -> list[Candidate]:
        out: list[Candidate] = []
        for feature in (payload or {}).get("features", []):
            geom = feature.get("geometry") or {}
            coords = geom.get("coordinates")
            if geom.get("type") == "MultiPoint" and coords:
                coords = coords[0]
            if not coords or len(coords) < 2:
                continue
            lon, lat = fix_axis_order(float(coords[0]), float(coords[1]))
            p = feature.get("properties") or {}
            number = p.get("address_number")
            out.append(Candidate(
                lon=lon, lat=lat,
                label=p.get("full_address") or p.get("full_address_ascii") or "",
                source="linz", precision="address",
                number=int(number) if isinstance(number, (int, float)) or str(number or "").isdigit() else None,
                suffix=p.get("address_number_suffix") or None,
                road=p.get("full_road_name_ascii") or p.get("full_road_name"),
                suburb=p.get("suburb_locality_ascii") or p.get("suburb_locality"),
                city=p.get("town_city_ascii") or p.get("town_city"),
                unit=p.get("unit") or p.get("unit_value") or None,
            ))
        return out

    def _locality_clause(self, addr: CleanAddress) -> str | None:
        terms = []
        for place in addr.localities:
            folded = ascii_fold(place)
            terms.append(f"suburb_locality_ascii ILIKE {_cql(folded)}")
            terms.append(f"town_city_ascii ILIKE {_cql(folded)}")
        return f"({' OR '.join(terms)})" if terms else None

    def geocode(self, addr: CleanAddress) -> GeocodeOutcome | None:
        if not addr.road:
            return None
        road = ascii_fold(addr.road)
        locality = self._locality_clause(addr)

        if addr.number is not None:
            # 1) exact road name + number (usually 1–10 hits nationwide)
            outcome = decide(addr, self._query(
                f"address_number={addr.number} AND full_road_name_ascii ILIKE {_cql(road)}"))
            if outcome and outcome.status == "SUCCESS":
                return outcome
            # 2) fuzzy road name within the locality (St/Saint, typos, missing road type)
            core = max((t for t in re.findall(r"[A-Za-z]{3,}", road) if t.lower() not in _GENERIC_ROAD_TOKENS),
                       key=len, default=None)
            if core and locality:
                fuzzy = decide(addr, self._query(
                    f"address_number={addr.number} AND full_road_name_ascii ILIKE {_cql('%' + core + '%')} AND {locality}"))
                if fuzzy and (outcome is None or fuzzy.score > outcome.score):
                    outcome = fuzzy
            if outcome and (outcome.status == "SUCCESS" or outcome.score >= 0.6):
                return outcome
            return self._street_level(addr, road, locality) or outcome

        return self._street_level(addr, road, locality)

    def _street_level(self, addr: CleanAddress, road: str, locality: str | None) -> GeocodeOutcome | None:
        """No house number match: place the pin mid-street (always NEEDS_REVIEW)."""
        if not locality:
            return None
        points = self._query(f"full_road_name_ascii ILIKE {_cql(road)} AND {locality}", count=200)
        points = [p for p in points if in_nz(p.lon, p.lat)]
        if not points:
            return None
        lon, lat = median(p.lon for p in points), median(p.lat for p in points)
        mid = min(points, key=lambda p: haversine_m(lon, lat, p.lon, p.lat))
        where = ", ".join(x for x in (mid.suburb, mid.city) if x)
        if addr.corner:
            reason = f"Street corner — placed on {addr.road}, {where}; confirm the exact spot"
        elif addr.number is not None:
            reason = f"House number {addr.number}{addr.suffix or ''} not found on {addr.road} — placed mid-street in {where}"
        else:
            reason = f"No street number on the register — placed mid-street on {addr.road}, {where}"
        return GeocodeOutcome("NEEDS_REVIEW", mid.lon, mid.lat, reason, "linz", 0.5, "street")


class PhotonGeocoder(Geocoder):
    """Photon (komoot) over OpenStreetMap — keyless; fair use only, so throttled to 1 req/s."""

    name = "photon"

    def __init__(self, client: httpx.Client, user_agent: str) -> None:
        self.client = client
        self.headers = {"User-Agent": user_agent}
        self.limiter = RateLimiter(1.0)

    def _search(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        payload = request_json(
            self.client, PHOTON_URL,
            params={"q": query, "limit": str(limit), "lang": "en", "bbox": "165.8,-47.4,178.9,-34.0"},
            headers=self.headers, limiter=self.limiter, what="Photon",
        )
        return [f for f in (payload or {}).get("features", [])
                if (f.get("properties") or {}).get("countrycode", "").upper() == "NZ"]

    @staticmethod
    def to_candidate(feature: dict[str, Any]) -> Candidate | None:
        coords = (feature.get("geometry") or {}).get("coordinates") or []
        if len(coords) < 2:
            return None
        p = feature.get("properties") or {}
        number_text = str(p.get("housenumber") or "")
        m = re.match(r"^(?:[a-z]?\d+[a-z]?/)?(\d+)([a-z]?)", number_text, re.I)
        kind = p.get("type")
        precision: Precision = "address" if kind == "house" and m else "street" if kind == "street" else "locality"
        label = ", ".join(str(x) for x in (
            f"{number_text} {p.get('street', '')}".strip() if number_text else (p.get("street") or p.get("name")),
            p.get("district") or p.get("locality"), p.get("city"),
        ) if x)
        return Candidate(
            lon=float(coords[0]), lat=float(coords[1]), label=label or str(p.get("name", "")),
            source="photon", precision=precision,
            number=int(m.group(1)) if m else None, suffix=(m.group(2) or None) if m else None,
            road=p.get("street") or (p.get("name") if kind == "street" else None),
            suburb=p.get("district") or p.get("locality")
            or (p.get("name") if kind in {"district", "locality", "city"} else None),
            city=p.get("city") or p.get("county"),
        )

    def geocode(self, addr: CleanAddress) -> GeocodeOutcome | None:
        if not addr.street:
            return None
        cands = [c for f in self._search(addr.query_line()) if (c := self.to_candidate(f))]
        return decide(addr, cands)

    def locality(self, addr: CleanAddress) -> Candidate | None:
        query = ", ".join(addr.localities) or addr.postcode
        if not query:
            return None
        for feature in self._search(f"{query}, New Zealand", limit=3):
            cand = self.to_candidate(feature)
            if cand and in_nz(cand.lon, cand.lat):
                return cand
        return None


class NominatimGeocoder(Geocoder):
    """Nominatim structured search. Usage policy: max 1 req/s, identify yourself, cache results."""

    name = "nominatim"

    def __init__(self, client: httpx.Client, user_agent: str) -> None:
        self.client = client
        self.headers = {"User-Agent": user_agent}
        self.limiter = RateLimiter(1.1)

    def geocode(self, addr: CleanAddress) -> GeocodeOutcome | None:
        if not addr.street:
            return None
        params = {"street": addr.street, "country": "New Zealand", "format": "jsonv2",
                  "addressdetails": "1", "limit": "5", "countrycodes": "nz"}
        if addr.city or addr.suburb:
            params["city"] = addr.city or addr.suburb or ""
        if addr.postcode:
            params["postalcode"] = addr.postcode
        rows = request_json(self.client, NOMINATIM_URL, params=params, headers=self.headers,
                            limiter=self.limiter, what="Nominatim") or []
        cands: list[Candidate] = []
        for r in rows:
            a = r.get("address") or {}
            m = re.match(r"^(?:[a-z]?\d+[a-z]?/)?(\d+)([a-z]?)", str(a.get("house_number") or ""), re.I)
            cands.append(Candidate(
                lon=float(r["lon"]), lat=float(r["lat"]), label=r.get("display_name", ""),
                source="nominatim", precision="address" if int(r.get("place_rank", 0)) >= 30 and m else "street",
                number=int(m.group(1)) if m else None, suffix=(m.group(2) or None) if m else None,
                road=a.get("road"), suburb=a.get("suburb") or a.get("village") or a.get("hamlet"),
                city=a.get("city") or a.get("town") or a.get("village"),
            ))
        return decide(addr, cands)


class GeocoderChain:
    """Runs providers in order, keeps the best outcome, and never raises."""

    def __init__(self, providers: list[Geocoder], photon: PhotonGeocoder | None) -> None:
        self.providers = providers
        self.photon = photon  # for locality-level fallbacks
        self.disabled: set[str] = set()
        self.failures: dict[str, int] = {}
        self._cache: dict[tuple[Any, ...], GeocodeOutcome] = {}
        self._lock = threading.Lock()

    def _key(self, addr: CleanAddress) -> tuple[Any, ...]:
        return (norm_road(addr.street), norm_place(addr.suburb), norm_place(addr.city), addr.postcode)

    def geocode(self, addr: CleanAddress) -> GeocodeOutcome:
        key = self._key(addr)
        with self._lock:
            if key in self._cache:
                return self._cache[key]
        outcome = self._geocode(addr)
        with self._lock:
            self._cache[key] = outcome
        return outcome

    def _geocode(self, addr: CleanAddress) -> GeocodeOutcome:
        if addr.overseas_country:
            return GeocodeOutcome("NEEDS_REVIEW", reason=f"Street address is outside New Zealand ({addr.overseas_country})")
        if not addr.street:
            reason = ("PO Box only — no street address on the register" if addr.po_box
                      else "No street address on the register")
            return self._with_locality_hint(addr, reason)

        best: GeocodeOutcome | None = None
        errors: list[str] = []
        for provider in self.providers:
            if provider.name in self.disabled:
                continue
            try:
                outcome = provider.geocode(addr)
            except ProviderAuthError as exc:
                log.error("%s — disabling %s for this run", exc, provider.name)
                self.disabled.add(provider.name)
                errors.append(str(exc))
                continue
            except ProviderError as exc:
                errors.append(str(exc))
                with self._lock:
                    self.failures[provider.name] = self.failures.get(provider.name, 0) + 1
                    if self.failures[provider.name] >= 25:
                        log.error("%s failed 25 times in a row — disabling it for this run", provider.name)
                        self.disabled.add(provider.name)
                continue
            except Exception as exc:  # a bug in one provider must not stop the run
                log.exception("Unexpected %s error for %r", provider.name, addr.street)
                errors.append(f"{provider.name} error: {type(exc).__name__}")
                continue
            with self._lock:
                self.failures[provider.name] = 0
            if outcome is None:
                continue
            if outcome.status == "SUCCESS":
                return outcome
            if best is None or _rank(outcome) > _rank(best):
                best = outcome

        if best:
            return best
        if errors:
            return self._with_locality_hint(addr, "Geocoder unavailable: " + "; ".join(dict.fromkeys(errors)))
        return self._with_locality_hint(addr, f"Address not found: '{addr.street}'")

    def _with_locality_hint(self, addr: CleanAddress, reason: str) -> GeocodeOutcome:
        """Give the triage map a sensible starting point (suburb/town centre)."""
        if self.photon and self.photon.name not in self.disabled and addr.localities:
            try:
                cand = self.photon.locality(addr)
            except ProviderError:
                cand = None
            if cand:
                return GeocodeOutcome("NEEDS_REVIEW", cand.lon, cand.lat,
                                      f"{reason} (pin is the {cand.label or 'locality'} centre)",
                                      "photon", 0.2, "locality")
        return GeocodeOutcome("NEEDS_REVIEW", reason=reason)


def _rank(outcome: GeocodeOutcome) -> float:
    if not outcome.has_point:
        return -1.0
    return outcome.score + {"address": 0.1, "street": 0.05}.get(outcome.precision or "", 0.0)


def build_geocoder(client: httpx.Client, names: list[str], contact: str) -> GeocoderChain:
    user_agent = f"nz-charities-map-sync/1.0 (+{contact})"
    providers: list[Geocoder] = []
    photon: PhotonGeocoder | None = None
    for name in names:
        if name == "linz":
            key = os.environ.get("LINZ_API_KEY", "").strip()
            if key:
                providers.append(LinzGeocoder(client, key, os.environ.get("LINZ_ADDRESS_LAYER", "123113")))
            else:
                log.warning("LINZ_API_KEY not set — skipping LINZ (results will be less precise)")
        elif name == "photon":
            photon = PhotonGeocoder(client, user_agent)
            providers.append(photon)
        elif name == "nominatim":
            providers.append(NominatimGeocoder(client, user_agent))
        elif name and name != "none":
            raise SystemExit(f"Unknown geocoder '{name}' (expected linz, photon, nominatim)")
    return GeocoderChain(providers, photon)


def outcome_to_result(cc_number: str, address_raw: str | None, outcome: GeocodeOutcome) -> dict[str, Any]:
    if outcome.status == "SUCCESS" and not outcome.has_point:  # defensive: DB constraint would reject it
        outcome = GeocodeOutcome("NEEDS_REVIEW", reason="Internal error: success without a point")
    return {
        "cc_number": cc_number,
        "address_raw": address_raw,
        "lon": round(outcome.lon, 7) if outcome.lon is not None else None,
        "lat": round(outcome.lat, 7) if outcome.lat is not None else None,
        "status": outcome.status,
        "error": None if outcome.status == "SUCCESS" else (outcome.reason or "Needs review")[:500],
    }


# ---------------------------------------------------------------------------
# Supabase I/O
# ---------------------------------------------------------------------------


def make_supabase():
    from supabase import ClientOptions, create_client  # imported lazily so tests don't need it

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
    return create_client(url, key, options=ClientOptions(
        auto_refresh_token=False, persist_session=False, postgrest_client_timeout=120))


def chunks(items: list[Any], size: int) -> Iterator[list[Any]]:
    for i in range(0, len(items), size):
        yield items[i:i + size]


def last_watermark(sb) -> datetime | None:
    res = (sb.table("sync_runs").select("source_watermark").eq("status", "succeeded")
           .not_.is_("source_watermark", "null").order("started_at", desc=True).limit(1).execute())
    return parse_odata_datetime(res.data[0]["source_watermark"]) if res.data else None


def upsert_charities(sb, rows: list[dict[str, Any]]) -> int:
    from postgrest.types import ReturnMethod

    for batch in chunks(rows, UPSERT_BATCH):
        sb.table("charities").upsert(batch, on_conflict="cc_number", returning=ReturnMethod.minimal).execute()
    return len(rows)


def delete_charities(sb, cc_numbers: list[str]) -> int:
    for batch in chunks(sorted(cc_numbers), 150):
        sb.table("charities").delete().in_("cc_number", batch).execute()
    return len(cc_numbers)


def all_cc_numbers(sb) -> set[str]:
    out: set[str] = set()
    start = 0
    while True:
        res = sb.table("charities").select("cc_number").order("cc_number").range(start, start + 999).execute()
        out.update(r["cc_number"] for r in res.data)
        if len(res.data) < 1000:
            return out
        start += 1000


def queued_rows(sb, *, retry_review: bool, limit: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    while len(rows) < limit:
        q = sb.table("charities").select("cc_number,name,address_raw,street,suburb,city,postcode,geocode_status")
        q = q.or_("geocode_status.is.null,geocode_status.eq.NEEDS_REVIEW") if retry_review else q.is_("geocode_status", "null")
        page_size = min(1000, limit - len(rows))
        res = (q.order("geocode_status", desc=True, nullsfirst=True).order("last_synced_at", desc=True)
               .order("cc_number").range(len(rows), len(rows) + page_size - 1).execute())
        rows.extend(res.data)
        if len(res.data) < page_size:
            break
    return rows


def apply_results(sb, results: list[dict[str, Any]]) -> int:
    if not results:
        return 0
    res = sb.rpc("apply_geocode_results", {"p_results": results}).execute()
    return int(res.data or 0)


def publish_snapshot(sb) -> None:
    try:
        data = sb.rpc("get_charities_in_view", NZ_VIEW_BOUNDS).execute().data
        body = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode()
        sb.storage.from_("public-data").upload(
            "charities.json", body,
            file_options={"content-type": "application/json", "cache-control": "300", "upsert": "true"},
        )
        log.info("Published snapshot: %s charities, %.0f KB", data.get("count"), len(body) / 1024)
    except Exception as exc:  # the snapshot is an optimisation — never fail the sync over it
        log.warning("Snapshot not published: %s", exc)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


@dataclass
class RunStats:
    fetched: int = 0
    upserted: int = 0
    deleted: int = 0
    geocoded: int = 0
    succeeded: int = 0
    needs_review: int = 0
    reasons: dict[str, int] = field(default_factory=dict)

    def record(self, outcome: GeocodeOutcome) -> None:
        self.geocoded += 1
        if outcome.status == "SUCCESS":
            self.succeeded += 1
        else:
            self.needs_review += 1
            bucket = reason_bucket(outcome.reason)
            self.reasons[bucket] = self.reasons.get(bucket, 0) + 1


_REASON_BUCKETS = (
    ("Ambiguous", "Ambiguous match"), ("Low-confidence", "Low-confidence match"),
    ("House number", "House number not found"), ("Street corner", "Street corner"),
    ("No street number", "No street number"), ("PO Box", "PO Box only"),
    ("No street address", "No street address"), ("Street address is outside", "Overseas address"),
    ("Geocoder unavailable", "Geocoder unavailable"), ("Address not found", "Address not found"),
)


def reason_bucket(reason: str | None) -> str:
    text = reason or ""
    return next((label for prefix, label in _REASON_BUCKETS if text.startswith(prefix)), "Other")


def read_csv_source(path: str) -> Iterator[dict[str, Any]]:
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for i, row in enumerate(csv.DictReader(fh), start=1):
            row.setdefault("OrganisationId", i)
            row.setdefault("RegistrationStatus", "Registered")
            yield row


def geocode_many(
    chain: GeocoderChain, items: list[tuple[str, CleanAddress]], *, workers: int, deadline: float,
    on_result, stats: RunStats,
) -> None:
    """Geocode concurrently (providers rate-limit themselves); stop taking new work at the deadline."""
    queue = iter(items)
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        running: dict[Future[GeocodeOutcome], tuple[str, CleanAddress]] = {}

        def submit_next() -> bool:
            if time.monotonic() >= deadline:
                return False
            try:
                cc, addr = next(queue)
            except StopIteration:
                return False
            running[pool.submit(chain.geocode, addr)] = (cc, addr)
            return True

        for _ in range(max(1, workers) * 2):
            if not submit_next():
                break
        while running:
            done, _ = wait(list(running), return_when=FIRST_COMPLETED)
            for fut in done:
                cc, addr = running.pop(fut)
                try:
                    outcome = fut.result()
                except Exception as exc:  # GeocoderChain shouldn't raise, but be certain
                    outcome = GeocodeOutcome("NEEDS_REVIEW", reason=f"Geocoding crashed: {type(exc).__name__}")
                stats.record(outcome)
                on_result(cc, addr, outcome)
                submit_next()
        if time.monotonic() >= deadline:
            log.warning("Time budget reached — remaining records stay queued for the next run")


def write_step_summary(mode: str, stats: RunStats, watermark: datetime | None, dry_run: bool) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    lines = [
        f"### Charities sync ({mode}{', dry run' if dry_run else ''})",
        "",
        "| Metric | Count |", "|---|---:|",
        f"| Fetched from register | {stats.fetched:,} |",
        f"| Upserted | {stats.upserted:,} |",
        f"| Deleted (deregistered) | {stats.deleted:,} |",
        f"| Geocoded | {stats.geocoded:,} |",
        f"| → Success | {stats.succeeded:,} |",
        f"| → Needs review | {stats.needs_review:,} |",
        "",
        f"Source watermark: `{watermark.isoformat() if watermark else 'n/a'}`",
    ]
    if stats.reasons:
        lines += ["", "| Review reason | Count |", "|---|---:|"]
        lines += [f"| {k} | {v:,} |" for k, v in sorted(stats.reasons.items(), key=lambda kv: -kv[1])]
    with open(path, "a", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--mode", choices=["incremental", "full"], default="incremental")
    p.add_argument("--since", help="ISO timestamp; overrides the stored watermark (incremental mode)")
    p.add_argument("--overlap-hours", type=float, default=48.0,
                   help="re-read this much before the watermark (the register's timestamps have no zone)")
    p.add_argument("--max-geocode", type=int, default=3000, help="geocoding budget for this run")
    p.add_argument("--time-budget-minutes", type=float, default=150.0)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--retry-review", action="store_true", help="also re-geocode NEEDS_REVIEW records")
    p.add_argument("--geocoders", default=os.environ.get("GEOCODERS", "linz,photon"))
    p.add_argument("--publish-snapshot", action="store_true", help="upload public-data/charities.json")
    p.add_argument("--force-prune", action="store_true", help="prune even if the register looks truncated")
    p.add_argument("--dry-run", action="store_true", help="fetch + geocode + print; write nothing")
    p.add_argument("--limit", type=int, help="only process the first N source records (testing)")
    p.add_argument("--source-csv", help="read records from a CSV export instead of the OData API")
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)

    started = time.monotonic()
    deadline = started + args.time_budget_minutes * 60
    contact = os.environ.get("GEOCODER_CONTACT", "https://github.com/your-org/nz-charities-map")
    http = httpx.Client(
        timeout=httpx.Timeout(connect=10.0, read=90.0, write=30.0, pool=30.0),
        headers={"User-Agent": f"Mozilla/5.0 (compatible; nz-charities-map-sync/1.0; +{contact})"},
        follow_redirects=True,
    )
    chain = build_geocoder(http, [g.strip().lower() for g in args.geocoders.split(",")], contact)
    stats = RunStats()
    sb = None if args.dry_run else make_supabase()
    run_id: int | None = None

    try:
        # ---- 1. Where to start ------------------------------------------------------
        since: datetime | None = None
        if args.mode == "incremental" and not args.source_csv:
            if args.since:
                since = parse_odata_datetime(args.since)
            elif sb is not None and (wm := last_watermark(sb)):
                since = wm - timedelta(hours=args.overlap_hours)
            if since is None:
                log.info("No previous successful run — falling back to a full sync")
                args.mode = "full"
        if sb is not None:
            run_id = sb.table("sync_runs").insert({"mode": args.mode}).execute().data[0]["id"]
        log.info("Mode: %s%s", args.mode, f" (changes since {since.isoformat()})" if since else "")

        # ---- 2. Fetch + clean ---------------------------------------------------------
        sectors = {} if args.source_csv else fetch_sector_names(http)
        if sectors:
            log.info("Loaded %s sector names", len(sectors))
        raw_records: Iterable[dict[str, Any]] = (
            read_csv_source(args.source_csv) if args.source_csv
            else fetch_organisations(http, since=since, registered_only=args.mode == "full", limit=args.limit)
        )
        registered: dict[str, SourceCharity] = {}
        deregistered: set[str] = set()
        watermark: datetime | None = None
        for record in raw_records:
            charity = to_source_charity(record, sectors)
            if charity is None:
                continue
            stats.fetched += 1
            if charity.modified_on and (watermark is None or charity.modified_on > watermark):
                watermark = charity.modified_on
            if charity.registered:
                registered[charity.cc_number] = charity
            else:
                deregistered.add(charity.cc_number)
            if args.limit and stats.fetched >= args.limit:
                break
        log.info("Fetched %s records: %s registered, %s no longer registered",
                 stats.fetched, len(registered), len(deregistered))

        # ---- Dry run: geocode in memory and print ------------------------------------
        if args.dry_run:
            items = [(c.cc_number, c.address) for c in registered.values()][: args.max_geocode]

            def show(cc: str, addr: CleanAddress, o: GeocodeOutcome) -> None:
                point = f"{o.lat:.5f},{o.lon:.5f}" if o.has_point else "-"
                print(f"{cc:<9} {o.status:<12} {point:<21} {addr.street or '(no street)'}"
                      f"{' | ' + o.reason if o.reason else ''}")

            if chain.providers:
                geocode_many(chain, items, workers=args.workers, deadline=deadline, on_result=show, stats=stats)
            else:
                for cc, addr in items:
                    print(f"{cc:<9} street={addr.street!r} suburb={addr.suburb!r} city={addr.city!r} "
                          f"postcode={addr.postcode!r} po_box={addr.po_box} rd={addr.rural_delivery!r}")
            write_step_summary(args.mode, stats, watermark, dry_run=True)
            return 0

        assert sb is not None and run_id is not None
        synced_at = datetime.now(UTC).isoformat()

        # ---- 3. Upsert (trigger re-queues moved addresses) -----------------------------
        stats.upserted = upsert_charities(
            sb, [c.db_row(synced_at, include_sector=bool(sectors)) for c in registered.values()])
        log.info("Upserted %s charities", stats.upserted)

        # ---- 4. Remove deregistered charities ------------------------------------------
        to_delete = set(deregistered)
        if args.mode == "full" and not args.limit and not args.source_csv:
            existing = all_cc_numbers(sb)
            missing = existing - set(registered)
            if registered and (len(registered) >= 0.8 * len(existing) or args.force_prune):
                to_delete |= missing
            elif missing:
                log.warning("Register returned %s records vs %s stored — skipping prune (use --force-prune)",
                            len(registered), len(existing))
        if to_delete:
            stats.deleted = delete_charities(sb, list(to_delete))
            log.info("Removed %s charities that are no longer registered", stats.deleted)

        # ---- 5. Geocode the queue ---------------------------------------------------
        rows = queued_rows(sb, retry_review=args.retry_review, limit=args.max_geocode)
        log.info("Geocoding %s queued records with %s", len(rows),
                 ", ".join(p.name for p in chain.providers) or "no providers")
        items = [(r["cc_number"], registered[r["cc_number"]].address if r["cc_number"] in registered
                  else address_from_row(r)) for r in rows]
        pending: list[dict[str, Any]] = []

        def collect(cc: str, addr: CleanAddress, outcome: GeocodeOutcome) -> None:
            pending.append(outcome_to_result(cc, addr.raw, outcome))
            if len(pending) >= RESULT_BATCH:
                apply_results(sb, pending)
                pending.clear()
                log.info("  …%s geocoded (%s success, %s review)", stats.geocoded, stats.succeeded, stats.needs_review)

        geocode_many(chain, items, workers=args.workers, deadline=deadline, on_result=collect, stats=stats)
        apply_results(sb, pending)

        # ---- 6. Snapshot + bookkeeping ------------------------------------------------
        if args.publish_snapshot:
            publish_snapshot(sb)
        if watermark is None and since is not None:
            watermark = since + timedelta(hours=args.overlap_hours)  # nothing changed: keep position
        sb.table("sync_runs").update({
            "status": "succeeded", "finished_at": datetime.now(UTC).isoformat(),
            "source_watermark": watermark.isoformat() if watermark else None,
            "fetched": stats.fetched, "upserted": stats.upserted, "deleted": stats.deleted,
            "geocoded": stats.geocoded, "succeeded": stats.succeeded, "needs_review": stats.needs_review,
        }).eq("id", run_id).execute()
        write_step_summary(args.mode, stats, watermark, dry_run=False)
        log.info("Done in %.1f min — %s geocoded: %s success, %s needs review",
                 (time.monotonic() - started) / 60, stats.geocoded, stats.succeeded, stats.needs_review)
        return 0

    except Exception as exc:
        log.exception("Sync failed")
        if sb is not None and run_id is not None:
            try:
                sb.table("sync_runs").update({
                    "status": "failed", "finished_at": datetime.now(UTC).isoformat(),
                    "error": f"{type(exc).__name__}: {exc}"[:1000],
                    "fetched": stats.fetched, "upserted": stats.upserted,
                    "geocoded": stats.geocoded, "succeeded": stats.succeeded, "needs_review": stats.needs_review,
                }).eq("id", run_id).execute()
            except Exception:
                log.exception("Could not record the failed run")
        return 1
    finally:
        http.close()


if __name__ == "__main__":
    sys.exit(main())

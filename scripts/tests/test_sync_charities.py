"""Unit tests for scripts/sync_charities.py — run with:  uvx --with httpx pytest scripts/tests -q"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sync_charities as sc  # noqa: E402


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(sc.time, "sleep", lambda _s: None)


# ---------------------------------------------------------------------------
# Address cleaning — rows copied from the live register
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("row", "street", "extra"),
    [
        (("Floor 1", "43 Princes Street", "Dunedin Central", "Dunedin", "9016"), "43 Princes Street", {"number": 43}),
        (("Level 14, ANZ Centre", "23-29 Albert Street", "Auckland City", "Auckland", "1010"),
         "23-29 Albert Street", {"number": 23, "number_high": 29}),
        (("29 Rakiura Parade", "RD 9", "Otatara", "Invercargill", "9879"), "29 Rakiura Parade", {"rural_delivery": "RD 9"}),
        (("Ground Floor, 1 Thorndon Quay", "C/- The PNBST Charitable Trust", "Pipitea", "Wellington", "6011"),
         "1 Thorndon Quay", {}),
        (("Flat 4", "5 Moana Avenue", "Onehunga", "Auckland", "1061"), "4/5 Moana Avenue", {"unit": "4", "number": 5}),
        (("Unit 12", "57 Cavendish Drive", "Manukau", "Auckland", "2104"), "12/57 Cavendish Drive", {}),
        (("Level 2 15 Allen Street", "PO Box 5349", "", "Wellington", "6140"), "15 Allen Street", {"po_box": True}),
        (("2826A Hunua Road", "RD 3", "Hunua", "Papakura", "2583"), "2826A Hunua Road", {"suffix": "A"}),
        (("LEVEL ONE CONCORDIA HOUSE", "200 Hardy Street", "", "Nelson", "7010"), "200 Hardy Street", {}),
        (("First Floor, 4 Canning Place", "Whakatane 3120", " ", "Whakatane", "3120"), "4 Canning Place", {}),
        (("85 Hendersons Line", "Marton 4710", " ", "Marton", "4710"), "85 Hendersons Line", {}),
        (("12 queen st", "", "", "Auckland", "1010"), "12 Queen Street", {"road": "Queen Street"}),
        (("L2, 5 Queen St", "", "", "Auckland", ""), "5 Queen Street", {}),
        (("1 Office Road", "", "Merivale", "Christchurch", "8014"), "1 Office Road", {}),
        (("1415 State Highway 53", "RD 3", "", "Martinborough", "5783"), "1415 State Highway 53", {}),
        (("C/- 100 Malfroy Road", " ", "Victoria", "Rotorua", "3010"), "100 Malfroy Road", {}),
    ],
)
def test_clean_address_finds_the_street(row, street, extra):
    addr = sc.clean_address(*row)
    assert addr.street == street
    for key, value in extra.items():
        assert getattr(addr, key) == value, key


def test_po_box_only_has_no_street():
    addr = sc.clean_address("PO Box 112105", "", "Penrose", "Auckland", "1642")
    assert addr.street is None and addr.po_box
    assert addr.raw == "PO Box 112105, Penrose, Auckland, 1642"


def test_unnumbered_and_building_only_addresses():
    kelburn = sc.clean_address("Student Union Building Level 2/Kelburn Parade", "", "Kelburn", "Wellington", "6012")
    assert kelburn.street == "Kelburn Parade" and kelburn.number is None
    assert sc.clean_address("Suite 9B", "Krukzeiner House", "Auckland Central", "Auckland", "1010").street is None
    assert sc.clean_address("State Highway 2", " ", "Clive", "Hawkes Bay", "4102").street == "State Highway 2"


def test_street_corner_becomes_a_street_level_query():
    addr = sc.clean_address("Corner Edmonton And Great North Roads", "", "Henderson", "Waitakere City", "")
    assert addr.corner and addr.road == "Edmonton Road"


def test_city_with_postcode_and_overseas_detection():
    addr = sc.clean_address("10 Main Road", "", "", "Auckland 1010", "")
    assert (addr.city, addr.postcode) == ("Auckland", "1010")
    assert sc.clean_address("1 George St", "", "", "Sydney", "2000", "Australia").overseas_country == "Australia"
    # junk in the country column (seen in exported CSVs) must not be treated as overseas
    assert sc.clean_address("1 Anglesea Street", "", "", "Hamilton", "3204", "Hamilton Central").overseas_country is None


def test_address_raw_is_stable_under_whitespace_noise():
    a = sc.clean_address(" 187  Rimu Street", None, "", "Te Kauwhata", "3710", "New Zealand")
    b = sc.clean_address("187 Rimu Street", " ", None, "Te Kauwhata ", "3710")
    assert a.raw == b.raw == "187 Rimu Street, Te Kauwhata, 3710"


def test_address_from_row_round_trips():
    original = sc.clean_address("Flat 4", "5 Moana Avenue", "Onehunga", "Auckland", "1061")
    rebuilt = sc.address_from_row({"address_raw": original.raw, "street": original.street, "suburb": "Onehunga",
                                   "city": "Auckland", "postcode": "1061"})
    assert (rebuilt.unit, rebuilt.number, rebuilt.road) == ("4", 5, "Moana Avenue")
    assert sc.address_from_row({"address_raw": "PO Box 1, Wairoa, 4160", "street": None}).po_box


def test_every_row_of_the_sample_export_cleans_without_error():
    path = Path("/mnt/user-data/uploads/charities_data.csv")
    if not path.exists():
        pytest.skip("sample CSV not available")
    rows = list(sc.read_csv_source(str(path)))
    cleaned = [sc.to_source_charity(r, {}) for r in rows]
    assert all(c is not None for c in cleaned)
    with_street = sum(1 for c in cleaned if c.address.street)
    assert with_street / len(cleaned) > 0.9


# ---------------------------------------------------------------------------
# OData helpers
# ---------------------------------------------------------------------------

def test_odata_payload_shapes():
    assert sc.odata_results({"d": {"results": [{"a": 1}], "__next": "x"}}) == [{"a": 1}]
    assert sc.odata_results({"d": [{"a": 2}]}) == [{"a": 2}]
    assert sc.odata_results({"value": [{"a": 3}]}) == [{"a": 3}]


def test_odata_datetimes():
    assert sc.parse_odata_datetime("/Date(1370131200000)/") == datetime(2013, 6, 2, tzinfo=UTC)
    assert sc.parse_odata_datetime("2026-09-16T02:33:48") == datetime(2026, 9, 16, 2, 33, 48, tzinfo=UTC)
    assert sc.odata_datetime_literal(datetime(2026, 9, 1, tzinfo=UTC)) == "datetime'2026-09-01T00:00:00'"


def test_sector_lookup_detects_columns():
    rows = [
        {"__metadata": {"uri": "x"}, "SectorId": 7, "Name": "Education / training / research"},
        {"Id": 12, "Description": "Health"},
        {"SomethingId": 15, "Label": "Religious activities"},
    ]
    assert sc.sector_lookup_from_rows(rows) == {
        7: "Education / training / research", 12: "Health", 15: "Religious activities"}


def test_fetch_organisations_uses_keyset_paging():
    seen_filters = []
    pages = {0: [{"OrganisationId": 1}, {"OrganisationId": 5}], 5: [{"OrganisationId": 9}], 9: []}

    def handler(request: httpx.Request) -> httpx.Response:
        flt = request.url.params["$filter"]
        seen_filters.append(flt)
        last = int(flt.split("OrganisationId gt ")[1].split()[0])
        assert request.url.params["$orderby"] == "OrganisationId"
        return httpx.Response(200, json={"d": {"results": pages[last]}})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    ids = [r["OrganisationId"] for r in sc.fetch_organisations(client, since=None, registered_only=True)]
    assert ids == [1, 5, 9]
    assert "RegistrationStatus eq 'Registered'" in seen_filters[0]


def test_fetch_groups_reads_the_groups_entity_as_charities():
    # a row copied from the live register's Groups entity
    group = {
        "__metadata": {"uri": "x"}, "GroupId": 123, "RegistrationNumber": "CC22833",
        "name": "Auckland Kindergarten Association Group", "RegistrationStatus": "Registered",
        "StreetAddressLine1": "80 Greys Avenue", "StreetAddressLine2": None, "StreetAddressSuburb": " ",
        "StreetAddressTownCity": "Auckland", "StreetAddressPostcode": "1010", "StreetAddressCountry": None,
        "MainSectorId": 7, "ModifiedOn": "2024-01-01T00:00:00Z",
    }
    group |= {"Telephone": "09 373 5635", "CharityEmailAddress": "info@aka.org.nz", "Website": "www.aka.org.nz",
              "MainActivityId": 9, "MainBeneficiaryId": 2}
    pages = {0: [group, {**group, "GroupId": 150, "RegistrationNumber": "CC11026-0"}], 150: []}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/Groups"
        assert request.url.params["$orderby"] == "GroupId"
        assert "StreetAddressTownCity" in request.url.params["$select"]
        last = int(request.url.params["$filter"].split("GroupId gt ")[1].split()[0])
        return httpx.Response(200, json={"d": {"results": pages[last]}})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    records = list(sc.fetch_groups(client, since=datetime(2026, 9, 1, tzinfo=UTC), registered_only=False))
    charity, suffixed = (
        sc.to_source_charity(r, {7: "Education / training / research"}, {9: "Provides services"},
                             {2: "Children / young people"}, {123: "CC22833", 150: "CC11026-0"})
        for r in records
    )

    assert (charity.cc_number, charity.name, charity.registered) == (
        "CC22833", "Auckland Kindergarten Association Group", True)
    assert charity.sector == "Education / training / research"
    assert (charity.address.street, charity.address.city) == ("80 Greys Avenue", "Auckland")
    assert charity.modified_on == datetime(2024, 1, 1, tzinfo=UTC)
    assert (charity.activity, charity.beneficiary) == ("Provides services", "Children / young people")
    assert (charity.phone, charity.email, charity.website) == ("09 373 5635", "info@aka.org.nz", "https://www.aka.org.nz")
    # a group is marked as one, and isn't a member of itself
    assert charity.is_group and charity.group_cc is None
    assert suffixed.cc_number == "CC11026-0"  # some groups carry a suffixed number


def test_member_charity_is_linked_to_its_group():
    record = {
        "OrganisationId": 55201, "CharityRegistrationNumber": "CC21786", "RegistrationStatus": "Registered",
        "Name": "The Wellington City Mission (Anglican) Trust Board", "StreetAddressLine1": "4 Oxford Terrace",
        "StreetAddressCity": "Wellington", "GroupId": 227, "MainActivityId": 9, "MainBeneficiaryId": None,
        "CharitablePurpose": "The Mission is open to anyone\r\nwho needs assistance.  ",
        "Telephone1": "04 245 0900", "CharityEmailAddress": "enquiries@wcm.org.nz",
        "WebSiteURL": "https://wellingtoncitymission.org.nz/",
    }
    lookups = ({}, {9: "Provides services (e.g. care / counselling)"}, {4: "General public"}, {227: "CC21777"})
    charity = sc.to_source_charity(record, *lookups)
    assert (charity.is_group, charity.group_cc) == (False, "CC21777")
    assert charity.purpose == "The Mission is open to anyone who needs assistance."
    assert (charity.activity, charity.beneficiary) == ("Provides services (e.g. care / counselling)", None)

    # a group that is no longer registered isn't in the lookup, so there's nothing to link to
    assert sc.to_source_charity({**record, "GroupId": 999}, *lookups).group_cc is None
    assert sc.to_source_charity({**record, "GroupId": None}, *lookups).group_cc is None

    row = charity.db_row("2026-10-13T00:00:00+00:00")
    assert row["group_cc"] == "CC21777" and row["is_group"] is False and row["phone"] == "04 245 0900"
    assert row["socials"] is None  # the record has no social fields
    with_socials = sc.to_source_charity({**record, "FacebookName": "@wellingtoncitymission",
                                         "SocialNetworkName": "Instagram: wgtncitymission"}, *lookups)
    assert with_socials.db_row("t")["socials"] == [
        "https://www.facebook.com/wellingtoncitymission", "https://www.instagram.com/wgtncitymission"]
    # before the charity_socials migration the column is left out
    assert "socials" not in with_socials.db_row("t", skip=sc.SOCIAL_COLUMNS)
    # before the migration the table has none of the detail columns
    assert set(charity.db_row("t", details=False)) == {
        "cc_number", "name", "sector", "address_raw", "street", "suburb", "city", "postcode", "last_synced_at"}
    # a lookup that failed this run leaves the stored value alone
    assert not {"sector", "activity"} & set(charity.db_row("t", skip=["sector", "activity"]))


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("www.scouts.nz", "https://www.scouts.nz"),
        ("https://www.cubadupa.co.nz/artists-2026/", "https://www.cubadupa.co.nz/artists-2026/"),
        ("HTTP://www.manukauchristian.school.nz/", "HTTP://www.manukauchristian.school.nz/"),
        ("javascript:alert(1)", None),
        ("ftp://example.org", None),
        ("info@example.org", None),
        ("none yet", None),
        ("n/a", None),
        ("facebook", None),
        (None, None),
    ],
)
def test_clean_website_only_lets_web_addresses_through(raw, expected):
    assert sc.clean_website(raw) == expected


@pytest.mark.parametrize(
    ("facebook", "twitter", "other", "expected"),
    [
        # full links, with tracking and odd hosts tidied up, and http made https
        ("http://www.facebook.com/parent2parentnz/?fref=ts", None, None, ["https://www.facebook.com/parent2parentnz"]),
        ("https:/www.facebook.com/burnsideparktennis/", None, None, ["https://www.facebook.com/burnsideparktennis"]),
        ("m.facebook.com/Some.Page", None, None, ["https://www.facebook.com/Some.Page"]),
        ("wwwfacebook.com/trust", None, None, ["https://www.facebook.com/trust"]),
        ("https://www.facebook.com/profile.php?id=100011399219751&fref=ts", None, None,
         ["https://www.facebook.com/profile.php?id=100011399219751"]),
        ("www.facebook.com/groups/ClanMathesonNewZealand", None, None,
         ["https://www.facebook.com/groups/ClanMathesonNewZealand"]),
        (None, "https://twitter.com/95bFM?ref_src=twsrc%5Egoogle", None, ["https://x.com/95bFM"]),
        (None, None, "https://nz.linkedin.com/company/sport-taranaki/",
         ["https://www.linkedin.com/company/sport-taranaki"]),
        # handles, alone or with the platform named
        ("@waikatopotters", None, None, ["https://www.facebook.com/waikatopotters"]),
        ("jetboatworld", None, None, ["https://www.facebook.com/jetboatworld"]),
        (None, "twitter@WhiritoaSLSC", None, ["https://x.com/WhiritoaSLSC"]),
        (None, "https://twitter.com @WKAFC​", None, ["https://x.com/WKAFC"]),
        (None, None, "Instagram - uoafsae47", ["https://www.instagram.com/uoafsae47"]),
        (None, None, "TikTok @io_raranga", ["https://www.tiktok.com/@io_raranga"]),
        # one per platform, the Facebook field's first; shown Facebook, Instagram, X
        ("@ourtrust", "@ourtrust", "www.facebook.com/other www.instagram.com/ourtrust",
         ["https://www.facebook.com/ourtrust", "https://www.instagram.com/ourtrust", "https://x.com/ourtrust"]),
        # not links to anyone: page titles, placeholders, searches, websites, emails, no platform named
        ("Ellesmere Golf Club", "No", "Instagram: Motu Trails Cycleway", None),
        ("N/A", "0", "Instagram", None),
        ("https://www.facebook.com/search/top?q=akaroa", None, None, None),
        ("https://www.facebook.com/", None, None, None),
        ("FreeSlaves.org", None, "www.oranawildlifepark.co.nz", None),
        ("info@trust.org.nz", None, "also remu.org.nz@gmail.com", None),
        (None, "@GreatBarrierIslandEnvironmentTrust", "@brainsaver", None),
        ("javascript:alert(1)", None, None, None),
        (None, None, None, None),
    ],
)
def test_clean_socials_makes_working_links_or_nothing(facebook, twitter, other, expected):
    assert sc.clean_socials(facebook, twitter, other) == expected


def test_a_website_on_a_social_site_counts_as_that_platform():
    assert sc.clean_socials(None, None, None, "https://m.facebook.com/ourtrust") == ["https://www.facebook.com/ourtrust"]
    assert sc.clean_socials("@first", None, None, "https://www.facebook.com/second") == ["https://www.facebook.com/first"]
    assert sc.clean_socials(None, None, None, "https://www.ourtrust.org.nz") is None


def test_clean_email_and_phone():
    assert sc.clean_email(" enquiries@wcm.org.nz ") == "enquiries@wcm.org.nz"
    assert sc.clean_email("not an email") is None and sc.clean_email("a@b") is None
    assert sc.clean_phone("04 245 0900") == "04 245 0900"
    assert sc.clean_phone("0800 SALLIES (0800 725 543)") == "0800 SALLIES (0800 725 543)"
    assert sc.clean_phone("n/a") is None and sc.clean_phone("12345") is None


def test_fetch_group_numbers_maps_group_ids_to_cc_numbers():
    def handler(request: httpx.Request) -> httpx.Response:
        assert "RegistrationStatus eq 'Registered'" in request.url.params["$filter"]
        first = "GroupId gt 0 " in request.url.params["$filter"]
        rows = [{"GroupId": 227, "RegistrationNumber": "CC21777"}, {"GroupId": 150, "RegistrationNumber": "cc11026-0"},
                {"GroupId": 300, "RegistrationNumber": None}] if first else []
        return httpx.Response(200, json={"d": {"results": rows}})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    assert sc.fetch_group_numbers(client) == {227: "CC21777", 150: "CC11026-0"}


def test_has_detail_columns_detects_an_unmigrated_database():
    class Query:
        def __init__(self, error=None):
            self.error = error

        def select(self, columns):
            assert ("group_cc" in columns and "website" in columns) or columns == "socials"
            return self

        def limit(self, _n):
            return self

        def execute(self):
            if self.error:
                raise self.error
            return None

    class Client:
        def __init__(self, error=None):
            self.error = error

        def table(self, name):
            assert name == "charities"
            return Query(self.error)

    assert sc.has_detail_columns(Client())
    assert sc.has_detail_columns(Client(), sc.SOCIAL_COLUMNS) is True
    missing = Exception("{'message': 'column charities.purpose does not exist', 'code': '42703'}")
    assert not sc.has_detail_columns(Client(missing))
    with pytest.raises(RuntimeError):  # anything else is a real failure
        sc.has_detail_columns(Client(RuntimeError("connection reset")))


def test_request_json_retries_then_succeeds():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(503) if calls["n"] == 1 else httpx.Response(200, json={"ok": True})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    assert sc.request_json(client, "https://example.test") == {"ok": True}


def test_request_json_timeout_becomes_provider_error():
    def handler(request):
        raise httpx.ReadTimeout("slow", request=request)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(sc.ProviderError, match="timed out"):
        sc.request_json(client, "https://example.test", attempts=2, what="LINZ")


# ---------------------------------------------------------------------------
# Scoring and decisions
# ---------------------------------------------------------------------------

def cand(lon, lat, number, road, suburb, city, unit=None, suffix=None, precision="address"):
    return sc.Candidate(lon=lon, lat=lat, label=f"{number} {road}, {suburb}", source="test", precision=precision,
                        number=number, suffix=suffix, road=road, suburb=suburb, city=city, unit=unit)


def test_exact_match_is_success():
    addr = sc.clean_address("187 Rimu Street", "", "", "Te Kauwhata", "3710")
    out = sc.decide(addr, [cand(175.14, -37.40, 187, "Rimu Street", "Te Kauwhata", "Te Kauwhata")])
    assert out.status == "SUCCESS" and out.score >= sc.SUCCESS_THRESHOLD


def test_same_street_in_other_towns_is_resolved_by_locality():
    addr = sc.clean_address("12 Rimu Street", "", "", "Taupo", "3330")
    out = sc.decide(addr, [
        cand(176.07, -38.69, 12, "Rimu Street", "Taupo", "Taupo"),
        cand(176.25, -38.14, 12, "Rimu Street", "Glenholme", "Rotorua"),
    ])
    assert out.status == "SUCCESS" and out.lon == 176.07


def test_ambiguous_when_locality_matches_nothing():
    addr = sc.clean_address("12 Rimu Street", "", "", "Somewhere Else", "")
    out = sc.decide(addr, [
        cand(176.07, -38.69, 12, "Rimu Street", "Taupo", "Taupo"),
        cand(176.25, -38.14, 12, "Rimu Street", "Glenholme", "Rotorua"),
    ])
    assert out.status == "NEEDS_REVIEW" and out.reason.startswith("Ambiguous match")


def test_units_of_one_building_are_not_ambiguous():
    addr = sc.clean_address("5 Moana Avenue", "", "Onehunga", "Auckland", "1061")
    out = sc.decide(addr, [
        cand(174.7856, -36.9241, 5, "Moana Avenue", "Onehunga", "Auckland", unit="1"),
        cand(174.7857, -36.9242, 5, "Moana Avenue", "Onehunga", "Auckland", unit="2"),
        cand(174.78565, -36.92415, 5, "Moana Avenue", "Onehunga", "Auckland"),
    ])
    assert out.status == "SUCCESS" and out.lon == 174.78565  # base address preferred over units


def test_results_outside_nz_are_discarded():
    # The legacy map put "Corner Edmonton And Great North Roads, Waitakere City" in Alberta.
    addr = sc.clean_address("Corner Edmonton And Great North Roads", "", "Henderson", "Waitakere City", "")
    assert sc.decide(addr, [cand(-113.4937, 53.5461, None, "Edmonton Road", "Edmonton", "Edmonton")]) is None


def test_linz_parse_fixes_axis_order_and_multipoint():
    payload = {"features": [
        {"geometry": {"type": "MultiPoint", "coordinates": [[-41.2951, 174.7792]]},
         "properties": {"full_address": "132 Tory Street, Te Aro, Wellington", "address_number": 132,
                        "full_road_name_ascii": "Tory Street", "suburb_locality_ascii": "Te Aro",
                        "town_city_ascii": "Wellington"}},
        {"geometry": {"type": "Point", "coordinates": [-176.5596, -43.9536]},
         "properties": {"full_address": "9 Tuku Road, Waitangi", "address_number": "9"}},
    ]}
    parsed = sc.LinzGeocoder.parse(payload)
    assert (parsed[0].lon, parsed[0].lat) == (174.7792, -41.2951)
    assert (parsed[1].lon, parsed[1].lat, parsed[1].number) == (-176.5596, -43.9536, 9)  # Chatham Islands


# ---------------------------------------------------------------------------
# Provider chain: failures never crash the run
# ---------------------------------------------------------------------------

class FakeProvider(sc.Geocoder):
    def __init__(self, name, result=None, error=None):
        self.name, self.result, self.error, self.calls = name, result, error, 0

    def geocode(self, addr):
        self.calls += 1
        if self.error:
            raise self.error
        return self.result


def test_chain_falls_through_timeouts_to_the_next_provider():
    ok = sc.GeocodeOutcome("SUCCESS", 174.0, -41.0, None, "photon", 0.95, "address")
    chain = sc.GeocoderChain([FakeProvider("linz", error=sc.ProviderError("LINZ timed out")),
                              FakeProvider("photon", result=ok)], photon=None)
    assert chain.geocode(sc.clean_address("1 Test Street", "", "", "Wellington", "")) is ok


def test_chain_reports_all_failures_as_needs_review():
    chain = sc.GeocoderChain([FakeProvider("linz", error=sc.ProviderError("LINZ timed out")),
                              FakeProvider("photon", error=RuntimeError("boom"))], photon=None)
    out = chain.geocode(sc.clean_address("1 Test Street", "", "", "Wellington", ""))
    assert out.status == "NEEDS_REVIEW" and "LINZ timed out" in out.reason and not out.has_point


def test_chain_disables_provider_on_auth_error_and_caches():
    linz = FakeProvider("linz", error=sc.ProviderAuthError("LINZ rejected the credentials (HTTP 401)"))
    chain = sc.GeocoderChain([linz], photon=None)
    chain.geocode(sc.clean_address("1 Test Street", "", "", "Wellington", ""))
    chain.geocode(sc.clean_address("2 Test Street", "", "", "Wellington", ""))
    chain.geocode(sc.clean_address("2 Test Street", "", "", "Wellington", ""))  # cached
    assert linz.calls == 1 and "linz" in chain.disabled


def test_po_box_and_overseas_reasons():
    chain = sc.GeocoderChain([], photon=None)
    assert chain.geocode(sc.clean_address("PO Box 416", "", "", "Wairoa", "4160")).reason.startswith("PO Box only")
    overseas = chain.geocode(sc.clean_address("1 George St", "", "", "Sydney", "2000", "Australia"))
    assert overseas.reason == "Street address is outside New Zealand (Australia)"


def test_outcome_to_result_payload():
    res = sc.outcome_to_result("CC1", "raw", sc.GeocodeOutcome("SUCCESS", 174.12345678, -41.1, None, "linz", 1.0))
    assert res == {"cc_number": "CC1", "address_raw": "raw", "lon": 174.1234568, "lat": -41.1,
                   "status": "SUCCESS", "error": None}
    assert json.dumps(res)

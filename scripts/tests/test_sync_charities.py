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

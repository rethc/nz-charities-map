"""Unit tests for scripts/intelligence.py — run with:  uvx --with httpx pytest scripts/tests -q"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import intelligence as it  # noqa: E402

TODAY = date(2026, 11, 24)
COMPLETE = 2025  # the last year every charity's return is due for, as of TODAY
START = date(2020, 1, 1)


def org(oid=1, cc="CC10001", month=3, day=31, **over):
    return {"OrganisationId": oid, "CharityRegistrationNumber": cc, "Name": f"Test Trust {oid}", "EndOfYearMonth": month,
            "EndOfYearDayofMonth": day, "AnnualReturnExtensionDate": None, "DateRegistered": "2010-05-01T00:00:00Z",
            "GroupId": None, "GroupType": None, "PercentageSpentOverseas": 0, "StreetAddressCity": "Nelson", **over}


def ret(year_ended, oid=1, rid=None, filed=None, tier=3, income=100_000, spend=90_000, net=50_000, status=10, **figures):
    """A return for the year ended `year_ended`, last changed on `filed` (by default 4 months after the year end: on time)."""
    y, m, d = map(int, year_ended.split("-"))
    filed = filed or it.rc.add_months(date(y, m, d), 4).isoformat()
    return {"AnnualReturnId": rid or (oid * 10_000 + y), "OrganisationId": oid, "Status": status, "YearEnded": f"{year_ended}T00:00:00Z",
            "ReportingTierId": tier, "ModifiedOn": f"{filed}T00:00:00Z", "Approvedby_Date": None, "TotalGrossIncome": income,
            "TotalExpenditure": spend, "Totalassetslesstotalliabilities": net, **figures}


def officer(oid=1, name="Aroha Ngata", start="2015-01-01", end=None, status=None):
    return {"OfficerId": hash((oid, name)) % 10**6, "OrganisationId": oid, "NameKey": it.name_key(name),
            "OfficerStatus": status or ("Past" if end else "Qualified"), "PositionAppointmentDate": f"{start}T00:00:00Z",
            "LastDateAsAnOfficer": f"{end}T00:00:00Z" if end else None, "IsaBodyCorporate": False}


def five(oid=1, **figures):
    """Returns for the five complete years, all on time."""
    return [ret(f"{y}-03-31", oid=oid, **figures) for y in range(2021, 2026)]


def analyse(orgs, returns, officers=()):
    feed = it.Feed(orgs=orgs, views=[], returns=returns, officers=list(officers), fetched="2026-11-24T00:00:00+00:00")
    meta, charities = it.analyse(feed, TODAY)
    return meta, {c.cc: c for c in charities}


def one(returns, officers=(), **over):
    return analyse([org(**over)], returns, officers)[1]["CC10001"]


# ---- The years and the size bands --------------------------------------------------------------

@pytest.mark.parametrize(("today", "expected"), [
    (date(2026, 11, 24), 2025),
    (date(2026, 8, 29), 2024),   # a 31 December 2025 year end is due 30 June, and late 60 days on
    (date(2026, 8, 30), 2025),
    (date(2026, 1, 15), 2024),
])
def test_last_complete_year(today, expected):
    assert it.last_complete_year(today) == expected


@pytest.mark.parametrize(("spend", "income", "band"), [
    (139_999, None, 4), (140_000, None, 3), (4_999_999, None, 3), (5_000_000, None, 2), (33_000_000, None, 1),
    (None, 50_000, 4), (None, None, 0), (0, 9_000_000, 4),
])
def test_size_band_follows_the_tier_limits(spend, income, band):
    assert it.band_for(spend, income) == band


def test_a_small_charity_that_ticks_tier_1_is_compared_with_small_charities():
    c = one(five(tier=1, spend=20_000, income=25_000))
    assert c.latest.tier == 1 and c.band == 4


def test_no_published_return_means_no_size_band():
    c = one([ret("2025-03-31", status=20)])
    assert c.band == 0 and c.values["income"] is None
    assert [y.status for y in c.years][-1] == "processing"


# ---- When a return was filed -------------------------------------------------------------------

def test_a_return_corrected_later_keeps_the_day_it_arrived():
    returns = [ret("2025-03-31", oid=i, rid=1000 + i, filed="2025-07-02") for i in range(1, 8)]
    returns[3]["ModifiedOn"] = "2026-03-01T00:00:00Z"  # corrected eight months on
    filed = it.estimate_filed(returns)
    assert filed[1004] == (date(2025, 7, 2), "estimated")
    assert filed[1001] == (date(2025, 7, 2), "estimated")


def test_a_return_changed_before_its_neighbours_keeps_its_own_date():
    returns = [ret("2025-03-31", oid=i, rid=1000 + i, filed="2025-09-20") for i in range(1, 8)]
    returns[0]["ModifiedOn"] = "2025-06-01T00:00:00Z"
    assert it.estimate_filed(returns)[1001] == (date(2025, 6, 1), "estimated")


def test_an_approval_date_is_used_when_it_makes_sense():
    good = ret("2025-03-31", rid=1, filed="2025-08-10", Approvedby_Date="2025-08-01T00:00:00Z")
    before_year_end = ret("2025-03-31", oid=2, rid=2, filed="2025-08-10", Approvedby_Date="2024-08-01T00:00:00Z")
    after_change = ret("2025-03-31", oid=3, rid=3, filed="2025-08-10", Approvedby_Date="2027-01-01T00:00:00Z")
    filed = it.estimate_filed([good, before_year_end, after_change])
    assert filed[1] == (date(2025, 8, 1), "approved")
    assert filed[2][1] == "estimated" and filed[3][1] == "estimated"


def test_the_estimate_is_never_before_the_year_end():
    # Its neighbours in the numbering arrived months before its own year ended.
    returns = [ret("2024-03-31", oid=i, rid=1000 + i, filed="2024-08-01") for i in range(1, 8)]
    odd_one = ret("2025-06-30", oid=10, rid=1000, filed="2025-11-01")
    assert it.estimate_filed([*returns, odd_one])[1000] == (date(2025, 6, 30), "estimated")


# ---- Year by year ------------------------------------------------------------------------------

def test_on_time_late_and_missing_years():
    returns = [
        ret("2021-03-31"),
        ret("2022-03-31", filed="2023-02-01"),          # due 30 Sep 2022: four months late
        ret("2023-03-31", filed="2023-11-15"),          # 46 days after the due date: within the allowance
        # nothing for 2024
        ret("2025-03-31"),
    ]
    c = one(returns)
    assert [(y.fy, y.status) for y in c.years] == [
        (2021, "on_time"), (2022, "late"), (2023, "on_time"), (2024, "missing"), (2025, "on_time")]
    assert c.values["late_returns"] == 2 and c.levels["late_returns"] == 1
    assert "1 late (2022)" in c.why["late_returns"] and "1 not filed (2024)" in c.why["late_returns"]


def test_a_charity_that_stopped_filing_is_missing_every_year_since():
    c = one([ret("2021-03-31"), ret("2022-03-31")])
    assert [y.status for y in c.years] == ["on_time", "on_time", "missing", "missing", "missing"]
    assert c.levels["late_returns"] == 1
    c = one([ret("2021-03-31")])
    assert c.values["late_returns"] == 4 and c.levels["late_returns"] == 2


def test_the_window_follows_a_charity_that_has_filed_this_year():
    c = one([*five(), ret("2026-03-31")])
    assert [y.fy for y in c.years] == [2022, 2023, 2024, 2025, 2026]
    assert [y.fy for y in c.span] == [2021, 2022, 2023, 2024, 2025, 2026]
    assert c.latest.fy == 2026


def test_group_members_and_new_charities_are_not_called_late():
    member = one([], GroupType=it.rc.GROUP_MEMBER)
    assert {y.status for y in member.years} == {"group"} and member.values["late_returns"] is None
    assert member.note and "group" in member.note

    new = one([ret("2025-03-31")], DateRegistered="2024-06-01T00:00:00Z")
    assert [y.status for y in new.years] == ["none", "none", "none", "none", "on_time"]
    assert new.values["late_returns"] == 0

    # An old charity with nothing of its own in the feed most likely files through a group.
    silent = one([])
    assert {y.status for y in silent.years} == {"unknown"} and silent.values["late_returns"] is None


def test_a_changed_balance_date_is_not_a_missing_year():
    # 31 March 2023, then one 18-month year to 30 September 2024: nothing was skipped.
    returns = [ret("2021-03-31"), ret("2022-03-31"), ret("2023-03-31"), ret("2024-09-30"), ret("2025-09-30")]
    c = one(returns, month=9, day=30)
    assert "missing" not in [y.status for y in c.years]


def test_board_size_at_each_year_end():
    people = [
        officer(name="Aroha Ngata", start="2015-01-01"),
        officer(name="Ben Tane", start="2015-01-01", end="2023-06-30"),
        officer(name="Cara Smith", start="2024-06-10"),
        officer(name="Dan Proposed", start="2020-01-01", status="Proposed"),  # not serving: never counted
    ]
    c = one(five(), people)
    assert [y.officers for y in c.years] == [2, 2, 2, 1, 2]
    assert c.values["officers"] == 2
    # One left, of two then one then two on the board at the start of each year.
    assert c.values["officer_turnover"] == pytest.approx(1 / (2 + 2 + 2 + 1 + 2))


# ---- The signals -------------------------------------------------------------------------------

def test_assets_outgrowing_spending_needs_real_money():
    grew = [ret("2022-03-31", net=1_000_000, spend=500_000), ret("2023-03-31"), ret("2024-03-31"),
            ret("2025-03-31", net=3_000_000, spend=550_000)]
    c = one(grew)
    assert c.values["asset_growth_gap"] == pytest.approx(190)  # +200% against +10%
    assert c.levels["asset_growth_gap"] == 1
    assert c.why["asset_growth_gap"] == (
        "Net assets grew 200% from 2022 to 2025 ($1.0 million to $3.0 million). Expenses grew 10% ($500,000 to $550,000).")

    small = [ret("2022-03-31", net=10_000, spend=50_000), ret("2023-03-31"), ret("2024-03-31"),
             ret("2025-03-31", net=60_000, spend=50_000)]
    c = one(small)
    assert c.values["asset_growth_gap"] == pytest.approx(500) and c.levels["asset_growth_gap"] == 0


def test_years_of_spending_held():
    c = one(five(net=30_000_000, spend=1_000_000, income=1_100_000))
    assert c.values["reserves_years"] == pytest.approx(30) and c.levels["reserves_years"] == 1
    c = one(five(net=30_000_000, spend=200_000, income=300_000))
    assert c.levels["reserves_years"] == 2
    # A large multiple of very little isn't a signal.
    c = one(five(net=500_000, spend=5_000, income=6_000))
    assert c.values["reserves_years"] == pytest.approx(100) and c.levels["reserves_years"] == 0
    # Spending nothing at all: capped, not divided by zero.
    c = one(five(net=2_000_000, spend=0, income=0))
    assert c.values["reserves_years"] == 999


def test_low_liquidity_counts_investments_before_it_flags():
    tight = five(tier=2, spend=6_000_000, income=6_000_000, AllCurrentLiabilities=1_000_000, CashAndBankBalances=200_000,
                 TotalAssets=5_000_000)
    c = one(tight)
    assert c.values["current_ratio"] == pytest.approx(0.2) and c.levels["current_ratio"] == 1
    assert one(five(tier=2, AllCurrentLiabilities=1_000_000, CashAndBankBalances=50_000, TotalAssets=5_000_000)).levels["current_ratio"] == 2
    # Investments it could draw on cover what it owes.
    covered = five(tier=2, AllCurrentLiabilities=1_000_000, CashAndBankBalances=200_000, Investments=2_000_000, TotalAssets=5_000_000)
    c = one(covered)
    assert c.values["current_ratio"] == pytest.approx(0.2) and c.levels["current_ratio"] == 0
    # A Tier 4 return has no balance sheet.
    assert one(five(tier=4, AllCurrentLiabilities=1_000_000, CashAndBankBalances=1)).values["current_ratio"] is None


def test_current_assets_are_the_parts_added_up():
    r = ret("2025-03-31", CashAndBankBalances=100, DebtorsAndPrepayments=50, Inventory=25, TotalAssets=1_000)
    assert it.current_assets(r) == 175
    assert it.current_assets(ret("2025-03-31", AllCurrentAssets=300, CashAndBankBalances=100)) == 300
    # Parts that come to more than everything it owns have been counted twice.
    assert it.current_assets(ret("2025-03-31", CashAndBankBalances=900, CashAndShortTermDeposits=900, TotalAssets=1_000)) is None
    assert it.current_assets(ret("2025-03-31")) is None


def test_years_of_near_zero_activity():
    quiet = [ret(f"{y}-03-31", income=0, spend=200) for y in (2021, 2022, 2023)] + [ret("2024-03-31"), ret("2025-03-31")]
    c = one(quiet)
    assert c.values["dormant_years"] == 3 and c.levels["dormant_years"] == 1
    assert one(five(income=500, spend=0)).levels["dormant_years"] == 2
    assert one(five()).levels["dormant_years"] == 0


def test_a_thin_board_is_a_lot_of_money_and_three_officers_or_fewer():
    two = [officer(name="Aroha Ngata"), officer(name="Ben Tane")]
    c = one(five(income=3_000_000, spend=2_800_000), two)
    assert c.values["income_per_officer"] == 1_500_000 and c.levels["income_per_officer"] == 1
    assert "2 officers" in c.why["income_per_officer"]
    assert one(five(income=30_000_000, spend=28_000_000), two[:1]).levels["income_per_officer"] == 2
    # The same money for each officer on a board of seven isn't thin.
    seven = [officer(name=f"Person Number{chr(65 + i)}") for i in range(7)]
    c = one(five(income=10_500_000, spend=10_000_000), seven)
    assert c.values["income_per_officer"] == 1_500_000 and c.levels["income_per_officer"] == 0


def test_return_totals_that_do_not_add_up():
    assert it.quality_issues(ret("2025-03-31", SurplusDeficit=10_000)) == []
    off = it.quality_issues(ret("2025-03-31", income=100_000, spend=90_000, SurplusDeficit=40_000))
    assert off == ["Revenue less expenses is $10,000, but the annual return shows a surplus of $40,000."]
    loss = it.quality_issues(ret("2025-03-31", income=100_000, spend=90_000, SurplusDeficit=-40_000))
    assert "a deficit of $40,000" in loss[0]
    # A small slip isn't worth a look.
    assert it.quality_issues(ret("2025-03-31", income=100_000, spend=90_000, SurplusDeficit=12_000)) == []
    blank = it.quality_issues(ret("2025-03-31", income=None))
    assert blank == ["Total revenue is blank."]
    sheet = it.quality_issues(ret("2025-03-31", TotalAssets=900_000, TotalLiabilities=100_000, net=500_000))
    assert len(sheet) == 1 and "net assets" in sheet[0]
    c = one([*five()[:-1], ret("2025-03-31", income=None, TotalAssets=900_000, TotalLiabilities=100_000, net=500_000)])
    assert c.values["return_quality"] == 2 and c.levels["return_quality"] == 2


def test_modified_audit_opinions_are_counted_by_year():
    returns = five()
    for r in returns[:3]:
        r["IsModifiedAuditOpinionReceived"] = True
    c = one(returns)
    assert c.values["modified_audits"] == 3 and c.levels["modified_audits"] == 2
    assert "2021, 2022, 2023" in c.why["modified_audits"]


@pytest.mark.parametrize(("value", "words"), [
    (940, "$940"), (9_499, "$9,499"), (668_400, "$668,000"), (999_949, "$1,000,000"), (1_000_000, "$1.0 million"),
    (18_551_818, "$18.6 million"), (2_340_000_000, "$2.3 billion"), (-47_300, "-$47,000"),
])
def test_money_is_written_as_the_government_style_guide_does(value, words):
    assert it.money(value) == words


def test_change_in_words():
    assert it.change(2.08) == "grew 208%" and it.change(-0.124) == "fell 12%" and it.change(0.001) == "did not change"


def test_funds_follow_the_tier():
    assert it.funds_of(ret("2025-03-31", tier=3, net=40_000)) == (40_000, "net_assets")
    assert it.funds_of(ret("2025-03-31", tier=4, net=None, TotalResourcesLessCommittments=7_000)) == (7_000, "resources")
    assert it.funds_of(ret("2025-03-31", tier=4, net=None, TotalCashBalancesHeld=3_000)) == (3_000, "cash")
    assert it.funds_of(ret("2025-03-31", tier=2, net=None, TotalAssets=10, TotalLiabilities=4)) == (6, "net_assets")
    assert it.funds_of(ret("2025-03-31", tier=4, net=None)) == (None, None)


# ---- Boards in common --------------------------------------------------------------------------

def test_name_keys_match_people_not_spelling():
    assert it.name_key("Hēmi  Tāne") == it.name_key("hemi tane")
    assert it.name_key("Mary-Anne  O'BRIEN") == it.name_key("mary anne o brien")
    assert it.name_key("Mary") is None and it.name_key("") is None and it.name_key(None) is None
    assert it.name_key("Aroha Ngata") != it.name_key("Aroha Ngatai")
    assert "aroha" not in it.name_key("Aroha Ngata")  # hashed: no name is kept


def test_shared_boards_count_charities_with_a_serving_officer_in_common():
    orgs = [org(1, "CC10001"), org(2, "CC10002"), org(3, "CC10003")]
    people = [
        officer(1, "Aroha Ngata"), officer(1, "Ben Tane"),
        officer(2, "Aroha Ngata"), officer(2, "Ben Tane"),
        officer(3, "Aroha Ngata", end="2022-01-01"),  # left: no longer in common
        officer(3, "Cara Smith"),
    ]
    _, by = analyse(orgs, five(1) + five(2) + five(3), people)
    assert by["CC10001"].values["shared_boards"] == 1 and by["CC10001"].links == [("CC10002", 2)]
    assert by["CC10003"].values["shared_boards"] == 0


def test_a_very_common_name_is_left_out():
    n = it.COMMON_NAME_BOARDS + 1
    orgs = [org(i, f"CC{20000 + i}") for i in range(1, n + 1)]
    people = [officer(i, "John Smith") for i in range(1, n + 1)]
    _, by = analyse(orgs, [], people)
    assert by["CC20001"].values["shared_boards"] == 0


# ---- The snapshot ------------------------------------------------------------------------------

def test_snapshot_rows_follow_the_columns():
    feed = it.Feed(
        orgs=[org(1, "CC10001"), org(2, "CC10002")],
        views=[{"OrganisationId": 1, "MainSectorName": "Health", "MainBeneficiaryName": "General public",
                "MainActivityName": "Provides services", "AreasOfOperation": "Nelson - Marlborough - Tasman, Canterbury"}],
        returns=five(1) + [ret("2021-03-31", oid=2)],
        officers=[officer(1)], fetched="2026-11-24T00:00:00+00:00")
    meta, rows = it.build(feed, TODAY)
    assert meta["years"] == [2021, 2022, 2023, 2024, 2025]
    assert all(len(r["summary"]) == len(meta["columns"]) for r in rows)
    # The charity with the most signals comes first: the one that stopped filing.
    assert [r["cc_number"] for r in rows] == ["CC10002", "CC10001"]
    first = dict(zip(meta["columns"], rows[0]["summary"]))
    assert len(first["levels"]) == len(meta["signal_order"]) and first["late_returns"] == 4
    second = dict(zip(meta["columns"], rows[1]["summary"]))
    assert second["sector"] == 0 and second["income"] == 100_000 and second["band"] == 4
    detail = rows[1]["detail"]
    assert detail["areas"] == ["Nelson - Marlborough - Tasman", "Canterbury"] and detail["beneficiary"] == "General public"
    assert [dict(zip(meta["year_columns"], y))["status"] for y in detail["years"]] == ["on_time"] * 5
    assert meta["counts"]["flagged"]["late_returns"] == 1


def test_the_money_panel_only_adds_charities_with_every_year():
    feed = it.Feed(orgs=[org(1, "CC10001"), org(2, "CC10002")], views=[],
                   returns=five(1, income=100, spend=60) + [ret("2025-03-31", oid=2, income=1_000_000)],
                   officers=[], fetched="x")
    meta, _ = it.build(feed, TODAY)
    cells = meta["overview"]["cells"]
    assert sum(c["panel"] for c in cells) == 1
    assert [sum(c["income"][i] for c in cells) for i in range(5)] == [100] * 5
    # Both were due a return for 2025, and both filed on time.
    assert sum(c["due"][4] for c in cells) == 2 and sum(c["on_time"][4] for c in cells) == 2

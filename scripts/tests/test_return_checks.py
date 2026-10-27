"""Unit tests for scripts/return_checks.py — run with:  uvx --with httpx pytest scripts/tests -q"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import return_checks as rc  # noqa: E402

TODAY = date(2026, 10, 27)
WINDOW = date(2022, 1, 1)


def org(cc="CC10001", month=3, day=31, **over):
    return {"OrganisationId": 1, "CharityRegistrationNumber": cc, "Name": "Test Trust", "EndOfYearMonth": month,
            "EndOfYearDayofMonth": day, "AnnualReturnExtensionDate": None, "DateRegistered": "2010-05-01T00:00:00Z",
            "GroupId": None, **over}


def ret(year_ended, tier=4, spent=50_000, status=rc.PUBLISHED, rid=None, **figures):
    return {"AnnualReturnId": rid or int(year_ended[:4]), "OrganisationId": 1, "Status": status,
            "YearEnded": f"{year_ended}T00:00:00Z", "ReportingTierId": tier, "TotalExpenditure": spent, **figures}


@pytest.mark.parametrize(("start", "expected"), [
    (date(2025, 3, 31), date(2025, 9, 30)),   # a month's end stays a month's end
    (date(2025, 2, 28), date(2025, 8, 31)),   # as on the register: 28 February is due 31 August
    (date(2024, 2, 29), date(2024, 8, 31)),
    (date(2025, 6, 30), date(2025, 12, 31)),
    (date(2025, 1, 15), date(2025, 7, 15)),
])
def test_due_dates_follow_the_register(start, expected):
    assert rc.add_months(start, 6) == expected


def test_next_balance_date_treats_a_day_or_two_out_as_the_same_year_end():
    assert rc.next_balance_date(date(2024, 2, 28), 2, 28) == date(2025, 2, 28)  # not 29 Feb 2024
    assert rc.next_balance_date(date(2025, 5, 30), 5, 31) == date(2026, 5, 31)  # not 31 May 2025
    assert rc.next_balance_date(date(2025, 3, 31), 6, 30) == date(2025, 6, 30)  # a changed balance date
    assert rc.next_balance_date(date(2025, 3, 31), None, None) == date(2026, 3, 31)


def test_year_end_check():
    assert rc.check_year_end(org(), ret("2025-03-31")) is None
    assert rc.check_year_end(org(month=2, day=28), ret("2024-02-29")) is None  # leap year
    assert rc.check_year_end(org(month=2, day=29), ret("2025-02-28")) is None
    found = rc.check_year_end(org(month=6, day=30), ret("2025-03-31"))
    assert found and found.check == "year_end_mismatch" and "30 June" in found.summary
    assert rc.check_year_end(org(month=None, day=None), ret("2025-03-31")) is None  # nothing registered
    assert rc.check_year_end(org(), None) is None


def test_overdue_check():
    # Filed the 2026 return: fine.
    assert rc.check_overdue(org(), [ret("2025-03-31"), ret("2026-03-31")], TODAY, WINDOW) is None
    # The 2026 return was due 30 Sep 2026.
    late = rc.check_overdue(org(), [ret("2025-03-31")], TODAY, WINDOW)
    assert late and late.details["due"] == "2026-09-30" and late.details["days_overdue"] == 27
    assert late.year_ended == "2026-03-31"
    # A return the register is still processing counts as filed.
    assert rc.check_overdue(org(), [ret("2025-03-31"), ret("2026-03-31", status=20)], TODAY, WINDOW) is None
    # Not due yet: a 30 June balance date's 2026 return is due 31 Dec 2026.
    assert rc.check_overdue(org(month=6, day=30), [ret("2025-06-30")], TODAY, WINDOW) is None
    # A member of a registered group: its group files for it.
    assert rc.check_overdue(org(GroupId=227), [], TODAY, WINDOW) is None
    assert rc.check_overdue(org(GroupType=rc.GROUP_MEMBER), [], TODAY, WINDOW) is None  # no GroupId, still a member
    # Registered again (Sep 2025) after its last return (2022): only the 2026 return counts.
    again = rc.check_overdue(org(DateRegistered="2025-09-15T00:00:00Z"), [ret("2022-03-31")], TODAY, WINDOW)
    assert again and again.details["due"] == "2026-09-30" and again.details["days_overdue"] == 27
    # An extension in the feed moves the due date.
    assert rc.check_overdue(org(AnnualReturnExtensionDate="2026-12-31T00:00:00Z"), [ret("2025-03-31")], TODAY,
                            WINDOW) is None


def test_overdue_without_any_return_in_the_window():
    # Registered long ago with nothing of its own since: most likely a group files for it, so it isn't judged.
    assert rc.check_overdue(org(DateRegistered="2008-01-01T00:00:00Z"), [], TODAY, WINDOW) is None
    # Registered this year: its first return isn't due until after its first balance date.
    assert rc.check_overdue(org(DateRegistered="2026-05-01T00:00:00Z"), [], TODAY, WINDOW) is None
    # Registered in mid-2024: first year end 31 Mar 2025, due 30 Sep 2025.
    new = rc.check_overdue(org(DateRegistered="2024-06-01T00:00:00Z"), [], TODAY, WINDOW)
    assert new and new.details["due"] == "2025-09-30" and new.details["last_year_ended"] is None
    assert new.summary.startswith("Registered 1 Jun 2024 and hasn't filed a return yet.")


def test_tier_limit_check():
    over = [ret("2024-03-31", spent=174_189), ret("2025-03-31", spent=166_326), ret("2026-03-31", spent=168_992)]
    found = rc.check_tier_limit(org(), over)
    assert found and found.details["tier"] == 4 and found.annual_return_id == 2026
    assert "$174,189 (2024)" in found.summary
    # Two years over is allowed.
    assert rc.check_tier_limit(org(), over[1:]) is None
    # Under the limit in any one of the three years: fine.
    assert rc.check_tier_limit(org(), [over[0], ret("2025-03-31", spent=120_000), over[2]]) is None
    # Moved up a tier: fine.
    assert rc.check_tier_limit(org(), [*over[:2], ret("2026-03-31", tier=3, spent=168_992)]) is None
    # Tier 2 may run over its limit for one year only.
    t2 = [ret("2025-03-31", tier=2, spent=34_000_000), ret("2026-03-31", tier=2, spent=35_500_000)]
    assert rc.check_tier_limit(org(), t2)
    assert rc.check_tier_limit(org(), t2[1:]) is None
    # Tier 1 has no ceiling.
    assert rc.check_tier_limit(org(), [ret(y, tier=1, spent=90_000_000) for y in ("2024-03-31", "2025-03-31", "2026-03-31")]) is None


def test_run_checks_judges_published_returns_only():
    orgs = [org()]
    returns = [ret("2024-03-31", spent=200_000), ret("2025-03-31", spent=200_000),
               ret("2026-03-31", spent=200_000, status=21)]
    findings = rc.run_checks(orgs, returns, TODAY, WINDOW)
    # The unpublished 2026 return keeps it off the overdue list but isn't judged on its tier.
    assert [f.check for f in findings] == []
    payload = rc.run_checks([org()], [ret("2025-03-31")], TODAY, WINDOW)[0].payload()
    assert payload["check_name"] == "overdue" and "check" not in payload and payload["cc_number"] == "CC10001"


def test_tier_limits_follow_the_year():
    # Before years ending 31 March 2024 the Tier 3 limit was $2m: $3m in 2023 was over it.
    over = [ret("2023-03-31", tier=3, spent=3_000_000), ret("2024-03-31", tier=3, spent=6_000_000),
            ret("2025-03-31", tier=3, spent=6_000_000)]
    found = rc.check_tier_limit(org(), over)
    assert found and found.details["limits"] == [2_000_000, 5_000_000, 5_000_000] and "limit of each year" in found.summary
    assert rc.check_tier_limit(org(), [ret("2023-03-31", tier=3, spent=1_500_000), *over[1:]]) is None
    assert rc.tier_limit(3, date(2024, 3, 30)) == 2_000_000 and rc.tier_limit(3, date(2024, 3, 31)) == 5_000_000
    # Tier 4's limit rose earlier, from 1 January 2022.
    assert rc.tier_limit(4, date(2021, 12, 31)) == 125_000 and rc.tier_limit(4, date(2022, 3, 31)) == 140_000
    assert rc.tier_limit(1, date(2025, 3, 31)) is None


def test_moving_down_a_tier_needs_its_criteria():
    found = rc.check_tier_limit(org(), [ret("2025-08-31", tier=3, spent=300_000), ret("2026-08-31", tier=4, spent=307_799)])
    assert found and found.details["reason"] == "moved_down" and found.details["from_tier"] == 3
    assert "Moved down from Tier 3 to Tier 4" in found.summary and "$307,799" in found.summary
    assert rc.check_tier_limit(org(), [ret("2025-08-31", tier=3, spent=300_000), ret("2026-08-31", tier=4, spent=100_000)]) is None
    assert rc.check_tier_limit(org(), [ret("2025-03-31", tier=2, spent=7_000_000), ret("2026-03-31", tier=3, spent=4_000_000)]) is None


def test_missing_year_check():
    found = rc.check_missing_year(org(), [ret("2022-03-31"), ret("2024-03-31"), ret("2025-03-31")])
    assert found and found.details["missing"] == ["2023-03-31"] and found.details["shown"] == "2023"
    assert found.summary.startswith("No return for the year ended 31 Mar 2023:")
    two = rc.check_missing_year(org(), [ret("2022-03-31"), ret("2025-03-31")])
    assert two and two.details["missing"] == ["2023-03-31", "2024-03-31"] and "years ended" in two.summary
    # A return still being processed counts as filed.
    assert rc.check_missing_year(org(), [ret("2022-03-31"), ret("2023-03-31", status=20), ret("2024-03-31")]) is None
    # An 18-month period after moving the balance date from June to December is not a missing year.
    assert rc.check_missing_year(org(month=12, day=31), [ret("2023-06-30"), ret("2024-12-31")]) is None
    # Group members, and a gap spent deregistered, are skipped.
    assert rc.check_missing_year(org(GroupId=5), [ret("2022-03-31"), ret("2024-03-31")]) is None
    assert rc.check_missing_year(org(DateRegistered="2023-11-01T00:00:00Z"), [ret("2022-03-31"), ret("2024-03-31")]) is None


def test_prior_year_check():
    last = ret("2025-03-31", TotalGrossIncome=36_247, spent=30_000)
    found = rc.check_prior_year(org(), [last, ret("2026-03-31", Total_Gross_Income_LastYear="20051.0000",
                                                    Total_Expenditure_LastYear="30000.0000")])
    assert found and found.check == "prior_year_mismatch" and found.details["value"] == 16_196
    assert "last year's income $20,051, not the $36,247 it reported" in found.summary
    # Within 5%, or left empty: fine.
    assert rc.check_prior_year(org(), [last, ret("2026-03-31", Total_Gross_Income_LastYear="36000",
                                                 Total_Expenditure_LastYear="30500")]) is None
    assert rc.check_prior_year(org(), [last, ret("2026-03-31", Total_Gross_Income_LastYear="0",
                                                 Total_Expenditure_LastYear="0")]) is None
    # Not a year apart: not compared.
    assert rc.check_prior_year(org(), [ret("2023-03-31", TotalGrossIncome=36_247), ret("2026-03-31",
                               Total_Gross_Income_LastYear="1", Total_Expenditure_LastYear="1")]) is None


def test_net_assets_check():
    found = rc.check_net_assets(org(), ret("2026-03-31", tier=3, TotalGrossIncome=100_000, Totalassetslesstotalliabilities=-50_000))
    assert found and found.details["shown"] == "-$50,000" and "liabilities exceed its assets by $50,000" in found.summary
    assert rc.check_net_assets(org(), ret("2026-03-31", tier=3, TotalGrossIncome=100_000, Totalassetslesstotalliabilities=-5_000)) is None
    # Tier 4 is cash-based: resources less commitments.
    t4 = rc.check_net_assets(org(), ret("2026-03-31", TotalGrossIncome=20_000, TotalResourcesLessCommittments=-15_000))
    assert t4 and "commitments exceed its resources" in t4.summary
    assert rc.check_net_assets(org(), None) is None


def test_deficits_check():
    years = [ret(f"{y}-03-31", TotalGrossIncome=100_000, spent=130_000) for y in (2024, 2025, 2026)]
    found = rc.check_deficits(org(), years)
    assert found and found.details["value"] == -90_000 and "three years running" in found.summary
    assert rc.check_deficits(org(), [years[0], ret("2025-03-31", TotalGrossIncome=100_000, spent=90_000), years[2]]) is None
    small = [ret(f"{y}-03-31", TotalGrossIncome=10_000, spent=13_000) for y in (2024, 2025, 2026)]
    assert rc.check_deficits(org(), small) is None  # $9,000 in all: under the floor


def test_swing_check():
    found = rc.check_swing(org(), [ret("2025-03-31", TotalGrossIncome=200_000), ret("2026-03-31", TotalGrossIncome=900_000)])
    assert found and found.details["shown"] == "income ×4.5" and "income went from $200,000 to $900,000" in found.summary
    assert rc.check_swing(org(), [ret("2025-03-31", TotalGrossIncome=200_000), ret("2026-03-31", TotalGrossIncome=500_000)]) is None
    fell = rc.check_swing(org(), [ret("2025-03-31", spent=1_000_000), ret("2026-03-31", spent=200_000)])
    assert fell and fell.details["shown"] == "spending -80%"


def test_staff_pay_check():
    found = rc.check_staff_pay(org(), ret("2026-03-31", tier=3, SalariesAndWages=76_520, NumberOfFulltimeEmployees=0))
    assert found and found.details["value"] == 76_520
    assert rc.check_staff_pay(org(), ret("2026-03-31", tier=3, SalariesAndWages=76_520, NumberOfParttimeEmployees=2)) is None
    assert rc.check_staff_pay(org(), ret("2026-03-31", tier=3, SalariesAndWages=76_520, AvgAllPaidHoursPerWeek=30)) is None
    assert rc.check_staff_pay(org(), ret("2026-03-31", tier=3, SalariesAndWages=20_000)) is None


def test_repeated_figures_check():
    same = [ret(f"{y}-03-31", TotalGrossIncome=15_856, spent=14_671) for y in (2025, 2026)]
    found = rc.check_repeated(org(), same)
    assert found and found.details["shown"] == "$15,856 / $14,671"
    assert rc.check_repeated(org(), [same[0], ret("2026-03-31", TotalGrossIncome=15_857, spent=14_671)]) is None
    assert rc.check_repeated(org(), [ret(f"{y}-03-31", TotalGrossIncome=500, spent=500) for y in (2025, 2026)]) is None


def test_every_finding_has_a_figure_to_sort_by():
    returns = [ret("2023-03-31", TotalGrossIncome=100_000, spent=130_000), ret("2024-03-31", TotalGrossIncome=100_000, spent=130_000),
               ret("2026-03-31", TotalGrossIncome=100_000, spent=130_000, Totalassetslesstotalliabilities=-90_000, tier=3)]
    found = rc.run_checks([org()], returns, TODAY, WINDOW)
    assert {f.check for f in found} >= {"missing_year", "negative_net_assets"}
    for f in found:
        if f.check != "year_end_mismatch":
            assert isinstance(f.details.get("value"), (int, float)) and f.details.get("shown"), f.check

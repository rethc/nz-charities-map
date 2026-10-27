#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "supabase>=2.31,<3",
#   "httpx>=0.28,<1",
# ]
# ///
"""
Annual return checks: flags charities whose annual returns are worth a closer look, using only
the Charities Register's public data feed (the same OData service the sync reads).

The results are for the site's admin area only (/admin/returns), never the public pages: an
automated check can be wrong, and a public "this charity failed" could hurt a small charity.
They are public data read after publication: a return still being processed, a withheld one
and anything an extension changes are invisible here.

The ten checks that need nothing but the feed (no statement PDFs), in three groups:

Acceptance
  year_end_mismatch     A1  the latest return's year end isn't the charity's registered balance date
  tier_over_limit       A2  filed under a tier the charity's size doesn't allow: over the limit for
                            longer than the rules allow, or moved down to a tier it's too big for
Register
  overdue               B1  the next return was due (6 months after the balance date) and none is filed
  missing_year          B2  a year is missing between two returns
  prior_year_mismatch   B3  the "last year" figures in a Tier 4 return differ from last year's own return
Indicators
  negative_net_assets   I1  liabilities exceed assets
  deficits              I2  spent more than it took in for three years running, by a fifth or more
  big_swing             I3  income or spending tripled, or fell by two thirds, by $500,000 or more
  staff_pay_no_staff    I4  $50,000 or more in staff pay, with no employees or paid hours reported
  repeated_figures      I5  income and spending exactly the same as the year before

Rules from https://www.charities.govt.nz/annual-reporting/which-tier-will-i-use (June 2026),
https://www.charities.govt.nz/annual-reporting/annual-return (due within 6 months of balance date)
and the XRB tier thresholds: Tier 4's rose from $125,000 to $140,000 for periods from 1 January 2022,
Tier 3's from $2m to $5m and Tier 2's from $30m to $33m for periods ending after 28 March 2024.

Only published returns are judged. A return the register hasn't published yet (still being
processed) only counts as "filed", so its charity isn't called overdue or missing a year.

Usage
  uv run scripts/return_checks.py                     # check, then replace the results in Supabase
  uv run scripts/return_checks.py --dry-run out.json  # check, and write the findings to a file

Environment: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (not needed with --dry-run);
GEOCODER_CONTACT names you in the User-Agent, as for the sync.
"""

from __future__ import annotations

import argparse
import calendar
import json
import logging
import os
import sys
import time
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, Iterable, Iterator

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sync_charities as sc  # noqa: E402

log = logging.getLogger("return_checks")

# The status the register gives a published return. Others (20, 21: a few dozen at a time) are
# returns still being processed, which the public register doesn't show yet.
PUBLISHED = 10
# How far back to read returns: enough for three years of one charity's returns, and to see
# when a charity last filed.
YEARS_BACK = 4
# Reporting tier -> (the limit on a year's operating payments or expenses, the years a charity
# may file over it before it must move up).
TIER_LIMITS = {4: (140_000, 2), 3: (5_000_000, 2), 2: (33_000_000, 1)}
# Reporting tier -> (the limit before it rose, the first year end judged by today's limit).
OLD_TIER_LIMITS = {4: (125_000, date(2022, 1, 1)), 3: (2_000_000, date(2024, 3, 31)), 2: (30_000_000, date(2024, 3, 31))}
TIER_LIMIT_SOURCE = "https://www.charities.govt.nz/annual-reporting/which-tier-will-i-use"
# The register's GroupType for a member of a registered group (the group files one return for
# all its members). Some members have it without a GroupId, such as the MAS Charitable Group's.
GROUP_MEMBER = 1
# Fewer charities than this back from the register means something went wrong upstream: the
# results are left as they are rather than replaced with a short list.
MIN_CHARITIES = 10_000
# Two returns this far apart, or more, have at least one year missing between them. A changed
# balance date can stretch one reporting period to 18 months (30 June to 31 December of the next
# year), but not this far.
GAP_DAYS = 640
# Returns this many days apart are a year apart (allowing for a balance date a few weeks out).
YEAR_APART = range(330, 401)
# Thresholds for the indicators: big enough to matter, so the lists stay worth reading.
DEBT_FLOOR = 10_000  # I1: net liabilities of at least this, and a tenth of a year's income
DEFICIT_SHARE, DEFICIT_FLOOR = 0.2, 50_000  # I2: each year's deficit a fifth of income; together this much
SWING_FACTOR, SWING_FLOOR = 3, 500_000  # I3: three times as much, or a third, and this many dollars
STAFF_PAY_FLOOR = 50_000  # I4
REPEAT_FLOOR = 1_000  # I5: both figures at least this, so empty or token returns don't count
# B3: last year's figures may round or be restated a little.
RESTATE_FLOOR, RESTATE_SHARE = 1_000, 0.05
# A short pause between pages of the feed, to go easy on the register's service.
PAGE_PAUSE = 0.5

ORG_FIELDS = (
    "OrganisationId", "CharityRegistrationNumber", "Name", "EndOfYearDayofMonth", "EndOfYearMonth",
    "AnnualReturnExtensionDate", "DateRegistered", "GroupId", "GroupType",
)
RETURN_FIELDS = (
    "AnnualReturnId", "OrganisationId", "Status", "YearEnded", "ReportingTierId", "TotalExpenditure",
    "TotalGrossIncome", "Totalassetslesstotalliabilities", "TotalResourcesLessCommittments",
    "Total_Gross_Income_LastYear", "Total_Expenditure_LastYear",
    "SalariesAndWages", "EmployeeRemunerationAndOtherRelatedExpenses",
    "NumberOfFulltimeEmployees", "NumberOfParttimeEmployees", "AvgAllPaidHoursPerWeek",
)


@dataclass(slots=True)
class Finding:
    check: str
    cc_number: str
    charity_name: str
    summary: str  # one plain sentence for the admin page
    year_ended: str | None = None  # ISO date of the return the finding is about
    annual_return_id: int | None = None
    # Per check. Every finding has `value` (a number to sort by) and `shown` (that number as the
    # admin page shows it) where it has a figure to show.
    details: dict[str, Any] = field(default_factory=dict)

    def payload(self) -> dict[str, Any]:
        row = asdict(self)
        row["check_name"] = row.pop("check")
        return row


# ---------------------------------------------------------------------------
# Dates and numbers
# ---------------------------------------------------------------------------

def to_date(value: Any) -> date | None:
    parsed = sc.parse_odata_datetime(value)
    return parsed.date() if parsed else None


def num(value: Any) -> float | None:
    """A figure from the feed: some come as numbers, some (decimals) as text, missing ones as null."""
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def add_months(day: date, months: int) -> date:
    """Same day of the month, months later. A month's last day stays a month's last day, as on
    the register: a 28 February balance date is due 31 August, a 31 March one 30 September."""
    year, month = divmod(day.month - 1 + months, 12)
    year, month = day.year + year, month + 1
    last = calendar.monthrange(year, month)[1]
    month_end = day.day == calendar.monthrange(day.year, day.month)[1]
    return date(year, month, last if month_end else min(day.day, last))


def balance_date_in(year: int, month: int, day: int) -> date:
    """The balance date in a given year (28 or 29 February both mean the month's end)."""
    last = calendar.monthrange(year, month)[1]
    return date(year, month, last if month == 2 and day >= 28 else min(day, last))


def same_balance_date(day: date, month: int, day_of_month: int) -> bool:
    # A late-February balance date ends on the 28th or the 29th in a leap year: both count.
    if month == 2 and day_of_month >= 28:
        return day.month == 2 and day.day >= 28
    return day == balance_date_in(day.year, month, day_of_month)


def next_balance_date(after: date, month: int | None, day_of_month: int | None) -> date:
    """The first balance date after the year that ended on `after`: on the registered date when
    there is one, else a year on. A date in the same month is the same year end written a day
    or two differently (28 or 29 February, 30 or 31 May), not a new one."""
    if not month or not day_of_month:
        return add_months(after, 12)
    candidate = balance_date_in(after.year, month, day_of_month)
    if candidate > after and (candidate.year, candidate.month) != (after.year, after.month):
        return candidate
    return balance_date_in(after.year + 1, month, day_of_month)


def nice(day: date) -> str:
    return f"{day.day} {day:%b %Y}"


def money(value: float) -> str:
    return f"-${-value:,.0f}" if value < 0 else f"${value:,.0f}"


def registered_balance(org: dict[str, Any]) -> tuple[int, int] | None:
    try:
        month, day = int(org.get("EndOfYearMonth") or 0), int(org.get("EndOfYearDayofMonth") or 0)
    except (TypeError, ValueError):
        return None
    return (month, day) if 1 <= month <= 12 and 1 <= day <= 31 else None


def tier_limit(tier: Any, ended: date | None) -> float | None:
    """The limit for a tier in the year that ended on `ended`. Tier 1 has none."""
    if tier not in TIER_LIMITS:
        return None
    old, since = OLD_TIER_LIMITS[tier]
    return old if ended and ended < since else TIER_LIMITS[tier][0]


def ended(r: dict[str, Any]) -> date | None:
    return to_date(r.get("YearEnded"))


def year_apart(earlier: dict[str, Any], later: dict[str, Any]) -> bool:
    a, b = ended(earlier), ended(later)
    return bool(a and b and (b - a).days in YEAR_APART)


def is_group_member(org: dict[str, Any]) -> bool:
    return bool(org.get("GroupId")) or org.get("GroupType") == GROUP_MEMBER


def finding(org: dict[str, Any], check: str, summary: str, about: dict[str, Any] | None = None,
            **details: Any) -> Finding:
    """A finding about one return (`about`), or about the charity when there's none."""
    year = ended(about) if about else None
    return Finding(
        check=check,
        cc_number=org["CharityRegistrationNumber"],
        charity_name=org["Name"],
        summary=summary,
        year_ended=year.isoformat() if year else None,
        annual_return_id=about.get("AnnualReturnId") if about else None,
        details=details,
    )


# ---------------------------------------------------------------------------
# Acceptance
# ---------------------------------------------------------------------------

def check_year_end(org: dict[str, Any], latest: dict[str, Any] | None) -> Finding | None:
    """A1. The latest published return should end on the charity's registered balance date."""
    balance = registered_balance(org)
    end = ended(latest) if latest else None
    if not balance or not end or same_balance_date(end, *balance):
        return None
    month, day = balance
    registered = f"{day} {calendar.month_name[month]}"
    return finding(
        org, "year_end_mismatch",
        f"The latest return is for the year ended {nice(end)}, but the registered balance date is {registered}. "
        "Expected if the charity has since changed its balance date.",
        latest, registered_balance_date=registered, return_year_ended=end.isoformat(),
    )


def spent(r: dict[str, Any]) -> float:
    return num(r.get("TotalExpenditure")) or 0.0


def check_tier_limit(org: dict[str, Any], published: list[dict[str, Any]]) -> Finding | None:
    """A2. The tier must suit the charity's size: over a tier's limit for more years running than
    the rules allow and still in that tier, or moved down to a tier whose limit it's over (a
    charity may only move down when it meets the lower tier's criteria). Each year is judged by
    the limits of its own time."""
    returns = sorted(published, key=lambda r: r.get("YearEnded") or "")
    if not returns:
        return None
    latest = returns[-1]
    tier = latest.get("ReportingTierId")
    if tier not in TIER_LIMITS:
        return None
    grace = TIER_LIMITS[tier][1]
    what = "operating payments" if tier == 4 else "expenses"
    run = returns[-(grace + 1):]
    if len(run) == grace + 1 and all(
        r.get("ReportingTierId") == tier and spent(r) >= (tier_limit(tier, ended(r)) or 0) for r in run
    ):
        years = [ended(r) for r in run]
        limits = [tier_limit(tier, y) for y in years]
        amounts = [spent(r) for r in run]
        listed = ", ".join(f"{money(s)} ({y.year if y else '?'})" for s, y in zip(amounts, years))
        changed = len(set(limits)) > 1
        return finding(
            org, "tier_over_limit",
            f"Filed as Tier {tier} for the last {len(run)} returns with {what} of {listed}, all at or over "
            f"the Tier {tier} limit{' of each year' if changed else f' of {money(limits[-1])}'}. The rules allow "
            f"{grace} year{'s' if grace > 1 else ''} over before moving up.",
            latest, reason="stayed", tier=tier, limit=limits[-1], limits=limits, spent=amounts,
            years=[y.isoformat() if y else None for y in years], source=TIER_LIMIT_SOURCE,
            value=amounts[-1] / limits[-1], shown=f"{amounts[-1] / limits[-1]:.1f}× limit",
        )
    if len(returns) < 2:
        return None
    before = returns[-2].get("ReportingTierId")
    limit = tier_limit(tier, ended(latest))
    if before not in (1, 2, 3, 4) or tier <= before or not limit or spent(latest) < limit:
        return None
    end = ended(latest)
    return finding(
        org, "tier_over_limit",
        f"Moved down from Tier {before} to Tier {tier} for the year ended {nice(end) if end else '?'}, but its "
        f"{what} of {money(spent(latest))} are over the Tier {tier} limit of {money(limit)}. A charity can only "
        "move down to a tier whose criteria it meets.",
        latest, reason="moved_down", tier=tier, from_tier=before, limit=limit, limits=[limit], spent=[spent(latest)],
        years=[end.isoformat() if end else None], source=TIER_LIMIT_SOURCE,
        value=spent(latest) / limit, shown=f"{spent(latest) / limit:.1f}× limit",
    )


# ---------------------------------------------------------------------------
# Register
# ---------------------------------------------------------------------------

def check_overdue(org: dict[str, Any], filed: list[dict[str, Any]], today: date, window_start: date) -> Finding | None:
    """B1. The return for the year after the last one filed is due 6 months after that year ends.
    A member of a registered group is skipped: its group files for it.

    A charity with no return of its own in the window is only judged when it registered within
    the window (its first return is late). An older one is most likely filed for by a group the
    feed doesn't record it in: the register shows some Presbyterian parishes as members of their
    church's group while the feed lists them as standalone charities."""
    if is_group_member(org):
        return None
    ends = [d for d in (ended(r) for r in filed) if d]
    balance = registered_balance(org)
    month, day = balance if balance else (None, None)
    registered = to_date(org.get("DateRegistered"))
    if ends:
        last = max(ends)
        # A charity registered again after its last return starts afresh from its new registration.
        year_end = next_balance_date(max(last, registered) if registered else last, month, day)
    else:
        if not registered or registered < window_start:
            return None
        last = None
        year_end = next_balance_date(registered, month, day)
    due = add_months(year_end, 6)
    extension = to_date(org.get("AnnualReturnExtensionDate"))
    if extension and extension > due:
        due = extension
    if today <= due:
        return None
    days = (today - due).days
    if last:
        summary = (f"The return for the year ended {nice(year_end)} was due {nice(due)} ({days:,} days ago) "
                   f"and hasn't been filed. The last one was for the year ended {nice(last)}.")
    else:
        summary = (f"Registered {nice(registered)} and hasn't filed a return yet. "
                   f"The first one, for the year ended {nice(year_end)}, was due {nice(due)} ({days:,} days ago).")
    return Finding(
        check="overdue",
        cc_number=org["CharityRegistrationNumber"],
        charity_name=org["Name"],
        summary=summary,
        year_ended=year_end.isoformat(),
        details={"due": due.isoformat(), "days_overdue": days, "last_year_ended": last.isoformat() if last else None,
                 "extension": extension.isoformat() if extension else None, "value": days, "shown": f"{days:,} days"},
    )


def check_missing_year(org: dict[str, Any], filed: list[dict[str, Any]]) -> Finding | None:
    """B2. Returns filed (published or not) should follow on year after year. Group members are
    skipped, as for B1, and so is a gap the charity spent deregistered (it registered again
    inside it). Reports the latest gap."""
    if is_group_member(org):
        return None
    ends = sorted({d for d in (ended(r) for r in filed) if d})
    registered = to_date(org.get("DateRegistered"))
    balance = registered_balance(org)
    month, day = balance if balance else (None, None)
    for before, after in reversed(list(zip(ends, ends[1:]))):
        if (after - before).days < GAP_DAYS or (registered and before < registered <= after):
            continue
        missing: list[date] = []
        year_end = next_balance_date(before, month, day)
        while (after - year_end).days > 31 and len(missing) < 10:
            missing.append(year_end)
            year_end = next_balance_date(year_end, month, day)
        if not missing:
            missing = [add_months(before, 12)]
        if len(missing) == 1:
            names = f"the year ended {nice(missing[0])}"
        elif len(missing) == 2:
            names = f"the years ended {nice(missing[0])} and {nice(missing[1])}"
        else:
            names = f"{len(missing)} years"
        later = max((r for r in filed if ended(r) == after), key=lambda r: r.get("AnnualReturnId") or 0)
        return finding(
            org, "missing_year",
            f"No return for {names}: returns were filed for the years ended {nice(before)} and {nice(after)}.",
            later, missing=[d.isoformat() for d in missing], before=before.isoformat(), after=after.isoformat(),
            value=len(missing), shown=", ".join(str(d.year) for d in missing),
        )
    return None


def check_prior_year(org: dict[str, Any], published: list[dict[str, Any]]) -> Finding | None:
    """B3. A Tier 4 return repeats last year's income and payments beside this year's. They should
    match what the charity reported for that year. Only judged where the return fills them in."""
    if len(published) < 2:
        return None
    prev, cur = sorted(published, key=lambda r: r.get("YearEnded") or "")[-2:]
    if not year_apart(prev, cur):
        return None
    said_income, said_spent = num(cur.get("Total_Gross_Income_LastYear")), num(cur.get("Total_Expenditure_LastYear"))
    if not said_income or not said_spent:  # left empty or zero: not filled in
        return None
    was_income, was_spent = num(prev.get("TotalGrossIncome")) or 0.0, spent(prev)

    def off(said: float, was: float) -> bool:
        return abs(said - was) > max(RESTATE_FLOOR, RESTATE_SHARE * abs(was))

    pairs = [("income", said_income, was_income), ("payments", said_spent, was_spent)]
    wrong = [(what, said, was) for what, said, was in pairs if off(said, was)]
    if not wrong:
        return None
    a, b = ended(prev), ended(cur)
    told = "; ".join(f"{what} {money(said)}, not the {money(was)} it reported" for what, said, was in wrong)
    gap = max(abs(said - was) for _, said, was in wrong)
    return finding(
        org, "prior_year_mismatch",
        f"The return for the year ended {nice(b) if b else '?'} gives last year's {told} for the year ended "
        f"{nice(a) if a else '?'}.",
        cur, said_income=said_income, said_spent=said_spent, was_income=was_income, was_spent=was_spent,
        previous_return_id=prev.get("AnnualReturnId"), value=gap, shown=money(gap),
    )


# ---------------------------------------------------------------------------
# Indicators
# ---------------------------------------------------------------------------

def net_assets(r: dict[str, Any]) -> float | None:
    """Assets less liabilities; for Tier 4 (cash), resources less commitments."""
    key = "TotalResourcesLessCommittments" if r.get("ReportingTierId") == 4 else "Totalassetslesstotalliabilities"
    return num(r.get(key))


def check_net_assets(org: dict[str, Any], latest: dict[str, Any] | None) -> Finding | None:
    """I1. Liabilities exceed assets by a material amount: at least DEBT_FLOOR and a tenth of income."""
    if not latest:
        return None
    net = net_assets(latest)
    income = num(latest.get("TotalGrossIncome")) or 0.0
    if net is None or net > -DEBT_FLOOR or net > -0.1 * income:
        return None
    end = ended(latest)
    owes = "commitments exceed its resources" if latest.get("ReportingTierId") == 4 else "liabilities exceed its assets"
    return finding(
        org, "negative_net_assets",
        f"At {nice(end) if end else '?'} its {owes} by {money(-net)}, against income of {money(income)} that year.",
        latest, net=net, income=income, value=net, shown=money(net),
    )


def check_deficits(org: dict[str, Any], published: list[dict[str, Any]]) -> Finding | None:
    """I2. Three years running of spending more than it took in, each by a fifth of that year's
    income or more, and DEFICIT_FLOOR or more in all."""
    run = sorted(published, key=lambda r: r.get("YearEnded") or "")[-3:]
    if len(run) < 3 or not all(year_apart(a, b) for a, b in zip(run, run[1:])):
        return None
    incomes = [num(r.get("TotalGrossIncome")) for r in run]
    spends = [num(r.get("TotalExpenditure")) for r in run]
    if any(v is None for v in incomes + spends):
        return None
    gaps = [i - s for i, s in zip(incomes, spends)]  # type: ignore[operator]
    if not all(g < -DEFICIT_SHARE * max(i, 1) for g, i in zip(gaps, incomes)) or sum(gaps) > -DEFICIT_FLOOR:  # type: ignore[arg-type]
        return None
    years = [ended(r) for r in run]
    listed = ", ".join(f"{money(g)} ({y.year if y else '?'})" for g, y in zip(gaps, years))
    net = net_assets(run[-1])
    left = f" Net assets at the end: {money(net)}." if net is not None else ""
    return finding(
        org, "deficits",
        f"Spent more than it took in for three years running: {listed}.{left}",
        run[-1], deficits=gaps, years=[y.isoformat() if y else None for y in years], net=net,
        value=sum(gaps), shown=money(sum(gaps)),
    )


def check_swing(org: dict[str, Any], published: list[dict[str, Any]]) -> Finding | None:
    """I3. Income or spending tripled, or fell to a third, from one year to the next, by
    SWING_FLOOR or more. Often a one-off grant or bequest: worth seeing that the return says so."""
    if len(published) < 2:
        return None
    prev, cur = sorted(published, key=lambda r: r.get("YearEnded") or "")[-2:]
    if not year_apart(prev, cur):
        return None
    moves = []
    for key, what in (("TotalGrossIncome", "income"), ("TotalExpenditure", "spending")):
        was, now = num(prev.get(key)), num(cur.get(key))
        if not was or was <= 0 or now is None or now < 0:
            continue
        if abs(now - was) >= SWING_FLOOR and (now >= SWING_FACTOR * was or now <= was / SWING_FACTOR):
            moves.append((what, was, now))
    if not moves:
        return None
    a, b = ended(prev), ended(cur)
    told = " and ".join(f"{what} went from {money(was)} to {money(now)}" for what, was, now in moves)
    what, was, now = max(moves, key=lambda m: abs(m[2] - m[1]))
    factor = now / was
    return finding(
        org, "big_swing",
        f"From the year ended {nice(a) if a else '?'} to {nice(b) if b else '?'}, {told}.",
        cur, moves=[{"what": w, "was": x, "now": y} for w, x, y in moves],
        value=abs(now - was), shown=f"{what} ×{factor:.1f}" if factor >= 1 else f"{what} {factor - 1:.0%}",
    )


def check_staff_pay(org: dict[str, Any], latest: dict[str, Any] | None) -> Finding | None:
    """I4. Staff pay of STAFF_PAY_FLOOR or more, yet no full- or part-time employees and no paid
    hours: one of the figures is likely wrong."""
    if not latest:
        return None
    pay = max(num(latest.get("SalariesAndWages")) or 0.0, num(latest.get("EmployeeRemunerationAndOtherRelatedExpenses")) or 0.0)
    staff = (num(latest.get("NumberOfFulltimeEmployees")) or 0) + (num(latest.get("NumberOfParttimeEmployees")) or 0)
    hours = num(latest.get("AvgAllPaidHoursPerWeek")) or 0
    if pay < STAFF_PAY_FLOOR or staff or hours:
        return None
    end = ended(latest)
    return finding(
        org, "staff_pay_no_staff",
        f"The return for the year ended {nice(end) if end else '?'} reports {money(pay)} of staff pay but no "
        "employees and no paid hours.",
        latest, pay=pay, value=pay, shown=money(pay),
    )


def check_repeated(org: dict[str, Any], published: list[dict[str, Any]]) -> Finding | None:
    """I5. Income and spending to the dollar the same as the year before: often last year's
    return copied forward."""
    if len(published) < 2:
        return None
    prev, cur = sorted(published, key=lambda r: r.get("YearEnded") or "")[-2:]
    if not year_apart(prev, cur):
        return None
    was = (num(prev.get("TotalGrossIncome")), num(prev.get("TotalExpenditure")))
    now = (num(cur.get("TotalGrossIncome")), num(cur.get("TotalExpenditure")))
    if was != now or any(v is None or v < REPEAT_FLOOR for v in now):
        return None
    a, b = ended(prev), ended(cur)
    income, spending = now
    return finding(
        org, "repeated_figures",
        f"Income of {money(income)} and spending of {money(spending)} for the year ended {nice(b) if b else '?'}, "  # type: ignore[arg-type]
        f"exactly as for the year ended {nice(a) if a else '?'}.",
        cur, income=income, spending=spending, previous_return_id=prev.get("AnnualReturnId"),
        value=income, shown=f"{money(income)} / {money(spending)}",  # type: ignore[arg-type]
    )


# ---------------------------------------------------------------------------
# Running them
# ---------------------------------------------------------------------------

def run_checks(orgs: Iterable[dict[str, Any]], returns: Iterable[dict[str, Any]], today: date,
               window_start: date) -> list[Finding]:
    by_org: dict[Any, list[dict[str, Any]]] = defaultdict(list)
    for r in returns:
        if r.get("OrganisationId") is not None:
            by_org[r["OrganisationId"]].append(r)
    findings: list[Finding] = []
    for org in orgs:
        if not org.get("CharityRegistrationNumber") or not org.get("Name"):
            continue
        filed = by_org.get(org["OrganisationId"], [])
        published = sorted((r for r in filed if r.get("Status") == PUBLISHED), key=lambda r: r.get("YearEnded") or "")
        latest = published[-1] if published else None
        for found in (
            check_year_end(org, latest), check_tier_limit(org, published),
            check_overdue(org, filed, today, window_start), check_missing_year(org, filed), check_prior_year(org, published),
            check_net_assets(org, latest), check_deficits(org, published), check_swing(org, published),
            check_staff_pay(org, latest), check_repeated(org, published),
        ):
            if found:
                findings.append(found)
    findings.sort(key=lambda f: (f.check, f.cc_number))
    return findings


# ---------------------------------------------------------------------------
# Data in, results out
# ---------------------------------------------------------------------------

def paced(rows: Iterable[dict[str, Any]]) -> Iterator[dict[str, Any]]:
    """Pass the feed's rows through, pausing after each page."""
    for n, row in enumerate(rows, 1):
        yield row
        if n % sc.ODATA_PAGE_SIZE == 0:
            time.sleep(PAGE_PAUSE)


def fetch(client: httpx.Client, window_start: date) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    orgs = list(paced(sc.fetch_keyset(client, "Organisations", "OrganisationId", ORG_FIELDS,
                                      since=None, registered_only=True)))
    for org in orgs:
        org["CharityRegistrationNumber"] = sc.clean_cc_number(org.get("CharityRegistrationNumber"))
        org["Name"] = sc.clean_text(org.get("Name"))
    since = sc.odata_datetime_literal(datetime(window_start.year, window_start.month, window_start.day, tzinfo=UTC))
    returns = list(paced(sc.fetch_keyset(client, "AnnualReturn", "AnnualReturnId", RETURN_FIELDS,
                                         since=None, registered_only=False, where=f"YearEnded ge {since}")))
    return orgs, returns


def write_summary(findings: list[Finding], today: date) -> None:
    counts: dict[str, int] = defaultdict(int)
    for f in findings:
        counts[f.check] += 1
    lines = [f"Annual return checks, {today.isoformat()} (public data, post-publication):"]
    lines += [f"  {name}: {n}" for name, n in sorted(counts.items())]
    log.info("\n".join(lines))
    # Counts only: the repository's Action logs are public, and these results are for admins.
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as fh:
            fh.write("### Annual return checks\n\nPublic data, post-publication.\n\n| Check | Charities |\n| --- | --- |\n")
            fh.writelines(f"| {name} | {n} |\n" for name, n in sorted(counts.items()))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dry-run", metavar="FILE", help="write the findings to FILE instead of Supabase")
    parser.add_argument("--today", help="check as if it were this date (YYYY-MM-DD), for testing")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    today = date.fromisoformat(args.today) if args.today else datetime.now(UTC).date()
    window_start = date(today.year - YEARS_BACK, 1, 1)
    sb = None if args.dry_run else sc.make_supabase()  # fail fast on missing settings
    contact = os.environ.get("GEOCODER_CONTACT", "https://github.com/rethc/nz-charities-map").strip()
    with httpx.Client(timeout=120, headers={
        "User-Agent": f"Mozilla/5.0 (compatible; nz-charities-map-return-checks/1.0; +{contact})"}) as client:
        orgs, returns = fetch(client, window_start)
    log.info("Read %s registered charities and %s returns for years ending since %s", len(orgs), len(returns), window_start)
    if len(orgs) < MIN_CHARITIES:
        log.error("Only %s charities came back from the register; leaving the results as they are", len(orgs))
        return 1

    findings = run_checks(orgs, returns, today, window_start)
    write_summary(findings, today)
    payload = [f.payload() for f in findings]
    if args.dry_run:
        Path(args.dry_run).write_text(json.dumps({"checked": today.isoformat(), "findings": payload}, indent=1),
                                      encoding="utf-8")
        log.info("Wrote %s findings to %s", len(payload), args.dry_run)
        return 0
    stored = sb.rpc("replace_return_checks", {"p_findings": payload}).execute().data
    log.info("Stored %s findings", stored)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "supabase>=2.31,<3",
#   "httpx>=0.28,<1",
# ]
# ///
"""
Intelligence: reads every registered charity's last five years from the Charities Register's
public data feed (annual returns, officers, what each charity says it does) and works out a
set of measures per charity, each set against other charities of the same size.

The results are for the site's admin area only (/admin/intelligence), never the public pages:
a measure is a reason to look, not a finding. They are public data read after publication, so a
return still being processed, a withheld one and anything an extension changes are invisible.

Measures. The eight marked * are signals: each has a "worth a look" and a "priority" level,
and the watchlist ranks charities by how many they trip.

Money
  income               total revenue on the latest return
  income_change        revenue compared with the year before
  asset_growth_gap  *  net assets grew faster than expenses over 3 years (percentage points)
  reserves_years    *  net assets as years of expenses
  current_ratio     *  current assets compared with current liabilities (low is the signal)
Activity
  trading_share        share of revenue from goods, services and commercial activities
  dormant_years     *  years of the last 5 with next to no revenue or expenses
  overseas_share       share of its funds the charity says it spends overseas
Governance
  income_per_officer*  revenue for each current officer, where there are 3 or fewer
  officer_turnover     share of the officers leaving each year, on average
  shared_boards        other charities with an officer of the same name
Reporting
  late_returns      *  years of the last five with a late or missing return
  return_quality    *  totals on the latest return that are blank, or don't add up
  modified_audits   *  years of the last five with a modified audit opinion declared

The words are the External Reporting Board's (XRB): revenue, expenses, net assets. For a Tier 4
charity, which reports cash, revenue means operating receipts and expenses operating payments;
the script's own names for them (income, spend, funds) follow the feed's columns.

A charity is compared with others in its tier, worked out from its annual expenses and the
XRB's limits (under $140,000, $5 million and $33 million), not read off its return: some small
charities tick Tier 1, and some returns carry no tier.

When a return was filed isn't in the feed. Where a return has no approval date, it is worked
out from the register's own numbering: returns are numbered in the order they arrive, so the
returns numbered either side of one show when it came in, even if it was corrected years later.

Usage
  uv run scripts/intelligence.py                    # work it out, then replace the results in Supabase
  uv run scripts/intelligence.py --dry-run DIR      # work it out, and write snapshot.json and details.json to DIR
  uv run scripts/intelligence.py --raw feed.json.gz # keep the feed in a file, and read it from there next time

With `--dry-run .intel-preview`, `npm run dev` shows the pages from those files with no database:
see "Intelligence" in the README.

Environment: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (not needed with --dry-run);
GEOCODER_CONTACT names you in the User-Agent, as for the sync.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import logging
import os
import re
import statistics
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
import return_checks as rc  # noqa: E402
import sync_charities as sc  # noqa: E402

log = logging.getLogger("intelligence")

# How many years each charity is read over.
YEARS = 5
# A return this many days past its due date (6 months after the balance date) is late. The same
# allowance the annual return checks give before listing a return as overdue.
GRACE_DAYS = 60
# Income and spending both under this: a year with next to no activity.
NEAR_ZERO = 1_000
# Size bands, named after the tier a charity of that size reports under: the most a year's
# spending can be. Anything over the last is band 1. Band 0: no return to judge the size by.
BAND_LIMITS = ((4, 140_000), (3, 5_000_000), (2, 33_000_000))
# How many returns numbered either side of one are read to work out when it was filed.
NEIGHBOURS = 100
# Totals may differ by this much before they count as not adding up: small slips aren't worth a look.
MISMATCH_FLOOR, MISMATCH_SHARE = 5_000, 0.05
# The most other charities listed as sharing officers with one charity.
LINKS_SHOWN = 8
# Names on more boards than this are left out of the shared-board count: almost always several
# people with one common name, or a professional trustee.
COMMON_NAME_BOARDS = 40
UPLOAD_BATCH = 500

# The signals: where "worth a look" and "priority" start. `floor` is what else must hold, so a
# large ratio on small money doesn't count. The admin pages show these beside each measure.
SIGNALS: dict[str, dict[str, Any]] = {
    "asset_growth_gap": {"look": 100, "priority": 300, "floor": 250_000},
    "reserves_years": {"look": 25, "priority": 100, "floor": 1_000_000},
    "current_ratio": {"look": 0.5, "priority": 0.1, "floor": 50_000, "low": True},
    "dormant_years": {"look": 3, "priority": 5},
    "income_per_officer": {"look": 500_000, "priority": 2_000_000, "officers": 3},
    "late_returns": {"look": 2, "priority": 4},
    "return_quality": {"look": 1, "priority": 2},
    "modified_audits": {"look": 1, "priority": 3},
}
SIGNAL_KEYS = tuple(SIGNALS)
# A charity with this many signals at "worth a look" or above is on the combined watchlist.
COMBINED_THRESHOLD = 2

# One row of the snapshot, in this order (the page reads the order from the snapshot itself).
COLUMNS = (
    "cc", "name", "band", "tier", "sector", "income", "spend", "funds",
    "income_change", "asset_growth_gap", "reserves_years", "current_ratio",
    "trading_share", "dormant_years", "overseas_share",
    "income_per_officer", "officers", "officer_turnover", "shared_boards",
    "late_returns", "return_quality", "modified_audits",
    "levels",
)

ORG_FIELDS = (
    "OrganisationId", "CharityRegistrationNumber", "Name", "EndOfYearDayofMonth", "EndOfYearMonth",
    "AnnualReturnExtensionDate", "DateRegistered", "GroupId", "GroupType", "PercentageSpentOverseas",
    "StreetAddressCity",
)
# The register's own view of each charity, for the names of its sector, activity and beneficiary
# (the ids on the record don't match the feed's MainSector / MainBeneficiary tables) and where it works.
VIEW_FIELDS = ("OrganisationId", "MainSectorName", "MainActivityName", "MainBeneficiaryName", "AreasOfOperation")
RETURN_FIELDS = (
    "AnnualReturnId", "OrganisationId", "Status", "YearEnded", "ReportingTierId", "ModifiedOn", "Approvedby_Date",
    "TotalGrossIncome", "TotalExpenditure", "SurplusDeficit", "NetSurplusDeficitForTheYear",
    "TotalAssets", "TotalLiabilities", "Totalassetslesstotalliabilities", "TotalEquity",
    "TotalResources", "TotalResourcesLessCommittments", "TotalCashBalancesHeld",
    "AllCurrentAssets", "AllCurrentLiabilities", "CashAndBankBalances", "CashAndShortTermDeposits",
    "DebtorsAndPrepayments", "ReceivablesFromExchangeTransactionsAndRecoverableFromNonExchange", "Inventory",
    "OtherCurrentAssets", "AllOtherShortterMassets", "Investments",
    "ServiceTradingIncome", "RevenueFromCommercialActivities", "OtherRevenueFromExchangeTransactions",
    "IsFinancialReportAudited", "IsModifiedAuditOpinionReceived", "IfFinancialStmtContainRelatedPartyTrans",
)
OFFICER_FIELDS = (
    "OfficerId", "OrganisationId", "FullName", "OfficerStatus", "PositionAppointmentDate", "LastDateAsAnOfficer",
    "IsaBodyCorporate",
)
# The parts of current assets on the returns that don't give the total.
CURRENT_ASSET_PARTS = (
    "CashAndBankBalances", "CashAndShortTermDeposits", "DebtorsAndPrepayments",
    "ReceivablesFromExchangeTransactionsAndRecoverableFromNonExchange", "Inventory", "OtherCurrentAssets",
    "AllOtherShortterMassets",
)
TRADING_FIELDS = ("ServiceTradingIncome", "RevenueFromCommercialActivities", "OtherRevenueFromExchangeTransactions")
# Officers the register counts as serving now.
SERVING = "Qualified"

num = rc.num
to_date = rc.to_date


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def money(value: float) -> str:
    """$18.6 million, $668,000, $940: for sentences, as the government's style guide writes money."""
    sign, v = ("-" if value < 0 else ""), abs(value)
    if v >= 999_950_000:
        return f"{sign}${v / 1e9:.1f} billion"
    if v >= 999_950:
        return f"{sign}${v / 1e6:.1f} million"
    return f"{sign}${round(v, -3 if v >= 10_000 else 0):,.0f}"


def change(share: float) -> str:
    """grew 208%, fell 12%, did not change."""
    if abs(share) < 0.005:
        return "did not change"
    return f"{'grew' if share > 0 else 'fell'} {abs(share):.0%}"


# What a charity holds, in the Tier 1 to 3 standards' words, or a Tier 4 (cash) return's.
FUNDS_NAME = {"net_assets": "net assets", "resources": "resources less commitments", "cash": "cash held"}


def rounded(value: float | None, places: int = 0) -> float | int | None:
    if value is None:
        return None
    return int(round(value)) if places == 0 else round(value, places)


def last_complete_year(today: date) -> int:
    """The latest year whose returns are all due: a 31 December year end is due 30 June, and
    late once the allowance has passed."""
    due = rc.add_months(date(today.year - 1, 12, 31), 6) + timedelta(days=GRACE_DAYS)
    return today.year - 1 if today > due else today.year - 2


def band_for(spend: float | None, income: float | None) -> int:
    size = spend if spend is not None else income
    if size is None:
        return 0
    for band, limit in BAND_LIMITS:
        if size < limit:
            return band
    return 1


def name_key(full_name: Any) -> str | None:
    """A person's name as something to match on: letters only, lower case, without macrons.
    Hashed, so no officer's name is kept. None for a name too short to match on."""
    text = sc.ascii_fold(str(full_name or "")).lower()
    words = re.findall(r"[a-z]+", text)
    if len(words) < 2 or sum(map(len, words)) < 6:
        return None
    return hashlib.blake2b(" ".join(words).encode(), digest_size=8).hexdigest()


def tier_of(r: dict[str, Any]) -> int | None:
    tier = r.get("ReportingTierId")
    return tier if tier in (1, 2, 3, 4) else None


def funds_of(r: dict[str, Any]) -> tuple[float | None, str | None]:
    """What the charity holds, and on what basis: net assets where the return gives them; for a
    Tier 4 (cash) return, resources less commitments, or the cash it holds."""
    net = num(r.get("Totalassetslesstotalliabilities"))
    if net is None:
        net = num(r.get("TotalEquity"))
    if net is None and num(r.get("TotalAssets")) is not None and num(r.get("TotalLiabilities")) is not None:
        net = num(r["TotalAssets"]) - num(r["TotalLiabilities"])  # type: ignore[operator]
    if tier_of(r) != 4 and net is not None:
        return net, "net_assets"
    resources = num(r.get("TotalResourcesLessCommittments"))
    if resources is not None and (resources or net is None):
        return resources, "resources"
    if net is not None:
        return net, "net_assets"
    cash = num(r.get("TotalCashBalancesHeld"))
    return (cash, "cash") if cash is not None else (None, None)


def current_assets(r: dict[str, Any]) -> float | None:
    """Current assets: the return's own total, or its parts added up when the total is blank."""
    total = num(r.get("AllCurrentAssets"))
    if total:
        return total
    parts = [v for v in (num(r.get(k)) for k in CURRENT_ASSET_PARTS) if v]
    if not parts:
        return total
    assets = num(r.get("TotalAssets"))
    added = sum(parts)
    # Parts that come to more than everything the charity owns have been counted twice.
    if assets is not None and added > assets * 1.001:
        return None
    return added


def trading_income(r: dict[str, Any]) -> float | None:
    parts = [num(r.get(k)) for k in TRADING_FIELDS]
    return None if all(p is None for p in parts) else sum(p or 0.0 for p in parts)


# ---------------------------------------------------------------------------
# When each return was filed
# ---------------------------------------------------------------------------

def estimate_filed(returns: Iterable[dict[str, Any]]) -> dict[int, tuple[date, str]]:
    """AnnualReturnId -> (the day it was filed, as near as the feed tells, and how we know).

    'approved': the approval date on the return (only the newest forms have one).
    'estimated': the register numbers returns in the order they arrive, and the returns numbered
    either side of one were last changed within a day or two of each other, unless one was
    corrected later. So the middle change date of the NEIGHBOURS returns either side is the day
    they all arrived, and a return corrected years later keeps the date it came in. Checked
    against the returns that do carry an approval date, it lands within a few days."""
    rows = []
    for r in returns:
        rid, modified = r.get("AnnualReturnId"), to_date(r.get("ModifiedOn"))
        if rid is not None and modified:
            rows.append((int(rid), modified, to_date(r.get("YearEnded")), to_date(r.get("Approvedby_Date"))))
    rows.sort(key=lambda row: row[0])
    days = [modified.toordinal() for _, modified, _, _ in rows]
    out: dict[int, tuple[date, str]] = {}
    for i, (rid, modified, year_end, approved) in enumerate(rows):
        if approved and (not year_end or approved >= year_end) and approved <= modified:
            out[rid] = (approved, "approved")
            continue
        around = sorted(days[max(0, i - NEIGHBOURS):i + NEIGHBOURS + 1])
        estimate = min(modified, date.fromordinal(around[len(around) // 2]))
        if year_end and estimate < year_end <= modified:  # can't arrive before the year it covers has ended
            estimate = year_end
        out[rid] = (estimate, "estimated")
    return out


# ---------------------------------------------------------------------------
# One charity, year by year
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class Officer:
    key: str | None
    start: date | None
    end: date | None
    serving: bool

    def on(self, day: date) -> bool:
        return (self.start is None or self.start <= day) and (self.end is None or self.end > day) and (
            self.serving or self.end is not None)


@dataclass(slots=True)
class Year:
    fy: int
    ended: date | None = None
    # on_time, late, missing, processing (filed, not yet published), group (its group files),
    # none (no return expected: before it registered, not yet due, or inside a longer period).
    status: str = "none"
    filed: date | None = None
    filed_basis: str | None = None
    due: date | None = None
    income: float | None = None
    spend: float | None = None
    funds: float | None = None
    funds_basis: str | None = None
    tier: int | None = None
    audited: bool | None = None
    modified: bool | None = None
    related: bool | None = None
    officers: int | None = None
    ret: dict[str, Any] | None = None

    def row(self) -> list[Any]:
        """As the charity page reads it."""
        return [
            self.fy, self.ended.isoformat() if self.ended else None, self.status,
            self.filed.isoformat() if self.filed else None, self.filed_basis,
            rounded(self.income), rounded(self.spend), rounded(self.funds), self.funds_basis, self.tier,
            self.audited, self.modified, self.related, self.officers,
        ]


YEAR_COLUMNS = ("fy", "ended", "status", "filed", "filed_basis", "income", "spend", "funds", "funds_basis", "tier",
                "audited", "modified", "related", "officers")


@dataclass(slots=True)
class Charity:
    org: dict[str, Any]
    cc: str
    name: str
    span: list[Year]  # every year from the first the overview covers to its latest
    officers: list[Officer]
    latest: Year | None = None
    values: dict[str, Any] = field(default_factory=dict)
    levels: dict[str, int] = field(default_factory=dict)
    why: dict[str, str] = field(default_factory=dict)
    quality: list[str] = field(default_factory=list)
    band: int = 0
    links: list[tuple[str, int]] = field(default_factory=list)
    view: dict[str, Any] = field(default_factory=dict)
    note: str | None = None

    @property
    def years(self) -> list[Year]:
        """Its last five years: what it is measured over."""
        return self.span[-YEARS:]

    @property
    def signals(self) -> int:
        return sum(1 for v in self.levels.values() if v)


def dedupe_returns(returns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One return per year end (the one numbered last: a correction replaces the original), oldest first."""
    by_end: dict[date, dict[str, Any]] = {}
    for r in returns:
        end = rc.ended(r)
        if end and (end not in by_end or (r.get("AnnualReturnId") or 0) > (by_end[end].get("AnnualReturnId") or 0)):
            by_end[end] = r
    return [by_end[d] for d in sorted(by_end)]


def missing_year_ends(org: dict[str, Any], ends: list[date], today: date, fetch_start: date) -> list[date] | None:
    """Year ends a return was due for and none was filed: years skipped between two returns, and
    years since the last one. None when the feed can't tell: the charity is in a group that files
    for it, or has no return of its own this far back (most likely filed for by a group the feed
    doesn't record it in)."""
    if rc.is_group_member(org):
        return None
    balance = rc.registered_balance(org)
    month, day = balance if balance else (None, None)
    registered = to_date(org.get("DateRegistered"))
    if not ends and (not registered or registered < fetch_start):
        return None
    missing: list[date] = []
    for before, after in zip(ends, ends[1:]):
        if (after - before).days < rc.GAP_DAYS or (registered and before < registered <= after):
            continue
        year_end = rc.next_balance_date(before, month, day)
        found = False
        while (after - year_end).days > 31 and len(missing) < 40:
            missing.append(year_end)
            found = True
            year_end = rc.next_balance_date(year_end, month, day)
        if not found:
            missing.append(rc.add_months(before, 12))
    start = max(ends[-1], registered) if ends and registered else (ends[-1] if ends else registered)
    year_end = rc.next_balance_date(start, month, day)  # type: ignore[arg-type]
    extension = to_date(org.get("AnnualReturnExtensionDate"))
    first = True
    while len(missing) < 40:
        due = rc.add_months(year_end, 6)
        if first and extension and extension > due:
            due = extension
        if today <= due + timedelta(days=GRACE_DAYS):
            break
        missing.append(year_end)
        first = False
        year_end = rc.next_balance_date(year_end, month, day)
    return missing


def build_years(org: dict[str, Any], returns: list[dict[str, Any]], officers: list[Officer],
                filed_on: dict[int, tuple[date, str]], complete: int, today: date, fetch_start: date) -> list[Year]:
    """The charity year by year, from the first of the five years every charity's return is due
    for, up to its latest return if that is later. Its own last five are the end of the list."""
    filed = dedupe_returns(returns)
    ends = [rc.ended(r) for r in filed]
    last_fy = max([complete, *[e.year for e in ends if e and e <= today]])
    by_fy: dict[int, dict[str, Any]] = {}
    for r in filed:  # the later of two year ends in one year, after a changed balance date
        by_fy[rc.ended(r).year] = r  # type: ignore[union-attr]
    missing = missing_year_ends(org, [e for e in ends if e], today, fetch_start)
    missing_by_fy = {d.year: d for d in missing or []}
    in_group = rc.is_group_member(org)
    balance = rc.registered_balance(org)

    years: list[Year] = []
    for fy in range(complete - YEARS + 1, last_fy + 1):
        y = Year(fy=fy)
        r = by_fy.get(fy)
        if r:
            y.ended = rc.ended(r)
            y.due = rc.add_months(y.ended, 6)  # type: ignore[arg-type]
            y.ret = r
            y.filed, y.filed_basis = filed_on.get(int(r["AnnualReturnId"]), (None, None))
            if r.get("Status") != rc.PUBLISHED:
                y.status = "processing"
            else:
                late = bool(y.filed and y.filed > y.due + timedelta(days=GRACE_DAYS))
                y.status = "late" if late else "on_time"
                y.income, y.spend = num(r.get("TotalGrossIncome")), num(r.get("TotalExpenditure"))
                y.funds, y.funds_basis = funds_of(r)
                y.tier = tier_of(r)
                y.audited = r.get("IsFinancialReportAudited")
                y.modified = r.get("IsModifiedAuditOpinionReceived")
                y.related = r.get("IfFinancialStmtContainRelatedPartyTrans")
        elif fy in missing_by_fy:
            y.ended, y.status = missing_by_fy[fy], "missing"
            y.due = rc.add_months(y.ended, 6)
        elif in_group or missing is None:
            y.status = "group" if in_group else "unknown"
        board_day = y.ended or (rc.balance_date_in(fy, *balance) if balance else date(fy, 12, 31))
        if officers and board_day <= today:
            y.officers = sum(1 for o in officers if o.on(board_day))
        years.append(y)
    return years


# ---------------------------------------------------------------------------
# The measures
# ---------------------------------------------------------------------------

def published(years: list[Year]) -> list[Year]:
    return [y for y in years if y.ret is not None and y.status in ("on_time", "late")]


def level(key: str, value: float | None, material: bool = True) -> int:
    """0: nothing, 1: worth a look, 2: priority."""
    if value is None or not material:
        return 0
    s = SIGNALS[key]
    if s.get("low"):
        return 2 if value < s["priority"] else 1 if value < s["look"] else 0
    return 2 if value >= s["priority"] else 1 if value >= s["look"] else 0


def quality_issues(r: dict[str, Any]) -> list[str]:
    """Totals on a return that are blank or don't add up."""
    issues: list[str] = []
    income, spend = num(r.get("TotalGrossIncome")), num(r.get("TotalExpenditure"))
    if income is None or spend is None:
        blank = " and ".join(w for w, v in (("revenue", income), ("expenses", spend)) if v is None)
        issues.append(f"Total {blank} {'are' if ' and ' in blank else 'is'} blank.")

    def off(a: float, b: float, scale: float) -> bool:
        return abs(a - b) > max(MISMATCH_FLOOR, MISMATCH_SHARE * abs(scale))

    surplus = num(r.get("SurplusDeficit"))
    if surplus is None:
        surplus = num(r.get("NetSurplusDeficitForTheYear"))
    if income is not None and spend is not None and surplus is not None and (income or spend) and surplus:
        if off(income - spend, surplus, max(income, spend)):
            issues.append(f"Revenue less expenses is {money(income - spend)}, but the annual return shows a "
                          f"{'deficit' if surplus < 0 else 'surplus'} of {money(abs(surplus))}.")
    assets, owed, net = num(r.get("TotalAssets")), num(r.get("TotalLiabilities")), num(r.get("Totalassetslesstotalliabilities"))
    if assets is not None and owed is not None and net is not None and (assets or owed) and net:
        if off(assets - owed, net, assets):
            issues.append(f"Assets less liabilities is {money(assets - owed)}, but the annual return shows net assets of {money(net)}.")
    return issues


def measure(c: Charity, today: date) -> None:
    """Fill in the charity's values, levels and the sentence behind each signal."""
    v, why = c.values, c.why
    pub = published(c.years)
    earlier = published(c.span)
    latest = pub[-1] if pub else None
    c.latest = latest
    serving = sum(1 for o in c.officers if o.serving and o.end is None)
    v["officers"] = serving if c.officers else None
    c.band = band_for(latest.spend, latest.income) if latest else 0

    for key in COLUMNS[5:-1]:
        v.setdefault(key, None)
    if latest:
        v["income"], v["spend"], v["funds"] = latest.income, latest.spend, latest.funds
        r = latest.ret or {}

        # Income against the year before.
        prev = next((y for y in earlier if y.fy == latest.fy - 1), None)
        if prev and prev.income and prev.income >= NEAR_ZERO and latest.income is not None:
            v["income_change"] = (latest.income - prev.income) / prev.income

        # Net assets against spending, three years on.
        base = next((y for y in earlier if y.fy == latest.fy - 3), None)
        if base and base.funds and base.funds > 0 and base.spend and base.spend >= NEAR_ZERO \
                and latest.funds is not None and latest.spend is not None and base.funds_basis == latest.funds_basis:
            funds_growth = (latest.funds - base.funds) / base.funds
            spend_growth = (latest.spend - base.spend) / base.spend
            gap = (funds_growth - spend_growth) * 100
            v["asset_growth_gap"] = gap
            grew = latest.funds - base.funds
            c.levels["asset_growth_gap"] = level("asset_growth_gap", gap, grew >= SIGNALS["asset_growth_gap"]["floor"])
            if c.levels["asset_growth_gap"]:
                why["asset_growth_gap"] = (
                    f"{FUNDS_NAME[latest.funds_basis or 'net_assets'].capitalize()} {change(funds_growth)} from {base.fy} to "
                    f"{latest.fy} ({money(base.funds)} to {money(latest.funds)}). Expenses {change(spend_growth)} "
                    f"({money(base.spend)} to {money(latest.spend)}).")

        # Years of spending held.
        if latest.funds is not None and latest.spend is not None and latest.funds > 0:
            ratio = min(latest.funds / latest.spend, 999.0) if latest.spend >= NEAR_ZERO else 999.0
            v["reserves_years"] = ratio
            c.levels["reserves_years"] = level("reserves_years", ratio, latest.funds >= SIGNALS["reserves_years"]["floor"])
            if c.levels["reserves_years"]:
                held = "more than 999 years" if ratio >= 999 else f"{ratio:.0f} years"
                why["reserves_years"] = (
                    f"{FUNDS_NAME[latest.funds_basis or 'net_assets'].capitalize()} of {money(latest.funds)} and expenses of "
                    f"{money(latest.spend)} in {latest.fy}. At that rate, what it holds would last {held}.")

        # Current assets against current liabilities.
        owed_now, has_now = num(r.get("AllCurrentLiabilities")), current_assets(r)
        if owed_now and owed_now > 0 and has_now is not None and latest.tier != 4:
            ratio = has_now / owed_now
            v["current_ratio"] = ratio
            invested = num(r.get("Investments")) or 0.0
            material = owed_now >= SIGNALS["current_ratio"]["floor"] and has_now + invested < owed_now
            c.levels["current_ratio"] = level("current_ratio", ratio, material)
            if c.levels["current_ratio"]:
                why["current_ratio"] = (
                    f"Current liabilities of {money(owed_now)} and current assets of {money(has_now)}"
                    + (f", with investments of {money(invested)}," if invested else "") + f" at its {latest.fy} balance date.")

        # Trading.
        trade = trading_income(r)
        if trade is not None and latest.income and latest.income >= NEAR_ZERO:
            v["trading_share"] = max(0.0, min(trade / latest.income, 1.0))

        # Income for each officer.
        if serving and latest.income is not None:
            per = latest.income / serving
            v["income_per_officer"] = per
            c.levels["income_per_officer"] = level("income_per_officer", per, serving <= SIGNALS["income_per_officer"]["officers"])
            if c.levels["income_per_officer"]:
                people = "1 officer" if serving == 1 else f"{serving} officers"
                why["income_per_officer"] = f"Revenue of {money(latest.income)} in {latest.fy}, with {people} on the register."

        # The latest return's totals.
        c.quality = quality_issues(r)
        v["return_quality"] = len(c.quality)
        c.levels["return_quality"] = level("return_quality", len(c.quality))
        if c.quality:
            why["return_quality"] = " ".join(c.quality)

    # Years with next to nothing in or out.
    if pub:
        quiet = [y.fy for y in pub if (y.income or 0) < NEAR_ZERO and (y.spend or 0) < NEAR_ZERO]
        v["dormant_years"] = len(quiet)
        c.levels["dormant_years"] = level("dormant_years", len(quiet))
        if c.levels["dormant_years"]:
            why["dormant_years"] = (
                f"Revenue and expenses were both under {money(NEAR_ZERO)} in {len(quiet)} of its last {len(pub)} annual "
                f"returns ({', '.join(map(str, quiet))}).")

        opinions = [y.fy for y in pub if y.modified]
        v["modified_audits"] = len(opinions)
        c.levels["modified_audits"] = level("modified_audits", len(opinions))
        if opinions:
            why["modified_audits"] = f"Reported a modified audit opinion for {', '.join(map(str, opinions))}."

    # Spending overseas, as the charity declares it.
    overseas = num(c.org.get("PercentageSpentOverseas"))
    if overseas is not None and 0 <= overseas <= 100:
        v["overseas_share"] = overseas / 100

    # Late and missing returns.
    judged = [y for y in c.years if y.status in ("on_time", "late", "missing")]
    if judged:
        late = [y for y in judged if y.status == "late"]
        gone = [y for y in judged if y.status == "missing"]
        v["late_returns"] = len(late) + len(gone)
        c.levels["late_returns"] = level("late_returns", len(late) + len(gone))
        if late or gone:
            parts = []
            if late:
                parts.append(f"{len(late)} late ({', '.join(str(y.fy) for y in late)})")
            if gone:
                parts.append(f"{len(gone)} not filed ({', '.join(str(y.fy) for y in gone)})")
            why["late_returns"] = f"Of its last {len(judged)} annual returns due: {' and '.join(parts)}."

    # The board leaving, a year at a time.
    if c.officers:
        left = at_start = 0
        for y in c.years:
            start, end = date(y.fy, 1, 1), date(y.fy, 12, 31)
            if start > today:
                continue
            at_start += sum(1 for o in c.officers if o.on(start))
            left += sum(1 for o in c.officers if o.end and start <= o.end <= end)
        if at_start:
            v["officer_turnover"] = min(left / at_start, 1.0)


def link_boards(charities: list[Charity]) -> None:
    """Count, for each charity, the others that have a serving officer of the same name."""
    boards: dict[str, set[int]] = defaultdict(set)
    for i, c in enumerate(charities):
        for o in c.officers:
            if o.key and o.serving and o.end is None:
                boards[o.key].add(i)
    shared: list[Counter[int]] = [Counter() for _ in charities]
    for members in boards.values():
        if not 1 < len(members) <= COMMON_NAME_BOARDS:
            continue
        for i in members:
            for j in members:
                if i != j:
                    shared[i][j] += 1
    for i, c in enumerate(charities):
        if not c.officers:
            continue
        c.values["shared_boards"] = len(shared[i])
        c.links = [(charities[j].cc, n) for j, n in sorted(shared[i].items(), key=lambda kv: (-kv[1], charities[kv[0]].name))[:LINKS_SHOWN]]


# ---------------------------------------------------------------------------
# Putting it together
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class Feed:
    orgs: list[dict[str, Any]]
    views: list[dict[str, Any]]
    returns: list[dict[str, Any]]
    officers: list[dict[str, Any]]
    fetched: str


def analyse(feed: Feed, today: date) -> tuple[dict[str, Any], list[Charity]]:
    """The snapshot's meta and every charity, measured."""
    complete = last_complete_year(today)
    fetch_start = date(complete - YEARS, 1, 1)
    filed_on = estimate_filed(feed.returns)

    returns_by_org: dict[Any, list[dict[str, Any]]] = defaultdict(list)
    for r in feed.returns:
        if r.get("OrganisationId") is not None:
            returns_by_org[r["OrganisationId"]].append(r)
    officers_by_org: dict[Any, list[Officer]] = defaultdict(list)
    for o in feed.officers:
        if o.get("OrganisationId") is None or o.get("IsaBodyCorporate"):
            continue
        officers_by_org[o["OrganisationId"]].append(Officer(
            key=o.get("NameKey"), start=to_date(o.get("PositionAppointmentDate")),
            end=to_date(o.get("LastDateAsAnOfficer")), serving=o.get("OfficerStatus") == SERVING))
    views = {v["OrganisationId"]: v for v in feed.views}

    charities: list[Charity] = []
    for org in feed.orgs:
        cc, name = org.get("CharityRegistrationNumber"), org.get("Name")
        if not cc or not name:
            continue
        officers = officers_by_org.get(org["OrganisationId"], [])
        years = build_years(org, returns_by_org.get(org["OrganisationId"], []), officers, filed_on, complete, today, fetch_start)
        c = Charity(org=org, cc=cc, name=name, span=years, officers=officers, view=views.get(org["OrganisationId"], {}))
        measure(c, today)
        if rc.is_group_member(org):
            c.note = "This charity is a member of a registered group. The group files one annual return for all its members."
        elif all(y.status == "unknown" for y in years):
            c.note = (f"The public data has no annual return from this charity since {fetch_start.year}. "
                      "It may file through a group that the data does not show.")
        charities.append(c)
    link_boards(charities)

    sectors = sorted({s for c in charities if (s := sc.clean_text(c.view.get("MainSectorName")))})
    meta = {
        "as_of": today.isoformat(),
        "fetched": feed.fetched,
        "years": list(range(complete - YEARS + 1, complete + 1)),
        "columns": list(COLUMNS),
        "year_columns": list(YEAR_COLUMNS),
        "signals": {k: {**s, "key": k} for k, s in SIGNALS.items()},
        "signal_order": list(SIGNAL_KEYS),
        "combined_threshold": COMBINED_THRESHOLD,
        "grace_days": GRACE_DAYS,
        "near_zero": NEAR_ZERO,
        "bands": {str(b): limit for b, limit in BAND_LIMITS},
        "sectors": sectors,
        "counts": {"charities": len(charities), "returns": len(feed.returns), "officers": len(feed.officers)},
        "overview": overview(charities, sectors, complete),
    }
    return meta, charities


def areas_of(c: Charity) -> list[str]:
    return [a.strip() for a in str(c.view.get("AreasOfOperation") or "").split(",") if a.strip()]


def overview(charities: list[Charity], sectors: list[str], complete: int) -> dict[str, Any]:
    """What the overview page can't work out from the snapshot's rows: sector-wide money year by
    year, filing on time, who charities serve and where they work. Kept per sector and size band,
    so the page's filters apply to all of it.

    Not trading income: the return forms changed what they ask for in 2024 and 2025 (Tier 3's
    "service and trading income" became "revenue from commercial activities"), so a sector total
    falls off a cliff that isn't there."""
    years = list(range(complete - YEARS + 1, complete + 1))
    sector_index = {s: i for i, s in enumerate(sectors)}
    beneficiaries = sorted({b for c in charities if (b := sc.clean_text(c.view.get("MainBeneficiaryName")))})
    areas = sorted({a for c in charities for a in areas_of(c)})
    ben_index, area_index = {b: i for i, b in enumerate(beneficiaries)}, {a: i for i, a in enumerate(areas)}
    cells: dict[tuple[int, int], dict[str, Any]] = {}

    def cell(c: Charity) -> dict[str, Any]:
        key = (sector_index.get(sc.clean_text(c.view.get("MainSectorName")) or "", -1), c.band)
        if key not in cells:
            cells[key] = {
                "sector": key[0], "band": key[1], "n": 0, "panel": 0,
                "income": [0.0] * YEARS, "spend": [0.0] * YEARS,
                "due": [0] * YEARS, "on_time": [0] * YEARS,
                "ben_n": 0, "ben": Counter(), "area_n": 0, "areas": Counter(),
            }
        return cells[key]

    for c in charities:
        k = cell(c)
        k["n"] += 1
        by_fy = {y.fy: y for y in c.span}
        picked = [by_fy.get(fy) for fy in years]
        # Money: only charities with a published return in every one of the years, so a year's
        # total doesn't move because more or fewer charities filed.
        if all(y and y.ret is not None and y.income is not None and y.spend is not None for y in picked):
            k["panel"] += 1
            for i, y in enumerate(picked):
                k["income"][i] += y.income  # type: ignore[union-attr]
                k["spend"][i] += y.spend  # type: ignore[union-attr]
        for i, y in enumerate(picked):
            if y and y.status in ("on_time", "late", "missing"):
                k["due"][i] += 1
                k["on_time"][i] += y.status == "on_time"
        who = sc.clean_text(c.view.get("MainBeneficiaryName"))
        if who:
            k["ben_n"] += 1
            k["ben"][ben_index[who]] += 1
        where = areas_of(c)
        if where:
            k["area_n"] += 1
            for a in where:
                k["areas"][area_index[a]] += 1

    out = []
    for k in cells.values():
        out.append({**k, "income": [round(x) for x in k["income"]], "spend": [round(x) for x in k["spend"]],
                    "ben": {str(i): n for i, n in sorted(k["ben"].items())},
                    "areas": {str(i): n for i, n in sorted(k["areas"].items())}})
    out.sort(key=lambda k: (k["sector"], k["band"]))
    return {"years": years, "beneficiaries": beneficiaries, "areas": areas, "cells": out}


def summary_row(c: Charity, sector_index: dict[str, int]) -> list[Any]:
    v = c.values
    places = {"income_change": 3, "asset_growth_gap": 0, "reserves_years": 2, "current_ratio": 2, "trading_share": 3,
              "overseas_share": 2, "officer_turnover": 3}
    row: list[Any] = [
        c.cc, c.name, c.band, c.latest.tier if c.latest else None,
        sector_index.get(sc.clean_text(c.view.get("MainSectorName")) or "", -1),
    ]
    for key in COLUMNS[5:-1]:
        row.append(rounded(v.get(key), places.get(key, 0)))
    row.append("".join(str(c.levels.get(k, 0)) for k in SIGNAL_KEYS))
    return row


def detail(c: Charity, names: dict[str, str]) -> dict[str, Any]:
    balance = rc.registered_balance(c.org)
    registered = to_date(c.org.get("DateRegistered"))
    latest_ret = (c.latest.ret or {}) if c.latest else {}
    return {
        "city": sc.clean_text(c.org.get("StreetAddressCity")),
        "registered": registered.isoformat() if registered else None,
        "balance": list(balance) if balance else None,
        "activity": sc.clean_text(c.view.get("MainActivityName")),
        "beneficiary": sc.clean_text(c.view.get("MainBeneficiaryName")),
        "areas": areas_of(c),
        "in_group": rc.is_group_member(c.org),
        "note": c.note,
        "years": [y.row() for y in c.years],
        "latest_return_id": latest_ret.get("AnnualReturnId"),
        "why": c.why,
        "links": [[cc, names.get(cc, cc), n] for cc, n in c.links],
        "current": {
            "assets": rounded(current_assets(latest_ret)) if latest_ret else None,
            "liabilities": rounded(num(latest_ret.get("AllCurrentLiabilities"))) if latest_ret else None,
        },
    }


def build(feed: Feed, today: date) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """(meta, one row per charity: cc_number, summary, detail), ranked as the watchlist is."""
    meta, charities = analyse(feed, today)
    sector_index = {s: i for i, s in enumerate(meta["sectors"])}
    names = {c.cc: c.name for c in charities}
    charities.sort(key=lambda c: (-c.signals, -sum(1 for v in c.levels.values() if v == 2), -(c.values.get("income") or 0), c.cc))
    rows = [{"cc_number": c.cc, "summary": summary_row(c, sector_index), "detail": detail(c, names)} for c in charities]
    flagged = Counter()
    for c in charities:
        for k, v in c.levels.items():
            if v:
                flagged[k] += 1
    meta["counts"]["flagged"] = {k: flagged.get(k, 0) for k in SIGNAL_KEYS}
    meta["counts"]["combined"] = sum(1 for c in charities if c.signals >= COMBINED_THRESHOLD)
    return meta, rows


# ---------------------------------------------------------------------------
# Data in, results out
# ---------------------------------------------------------------------------

def fetch(client: httpx.Client, today: date) -> Feed:
    fetch_start = date(last_complete_year(today) - YEARS, 1, 1)
    since = sc.odata_datetime_literal(datetime(fetch_start.year, 1, 1, tzinfo=UTC))
    orgs = list(rc.paced(sc.fetch_keyset(client, "Organisations", "OrganisationId", ORG_FIELDS,
                                         since=None, registered_only=True)))
    for org in orgs:
        org["CharityRegistrationNumber"] = sc.clean_cc_number(org.get("CharityRegistrationNumber"))
        org["Name"] = sc.clean_text(org.get("Name"))
    views = list(rc.paced(sc.fetch_keyset(client, "vOrganisations", "OrganisationId", VIEW_FIELDS,
                                          since=None, registered_only=True)))
    returns = list(rc.paced(sc.fetch_keyset(client, "AnnualReturn", "AnnualReturnId", RETURN_FIELDS,
                                            since=None, registered_only=False, where=f"YearEnded ge {since}")))
    # Officers serving now, or who left inside the years read.
    officers = []
    for o in rc.paced(sc.fetch_keyset(client, "Officers", "OfficerId", OFFICER_FIELDS, since=None, registered_only=False,
                                      where=f"(LastDateAsAnOfficer eq null or LastDateAsAnOfficer ge {since})")):
        o["NameKey"] = name_key(o.pop("FullName", None))  # a name is only ever matched, never kept
        officers.append(o)
    for rows in (orgs, views, returns, officers):
        for row in rows:
            row.pop("__metadata", None)
    return Feed(orgs=orgs, views=views, returns=returns, officers=officers,
                fetched=datetime.now(UTC).isoformat(timespec="seconds"))


def load_feed(path: Path) -> Feed:
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return Feed(**json.load(fh))


def save_feed(feed: Feed, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as fh:
        json.dump({"orgs": feed.orgs, "views": feed.views, "returns": feed.returns, "officers": feed.officers,
                   "fetched": feed.fetched}, fh, separators=(",", ":"))


def store(sb, meta: dict[str, Any], rows: list[dict[str, Any]]) -> int:
    """Upload a whole run, then switch the pages over to it at once."""
    run_id = int(time.time())
    sb.table("intel_runs").delete().eq("published", False).execute()  # what a failed run left behind
    sb.table("intel_runs").insert({"run_id": run_id, "as_of": meta["as_of"], "meta": meta}).execute()
    from postgrest.types import ReturnMethod

    for batch in sc.chunks(rows, UPLOAD_BATCH):
        sb.table("intel_charities").insert([{**r, "run_id": run_id} for r in batch], returning=ReturnMethod.minimal).execute()
    return sb.rpc("publish_intel_run", {"p_run_id": run_id}).execute().data


def write_summary(meta: dict[str, Any]) -> None:
    counts = meta["counts"]
    lines = [f"Intelligence, {meta['as_of']} (public data, post-publication): {counts['charities']:,} charities"]
    lines += [f"  {k}: {n:,}" for k, n in counts["flagged"].items()]
    lines.append(f"  {COMBINED_THRESHOLD} or more signals: {counts['combined']:,}")
    log.info("\n".join(lines))
    # Counts only: the repository's Action logs are public, and these results are for admins.
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as fh:
            fh.write(f"### Intelligence\n\n{counts['charities']:,} charities. Public data, post-publication.\n\n"
                     "| Signal | Charities |\n| --- | --- |\n")
            fh.writelines(f"| {k} | {n:,} |\n" for k, n in counts["flagged"].items())
            fh.write(f"| {COMBINED_THRESHOLD} or more | {counts['combined']:,} |\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dry-run", metavar="DIR", help="write snapshot.json and details.json to DIR instead of Supabase")
    parser.add_argument("--raw", metavar="FILE", help="read the feed from FILE (.json.gz) if it exists; otherwise fetch it and save it there")
    parser.add_argument("--today", help="work it out as if it were this date (YYYY-MM-DD), for testing")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # the feed's own progress lines are enough

    today = date.fromisoformat(args.today) if args.today else datetime.now(UTC).date()
    sb = None if args.dry_run else sc.make_supabase()  # fail fast on missing settings
    raw = Path(args.raw) if args.raw else None
    if raw and raw.exists():
        feed = load_feed(raw)
        log.info("Read the feed from %s (fetched %s)", raw, feed.fetched)
    else:
        contact = os.environ.get("GEOCODER_CONTACT", "https://github.com/rethc/nz-charities-map").strip()
        with httpx.Client(timeout=120, headers={
            "User-Agent": f"Mozilla/5.0 (compatible; nz-charities-map-intelligence/1.0; +{contact})"}) as client:
            feed = fetch(client, today)
        if raw:
            save_feed(feed, raw)
    log.info("Read %s registered charities, %s returns and %s officers", len(feed.orgs), len(feed.returns), len(feed.officers))
    if len(feed.orgs) < rc.MIN_CHARITIES:
        log.error("Only %s charities came back from the register; leaving the results as they are", len(feed.orgs))
        return 1

    meta, rows = build(feed, today)
    write_summary(meta)
    if args.dry_run:
        out = Path(args.dry_run)
        out.mkdir(parents=True, exist_ok=True)
        snapshot = {"computed_at": datetime.now(UTC).isoformat(timespec="seconds"), "meta": meta,
                    "rows": [r["summary"] for r in rows]}
        (out / "snapshot.json").write_text(json.dumps(snapshot, separators=(",", ":")), encoding="utf-8")
        (out / "details.json").write_text(json.dumps({r["cc_number"]: r["detail"] for r in rows}, separators=(",", ":")),
                                          encoding="utf-8")
        log.info("Wrote %s charities to %s", len(rows), out)
        return 0
    stored = store(sb, meta, rows)
    log.info("Stored %s charities", stored)
    return 0


if __name__ == "__main__":
    sys.exit(main())

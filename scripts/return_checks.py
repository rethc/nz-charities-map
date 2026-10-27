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

Checks
  year_end_mismatch  the latest return's year end isn't the charity's registered balance date
  overdue            the next return was due (6 months after the balance date) and none is filed
  tier_over_limit    filed under the same tier for three returns running while over that tier's
                     limit (the rules allow two years over before moving up; Tier 2, one)

Rules from https://www.charities.govt.nz/annual-reporting/which-tier-will-i-use (June 2026) and
https://www.charities.govt.nz/annual-reporting/annual-return (due within 6 months of balance date).

Only published returns are judged. A return the register hasn't published yet (still being
processed) only counts as "filed", so its charity isn't called overdue.

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
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, Iterable

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
TIER_LIMIT_SOURCE = "https://www.charities.govt.nz/annual-reporting/which-tier-will-i-use"
# The register's GroupType for a member of a registered group (the group files one return for
# all its members). Some members have it without a GroupId, such as the MAS Charitable Group's.
GROUP_MEMBER = 1
# Fewer charities than this back from the register means something went wrong upstream: the
# results are left as they are rather than replaced with a short list.
MIN_CHARITIES = 10_000

ORG_FIELDS = (
    "OrganisationId", "CharityRegistrationNumber", "Name", "EndOfYearDayofMonth", "EndOfYearMonth",
    "AnnualReturnExtensionDate", "DateRegistered", "GroupId", "GroupType",
)
RETURN_FIELDS = (
    "AnnualReturnId", "OrganisationId", "Status", "YearEnded", "ReportingTierId", "TotalExpenditure",
)


@dataclass(slots=True)
class Finding:
    check: str
    cc_number: str
    charity_name: str
    summary: str  # one plain sentence for the admin page
    year_ended: str | None = None  # ISO date of the return the finding is about
    annual_return_id: int | None = None
    details: dict[str, Any] = field(default_factory=dict)

    def payload(self) -> dict[str, Any]:
        row = asdict(self)
        row["check_name"] = row.pop("check")
        return row


# ---------------------------------------------------------------------------
# Dates
# ---------------------------------------------------------------------------

def to_date(value: Any) -> date | None:
    parsed = sc.parse_odata_datetime(value)
    return parsed.date() if parsed else None


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
    return f"${value:,.0f}"


def registered_balance(org: dict[str, Any]) -> tuple[int, int] | None:
    try:
        month, day = int(org.get("EndOfYearMonth") or 0), int(org.get("EndOfYearDayofMonth") or 0)
    except (TypeError, ValueError):
        return None
    return (month, day) if 1 <= month <= 12 and 1 <= day <= 31 else None


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

def check_year_end(org: dict[str, Any], latest: dict[str, Any] | None) -> Finding | None:
    """The latest published return should end on the charity's registered balance date."""
    balance = registered_balance(org)
    ended = to_date(latest.get("YearEnded")) if latest else None
    if not balance or not ended or same_balance_date(ended, *balance):
        return None
    month, day = balance
    registered = f"{day} {calendar.month_name[month]}"
    return Finding(
        check="year_end_mismatch",
        cc_number=org["CharityRegistrationNumber"],
        charity_name=org["Name"],
        summary=(f"The latest return is for the year ended {nice(ended)}, but the registered balance "
                 f"date is {registered}. Expected if the charity has since changed its balance date."),
        year_ended=ended.isoformat(),
        annual_return_id=latest["AnnualReturnId"],
        details={"registered_balance_date": registered, "return_year_ended": ended.isoformat()},
    )


def check_overdue(org: dict[str, Any], filed: list[dict[str, Any]], today: date, window_start: date) -> Finding | None:
    """The return for the year after the last one filed is due 6 months after that year ends.
    A member of a registered group is skipped: its group files for it.

    A charity with no return of its own in the window is only judged when it registered within
    the window (its first return is late). An older one is most likely filed for by a group the
    feed doesn't record it in: the register shows some Presbyterian parishes as members of their
    church's group while the feed lists them as standalone charities."""
    if org.get("GroupId") or org.get("GroupType") == GROUP_MEMBER:
        return None
    ends = [d for d in (to_date(r.get("YearEnded")) for r in filed) if d]
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
        summary = (f"Registered {nice(to_date(org.get('DateRegistered')))} and hasn't filed a return yet. "
                   f"The first one, for the year ended {nice(year_end)}, was due {nice(due)} ({days:,} days ago).")
    return Finding(
        check="overdue",
        cc_number=org["CharityRegistrationNumber"],
        charity_name=org["Name"],
        summary=summary,
        year_ended=year_end.isoformat(),
        details={"due": due.isoformat(), "days_overdue": days, "last_year_ended": last.isoformat() if last else None,
                 "extension": extension.isoformat() if extension else None},
    )


def check_tier_limit(org: dict[str, Any], published: list[dict[str, Any]]) -> Finding | None:
    """Over a tier's limit for more years running than the rules allow, and still in that tier."""
    returns = sorted(published, key=lambda r: r.get("YearEnded") or "")
    if not returns:
        return None
    tier = returns[-1].get("ReportingTierId")
    if tier not in TIER_LIMITS:
        return None
    limit, grace = TIER_LIMITS[tier]
    run = returns[-(grace + 1):]
    if len(run) < grace + 1:
        return None
    if any(r.get("ReportingTierId") != tier or (r.get("TotalExpenditure") or 0) < limit for r in run):
        return None
    spent = [float(r["TotalExpenditure"]) for r in run]
    what = "operating payments" if tier == 4 else "expenses"
    years = [to_date(r.get("YearEnded")) for r in run]
    listed = ", ".join(f"{money(s)} ({y.year if y else '?'})" for s, y in zip(spent, years))
    latest = run[-1]
    return Finding(
        check="tier_over_limit",
        cc_number=org["CharityRegistrationNumber"],
        charity_name=org["Name"],
        summary=(f"Filed as Tier {tier} for the last {len(run)} returns with {what} of {listed}, all at or over "
                 f"the Tier {tier} limit of {money(limit)}. The rules allow {grace} "
                 f"year{'s' if grace > 1 else ''} over before moving up."),
        year_ended=years[-1].isoformat() if years[-1] else None,
        annual_return_id=latest["AnnualReturnId"],
        details={"tier": tier, "limit": limit, "spent": spent, "years": [y.isoformat() if y else None for y in years],
                 "source": TIER_LIMIT_SOURCE},
    )


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
        published = [r for r in filed if r.get("Status") == PUBLISHED]
        latest = max(published, key=lambda r: r.get("YearEnded") or "", default=None)
        for finding in (check_year_end(org, latest), check_overdue(org, filed, today, window_start),
                        check_tier_limit(org, published)):
            if finding:
                findings.append(finding)
    findings.sort(key=lambda f: (f.check, f.cc_number))
    return findings


# ---------------------------------------------------------------------------
# Data in, results out
# ---------------------------------------------------------------------------

def fetch(client: httpx.Client, window_start: date) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    orgs = list(sc.fetch_keyset(client, "Organisations", "OrganisationId", ORG_FIELDS,
                                since=None, registered_only=True))
    for org in orgs:
        org["CharityRegistrationNumber"] = sc.clean_cc_number(org.get("CharityRegistrationNumber"))
        org["Name"] = sc.clean_text(org.get("Name"))
    since = sc.odata_datetime_literal(datetime(window_start.year, window_start.month, window_start.day, tzinfo=UTC))
    returns = list(sc.fetch_keyset(client, "AnnualReturn", "AnnualReturnId", RETURN_FIELDS,
                                   since=None, registered_only=False, where=f"YearEnded ge {since}"))
    return orgs, returns


def write_summary(findings: list[Finding], today: date) -> None:
    counts = defaultdict(int)
    for f in findings:
        counts[f.check] += 1
    lines = [f"Annual return checks, {today.isoformat()}:"] + [f"  {name}: {n}" for name, n in sorted(counts.items())]
    log.info("\n".join(lines))
    # Counts only: the repository's Action logs are public, and these results are for admins.
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as fh:
            fh.write("### Annual return checks\n\n| Check | Charities |\n| --- | --- |\n")
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

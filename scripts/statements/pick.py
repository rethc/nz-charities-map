#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "supabase>=2.31,<3",
#   "httpx>=0.28,<1",
# ]
# ///
"""
Statement reviews, step 1: pick a batch of charities whose latest published return came with
its own statement files, in a mix of tiers, some of them already flagged by the annual return
checks. Skips charities picked for an earlier batch (any picks.json beside the batch folder).

Writes <batch>/picks.json (who, which return, the figures declared in it) and
<batch>/register.json (those charities and all their returns, for assess.py).

Usage
  uv run scripts/statements/pick.py <batch folder> [candidates, default 32]
"""

from __future__ import annotations

import collections
import json
import random
import sys
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import return_checks as rc  # noqa: E402
import sync_charities as sc  # noqa: E402

# Flags worth a closer look in the statements (overdue and missing years have no statement to read).
INTERESTING = {"prior_year_mismatch", "negative_net_assets", "deficits", "big_swing", "staff_pay_no_staff",
               "repeated_figures", "tier_over_limit", "year_end_mismatch"}
EXTRA_RETURN_FIELDS = ("CashAndBankBalances", "TotalCashBalancesHeld",
                       "IsCharityCompletingCombinedAnnualReturnAndPerformanceReport")
# Only returns this recent: the statements of older ones say little about the charity today.
RECENT_DAYS = 600


def num(v):
    try:
        return None if v in (None, "") else float(v)
    except (TypeError, ValueError):
        return None


def main() -> int:
    batch = Path(sys.argv[1])
    total = int(sys.argv[2]) if len(sys.argv) > 2 else 32
    batch.mkdir(parents=True, exist_ok=True)
    today = datetime.now(UTC).date()
    window_start = date(today.year - rc.YEARS_BACK, 1, 1)

    with httpx.Client(timeout=120, headers={
            "User-Agent": "Mozilla/5.0 (compatible; nz-charities-map-statement-review/1.0; +https://github.com/rethc/nz-charities-map)"}) as client:
        orgs, returns = rc.fetch(client, window_start)
        since = sc.odata_datetime_literal(datetime(window_start.year, 1, 1, tzinfo=UTC))
        extra = {r["AnnualReturnId"]: r for r in rc.paced(sc.fetch_keyset(
            client, "AnnualReturn", "AnnualReturnId", ("AnnualReturnId", *EXTRA_RETURN_FIELDS),
            since=None, registered_only=False, where=f"YearEnded ge {since}"))}
    for r in returns:
        r.update({k: v for k, v in extra.get(r["AnnualReturnId"], {}).items() if k != "AnnualReturnId"})

    flags = collections.defaultdict(list)
    for f in rc.run_checks(orgs, returns, today, window_start):
        if f.check in INTERESTING:
            flags[f.cc_number].append(f.check)

    by_org = {o["OrganisationId"]: o for o in orgs}
    history = collections.defaultdict(list)
    latest = {}
    for r in returns:
        history[r["OrganisationId"]].append(r)
        end = rc.ended(r)
        if r.get("Status") != 10 or r["OrganisationId"] not in by_org or not end or end < today - timedelta(days=RECENT_DAYS):
            continue
        if r["OrganisationId"] not in latest or end > latest[r["OrganisationId"]][0]:
            latest[r["OrganisationId"]] = (end, r)

    done = {p["cc"] for f in batch.parent.glob("*/picks.json") if f.parent.resolve() != batch.resolve()
            for p in json.loads(f.read_text(encoding="utf-8"))}
    pool = collections.defaultdict(lambda: {"flagged": [], "other": []})
    for oid, (end, r) in latest.items():
        o = by_org[oid]
        if o.get("GroupId") or o.get("GroupType") == 1:  # group members file through their group
            continue
        if r.get("IsCharityCompletingCombinedAnnualReturnAndPerformanceReport") is True:  # no separate statements
            continue
        tier = r.get("ReportingTierId")
        cc = o["CharityRegistrationNumber"]
        if tier not in (1, 2, 3, 4) or cc in done:
            continue
        net = num(r.get("TotalResourcesLessCommittments")) if tier == 4 else num(r.get("Totalassetslesstotalliabilities"))
        cash = next((num(r.get(k)) for k in ("CashAndBankBalances", "TotalCashBalancesHeld") if num(r.get(k)) is not None), None)
        pick = {
            "cc": cc, "name": " ".join(o["Name"].split()), "tier": tier, "year_ended": end.isoformat(),
            "return_id": r["AnnualReturnId"], "flags": flags.get(cc, []),
            "declared": {"income": num(r.get("TotalGrossIncome")), "spending": num(r.get("TotalExpenditure")),
                         "net_assets": net, "cash": cash},
        }
        pool[tier]["flagged" if pick["flags"] else "other"].append(pick)

    # Roughly in proportion to the register, with Tier 1 and 2 represented; about 40% already flagged.
    want = {4: round(total * 0.5), 3: round(total * 0.37), 2: max(1, round(total * 0.1)), 1: max(1, round(total * 0.03))}
    random.seed(f"{today.isoformat()}-{batch.name}")
    picks = []
    for tier, n in want.items():
        flagged, other = pool[tier]["flagged"], pool[tier]["other"]
        random.shuffle(flagged)
        random.shuffle(other)
        k = min(len(flagged), round(n * 0.4))
        picks += flagged[:k] + other[:n - k]
    random.shuffle(picks)

    (batch / "picks.json").write_text(json.dumps(picks, indent=1), encoding="utf-8")
    chosen = {p["cc"] for p in picks}
    register = {"orgs": [o for o in orgs if o["CharityRegistrationNumber"] in chosen]}
    register["returns"] = [r for o in register["orgs"] for r in history[o["OrganisationId"]]]
    (batch / "register.json").write_text(json.dumps(register, indent=1, default=str), encoding="utf-8")
    print(len(picks), "candidates:", dict(collections.Counter(p["tier"] for p in picks)),
          "flagged:", sum(bool(p["flags"]) for p in picks), "skipped as already picked:", len(done))
    return 0


if __name__ == "__main__":
    sys.exit(main())

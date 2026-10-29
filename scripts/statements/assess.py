"""Statement reviews, step 5: compare each charity's statement readings (<batch>/results/<CC>.json)
with its annual return and the reporting rules, and write <batch>/review.json: checks, figure rows,
evidence and a verdict per charity. Standard library only.

Usage: python scripts/statements/assess.py <batch folder>
"""
import datetime as dt, json, re, sys
from collections import defaultdict
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
PILOT = Path(sys.argv[1])
picks = [p for p in json.load(open(PILOT / "picks.json", encoding="utf-8")) if p.get("status") == "downloaded"]
data = json.load(open(PILOT / "register.json", encoding="utf-8"))
NEW_STANDARDS_FROM = dt.date(2024, 4, 1)  # Tier 3 and Tier 4 (NFP) Standards: periods beginning on or after
AUDIT_OVER, REVIEW_OVER = 1_100_000, 550_000  # operating expenditure in each of the two previous years

orgs = {o["CharityRegistrationNumber"].strip().upper(): o for o in data["orgs"]}
history = defaultdict(list)
for r in data["returns"]:
    history[r["OrganisationId"]].append(r)


def day(v):
    try:
        return dt.date.fromisoformat(str(v)[:10]) if v else None
    except ValueError:
        return None


def money(v):
    return "—" if v is None else (f"-${-v:,.0f}" if v < 0 else f"${v:,.0f}")


def page_of(p):
    """'1:4' -> '4'; a later document keeps its number: '2:3' -> '3 (document 2)'."""
    if not p:
        return None
    doc, _, page = str(p).rpartition(":")
    return page if doc in ("", "1") else f"{page} (document {doc})"


def standard_tier(named):
    s = (named or "").lower()
    if re.search(r"sfr-?c|simple format reporting\W+cash|tier 4|tier four", s):
        return 4
    if re.search(r"sfr-?a|simple format reporting\W+accrual|tier 3|tier three", s):
        return 3
    if re.search(r"rdr|reduced disclosure|tier 2|tier two", s):
        return 2
    if re.search(r"pbe standards|pbe ipsas|ipsas|tier 1|tier one|public benefit entity standards", s):
        return 1
    return None


def is_old(named):
    return bool(re.search(r"sfr-?[ac]|simple format reporting", (named or "").lower()))


REQUIRED = {
    4: [("entity_information", "Entity information"), ("service_performance", "Statement of service performance"),
        ("financial_performance", "Statement of receipts and payments"), ("financial_position", "Statement of resources and commitments"),
        ("notes", "Notes")],
    3: [("entity_information", "Entity information"), ("service_performance", "Statement of service performance"),
        ("financial_performance", "Statement of financial performance"), ("financial_position", "Statement of financial position"),
        ("cash_flows", "Statement of cash flows"), ("accounting_policies", "Accounting policies")],
    2: [("service_performance", "Statement of service performance"), ("financial_performance", "Statement of comprehensive revenue and expense"),
        ("financial_position", "Statement of financial position"), ("changes_in_net_assets", "Statement of changes in net assets"),
        ("cash_flows", "Statement of cash flows"), ("notes", "Notes")],
}
REQUIRED[1] = REQUIRED[2]

reviews = []
for p in picks:
    cc = p["cc"]
    path = PILOT / "results" / f"{cc}.json"
    if not path.exists():
        continue
    res = json.load(open(path, encoding="utf-8"))
    tier, end = p["tier"], day(p["year_ended"])
    checks, figs, fails, warns = [], [], [], []

    # fail: worth a look; warn: a small thing; pass; na: not checked.
    def add(label, status, detail):
        checks.append({"label": label, "status": status, "detail": detail})
        if status == "fail":
            fails.append(detail)
        elif status == "warn":
            warns.append(detail)

    if not res.get("readable", True):
        reviews.append({**p, "verdict": "unread", "checks": [], "figures": [], "evidence": [], "fails": [],
                        "confidence": "low", "confidence_reason": res.get("confidence_reason"), "observations": res.get("observations", [])})
        continue

    # Not a draft
    dr = res.get("draft") or {}
    in_name_only = dr.get("marked") and not page_of(dr.get("page")) and re.search(r"\.(xlsx?|docx?|pdf)$", str(dr.get("quote") or ""), re.I)
    if not dr.get("marked"):
        add("Not a draft", "pass", "No draft marking found.")
    elif in_name_only:
        add("Not a draft", "warn", f"The file is named “{dr.get('quote')}”, though the pages themselves don’t say draft.")
    else:
        add("Not a draft", "fail", f"Marked draft: “{dr.get('quote')}” (p.{page_of(dr.get('page'))}).")

    # XRB standard for its tier
    st = res.get("standard") or {}
    named, basis = st.get("named"), st.get("basis")
    period = res.get("period") or {}
    start = day(period.get("start")) or (end.replace(year=end.year - 1) + dt.timedelta(days=1) if end else None)
    st_tier = standard_tier(named)
    want_basis = "cash" if tier == 4 else "accrual"
    if not named:
        add("XRB standard for its tier", "warn", "The statements don’t say which reporting standard they follow.")
    elif st_tier is None:
        add("XRB standard for its tier", "na", f"Names “{named}”, which couldn’t be matched to a tier.")
    elif st_tier < tier:
        # A charity may report under a higher tier than it has to; the return should say which.
        add("XRB standard for its tier", "warn", f"The return says Tier {tier}, but the statements use {named}, a Tier {st_tier} standard. Reporting up a tier is allowed; the return’s tier should match.")
    elif st_tier > tier:
        add("XRB standard for its tier", "warn" if tier == 1 or (tier == 2 and (p["declared"].get("spending") or 0) <= 5_000_000) else "fail",
            f"The return says Tier {tier}, but the statements use {named}, a Tier {st_tier} standard.")
    elif basis and basis != want_basis:
        add("XRB standard for its tier", "fail", f"Tier {tier} needs {want_basis} accounting; the statements use {basis}.")
    elif tier in (3, 4) and is_old(named) and start and start >= NEW_STANDARDS_FROM:
        add("XRB standard for its tier", "warn",
            f"Prepared under {named}, replaced by the Tier {tier} (NFP) Standard for years starting from 1 April 2024 (this year started {start.day} {start:%b %Y}).")
    else:
        add("XRB standard for its tier", "pass", f"Tier {tier} return, prepared under {named}{f' on a {basis} basis' if basis else ''}.")

    # Required parts
    parts = res.get("parts") or {}
    present = lambda k: bool((parts.get(k) or {}).get("present"))
    # The Tier 4 (NFP) Standard, for years starting from 1 April 2024, dropped the statement of
    # resources and commitments: significant assets and liabilities go in the notes instead.
    new_tier4 = tier == 4 and start and start >= NEW_STANDARDS_FROM and not is_old(named)
    missing = [name for key, name in REQUIRED[tier]
               if not (new_tier4 and key == "financial_position")
               and not (present(key) or (key in ("notes", "accounting_policies") and (present("notes") or present("accounting_policies"))))]
    CORE = {"Statement of service performance", "Statement of receipts and payments", "Statement of resources and commitments",
            "Statement of financial performance", "Statement of financial position", "Statement of comprehensive revenue and expense"}
    add("All required statements", ("fail" if CORE & set(missing) else "warn") if missing else "pass",
        ("Missing: " + ", ".join(missing).lower().capitalize() + ".") if missing else f"Everything Tier {tier} requires is there.")

    # Signed or approved
    ap = res.get("approval") or {}
    if ap.get("signed_or_approved"):
        add("Signed or approved", "pass", f"“{ap.get('quote')}” (p.{page_of(ap.get('page'))})." if ap.get("quote") else "Signed or approved.")
    else:
        add("Signed or approved", "warn", "No signature or approval found.")

    # Audit or review report, when the charity's size requires one
    prev = sorted((r for r in history[orgs[cc]["OrganisationId"]] if day(r["YearEnded"]) and end and day(r["YearEnded"]) < end),
                  key=lambda r: r["YearEnded"])[-2:]
    spent = [float(r.get("TotalExpenditure") or 0) for r in prev]
    need = "audit" if len(spent) == 2 and all(s > AUDIT_OVER for s in spent) else \
           "review" if len(spent) == 2 and all(s > REVIEW_OVER for s in spent) else None
    ar = res.get("assurance_report") or {}
    kind = ar.get("kind") or "none"
    if ar.get("opinion") == "modified":
        add("Audit or review report", "fail", f"The {kind} opinion is modified: “{ar.get('quote')}” (p.{page_of(ar.get('page'))}).")
    elif need == "audit" and kind != "audit":
        add("Audit or review report", "fail", f"Spending was over $1.1m in both previous years ({money(spent[0])}, {money(spent[1])}), so an audit is required; {'only a review' if kind == 'review' else 'no audit report'} found.")
    elif need == "review" and kind == "none":
        add("Audit or review report", "fail", f"Spending was over $550k in both previous years ({money(spent[0])}, {money(spent[1])}), so a review or audit is required; none found.")
    elif kind != "none":
        add("Audit or review report", "pass", f"{kind.capitalize()} report{' signed' if ar.get('signed') else ''}, opinion {ar.get('opinion') or 'not stated'}.")
    else:
        add("Audit or review report", "na", "Not required at this size." if not need else "Not required.")

    # Figures against the return
    names = {"income": "Total receipts" if tier == 4 else "Total revenue", "spending": "Total payments" if tier == 4 else "Total expenses",
             "net_assets": "Resources less commitments" if tier == 4 else "Net assets", "cash": "Cash at year end"}
    mismatched, cash_off = [], []
    for key, label in names.items():
        declared = p["declared"].get(key)
        rd = (res.get("figures") or {}).get(key) or {}
        got = rd.get("value")
        if declared is None and got is None:
            continue
        ok = got is not None and declared is not None and abs(got - declared) <= max(1.0, 0.002 * abs(declared))
        if got is not None and declared is not None and not ok:
            (cash_off if key == "cash" else mismatched).append(f"{label.lower()} {money(declared)} in the return, {money(got)} in the statement")
        figs.append({"what": label, "declared": money(declared), "statement": money(got) if got is not None else "not found",
                     "page": page_of(rd.get("page")), "ok": ok or got is None or declared is None, "quote": rd.get("quote")})
    if mismatched:
        add("Figures match the return", "fail", "Differ: " + "; ".join(mismatched + cash_off) + ".")
    elif cash_off:
        add("Figures match the return", "warn", "Totals match, but " + "; ".join(cash_off) + " (cash can be counted with or without term deposits).")
    elif figs:
        add("Figures match the return", "pass", "The figures read match the return.")

    evidence = [{"quote": f["quote"], "page": f["page"], "where": f["what"]} for f in figs if not f["ok"] and f["quote"]]
    for key in ("standard", "draft", "approval", "assurance_report"):
        q = (res.get(key) or {}).get("quote")
        if q and len(evidence) < 4 and any(c["status"] in ("fail", "warn") and key.split("_")[0] in c["label"].lower() for c in checks):
            evidence.append({"quote": q, "page": page_of((res.get(key) or {}).get("page")), "where": key.replace("_", " ")})
    if not evidence:
        for f in figs[:2]:
            if f["quote"]:
                evidence.append({"quote": f["quote"], "page": f["page"], "where": f["what"]})

    unread = res.get("confidence") == "low" and not any(f["statement"] != "not found" for f in figs)
    verdict = "unread" if unread else ("look" if fails else "minor" if warns else "fine")
    reviews.append({**p, "verdict": verdict, "checks": checks, "figures": figs, "evidence": evidence, "fails": fails, "warns": warns,
                    "confidence": res.get("confidence"), "confidence_reason": res.get("confidence_reason"),
                    "observations": res.get("observations", []), "standard_named": named, "first_page": next((f["page"] for f in figs if f["page"]), "1")})

json.dump(reviews, open(PILOT / "review.json", "w", encoding="utf-8"), indent=1, ensure_ascii=False)
from collections import Counter
print(len(reviews), "reviewed:", Counter(r["verdict"] for r in reviews))
print("worth a look:", Counter(c["label"] for r in reviews for c in r["checks"] if c["status"] == "fail"))
print("small things:", Counter(c["label"] for r in reviews for c in r["checks"] if c["status"] == "warn"))

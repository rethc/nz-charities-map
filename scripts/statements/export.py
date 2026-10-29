#!/usr/bin/env python3
"""
Statement reviews, step 7: combine a batch's checks (review.json), written assessments
(assessments.json) and the reviewer's decisions (overrides.json, optional) into the results file
an admin uploads on /admin/returns (Statements tab). Standard library only.

overrides.json, every part optional:
  {"explained_status": {"CC12345": "pass"},        # an explained figure difference: pass, or warn (default)
   "approval": {"CC12345": "why it isn't approved"}, # an approval that only looked fine
   "notes": {"CC12345": ["fail" | "warn", "what the reviewer saw"]}}

Usage: python scripts/statements/export.py <batch folder> <results file to write>
"""
import json
import sys
from pathlib import Path

batch, out = Path(sys.argv[1]), Path(sys.argv[2])
review = json.loads((batch / "review.json").read_text(encoding="utf-8"))
written = json.loads((batch / "assessments.json").read_text(encoding="utf-8"))
path = batch / "overrides.json"
overrides = {"explained_status": {}, "approval": {}, "notes": {}}
if path.exists():
    overrides.update(json.loads(path.read_text(encoding="utf-8")))
FIGURES = "Figures match the return"

reviews = []
for r in review:
    w = written.get(r["cc"], {})
    checks = [dict(c) for c in r["checks"]]
    # A difference the statement's own numbers account for exactly, with the reason. Only figure
    # differences can be explained, whatever the writer called them.
    for ex in w.get("explained", []):
        for c in checks:
            if c["label"] == FIGURES and c["status"] in ("fail", "warn"):
                c["status"] = overrides["explained_status"].get(r["cc"], "warn")
                c["detail"] = f"{c['detail']} Explained: {ex['why']}"
    if r["cc"] in overrides["approval"]:
        for c in checks:
            if c["label"] == "Signed or approved" and c["status"] == "pass":
                c["status"], c["detail"] = "warn", overrides["approval"][r["cc"]]
    if r["cc"] in overrides["notes"]:
        status, detail = overrides["notes"][r["cc"]]
        checks.append({"label": "Reviewer's note", "status": status, "detail": detail})
    statuses = {c["status"] for c in checks}
    verdict = ("unread" if r["verdict"] == "unread" and "fail" not in statuses
               else "look" if "fail" in statuses else "minor" if "warn" in statuses else "fine")
    explained = bool(w.get("explained"))
    reviews.append({
        "cc": r["cc"], "year_ended": r["year_ended"][:10], "name": r["name"], "tier": r["tier"], "verdict": verdict,
        "review": {
            "top": w.get("top") or ("All checks passed" if verdict == "fine" else (r["fails"] + r.get("warns", []) + [""])[0]),
            "assessment": w.get("assessment", ""),
            "confidence": (r.get("confidence") or "low").capitalize(),
            "confidence_why": r.get("confidence_reason") or "",
            "checks": [{"label": c["label"], "detail": c["detail"], "status": c["status"]} for c in checks],
            "figures": [{"what": f["what"], "declared": f["declared"], "statement": f["statement"], "page": f["page"] or "–",
                         "ok": bool(f["ok"] or explained)} for f in r["figures"]],
            "evidence": [{"quote": e["quote"], "page": e.get("page") or "", "where": e.get("where") or ""}
                         for e in r["evidence"] if e.get("quote")][:4],
            "first_page": str(r.get("first_page") or "1"),
        },
    })

missing = [r["cc"] for r in review if r["cc"] not in written]
if missing:
    print("no written assessment for:", ", ".join(missing))
out.write_text(json.dumps({"kind": "nz-charities-map/statement-reviews", "version": 1, "reviews": reviews},
                          ensure_ascii=False, indent=1), encoding="utf-8")
counts = {v: sum(x["verdict"] == v for x in reviews) for v in ("look", "minor", "fine", "unread")}
print(len(reviews), "reviews ->", out, counts)

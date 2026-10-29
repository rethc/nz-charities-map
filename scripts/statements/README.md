# Statement reviews

Reads charities' published financial statements and checks them against the annual return they were filed with. Results go to the admin page (/admin/returns, Statements tab). Admin-only: a reading can be wrong.

**Keep every batch folder outside this repository.** Batches hold charity names, figures and findings, which never belong in git. Something like `C:\Users\you\Documents\charity-statements\batch3`; earlier batches sit beside it in the same parent folder, so `pick.py` skips charities already reviewed.

## One-off setup

- [uv](https://docs.astral.sh/uv/) for `pick.py` (it reuses `scripts/return_checks.py`): `winget install --id=astral-sh.uv -e`
- Google Chrome, for the downloads.
- `npm install --prefix scripts/statements` (pdf.js, MuPDF and Playwright, kept apart from the site's own packages).

## A batch, step by step

```powershell
$batch = "C:\Users\you\Documents\charity-statements\batch3"
uv run scripts/statements/pick.py $batch 32                 # 1. 32 candidates (some have no statement files)
node scripts/statements/download.mjs $batch 25              # 2. 25 with statements, ~30 min at a polite pace
python scripts/statements/office_extract.py $batch          # 3a. Excel and Word filings
node scripts/statements/extract.mjs $batch                  # 3b. text and page images, reading_list.json
```

4. **Read.** In Claude Code: "read the statements in `<batch>` following `scripts/statements/READING.md`, with Sonnet helpers of about 8 charities each". Copy `READING.md` into the batch folder first. Readers open only `READING.md`, `reading_list.json`, `text/` and `pages/`, never `picks.json`, so they're blind to the return's figures. Each writes `results/<CC>.json`.

```powershell
python scripts/statements/assess.py $batch                  # 5. the checks: review.json
```

6. **Write.** A Sonnet helper follows `WRITING.md` and writes `assessments.json`. Review its report and put your decisions in `overrides.json` (format in `export.py`).

```powershell
python scripts/statements/export.py $batch "$batch\statement-reviews.json"   # 7. the results file
```

8. **Upload** the results file on /admin/returns → Statements → Upload results. Re-uploading a charity and year replaces its earlier review.

About 20,000–25,000 tokens per charity with Sonnet readers; scans cost more than text.

## What gets checked

`assess.py`: not a draft; the XRB standard suits the tier (and is the new Tier 3/4 (NFP) Standard for years from 1 April 2024); every statement the tier requires is there (the new Tier 4 Standard dropped the statement of resources and commitments); signed or approved; an audit or review report when spending over the two previous years requires one, and its opinion; income, spending, net assets and cash against the return (cash differences are a small thing: term deposits and petty cash are counted differently).

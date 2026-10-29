"""Statement reviews, step 3a: statements filed as Excel or Word files (often saved with a .pdf name): their text, and any
pictures in them, for the readers. Standard library only.

For each downloaded file in <batch>/pdf that is really a zip (xlsx or docx), writes
<batch>/office/<CC>-<n>.json: {"kind": "xlsx"|"docx", "pages": [{"label", "text"}], "images": [paths]}.
Usage: python scripts/statements/office_extract.py <batch folder>
"""
import json, re, sys, zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(sys.argv[1])
OUT = ROOT / "office"
NS = {
    "s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}
IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".gif", ".bmp"}


def col_index(ref):
    letters = re.match(r"[A-Z]+", ref).group(0)
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n


def xlsx_pages(z):
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("s:si", NS):
            shared.append("".join(t.text or "" for t in si.iter(f"{{{NS['s']}}}t")))
    book = ET.fromstring(z.read("xl/workbook.xml"))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels")).findall("rel:Relationship", NS)}
    pages = []
    for sheet in book.find("s:sheets", NS).findall("s:sheet", NS):
        target = rels.get(sheet.get(f"{{{NS['r']}}}id"), "")
        path = "xl/" + target.lstrip("/").removeprefix("xl/")
        if path not in z.namelist():
            continue
        lines = []
        for row in ET.fromstring(z.read(path)).iter(f"{{{NS['s']}}}row"):
            cells = []
            for c in row.findall("s:c", NS):
                kind, v = c.get("t"), c.find("s:v", NS)
                if kind == "s" and v is not None:
                    value = shared[int(v.text)]
                elif kind == "inlineStr":
                    value = "".join(t.text or "" for t in c.iter(f"{{{NS['s']}}}t"))
                else:
                    value = v.text if v is not None else ""
                value = (value or "").strip()
                if value:
                    cells.append((col_index(c.get("r", "A1")), value))
            if cells:
                lines.append(" | ".join(f"{chr(64 + i) if i <= 26 else i}: {v}" for i, v in cells))
        if lines:
            pages.append({"label": f"sheet '{sheet.get('name')}'", "text": "\n".join(lines)})
    return pages


def docx_pages(z):
    body = ET.fromstring(z.read("word/document.xml")).find("w:body", NS)
    lines = []
    for block in body:
        tag = block.tag.split("}")[1]
        if tag == "p":
            text = "".join(t.text or "" for t in block.iter(f"{{{NS['w']}}}t")).strip()
            if text:
                lines.append(text)
        elif tag == "tbl":
            for tr in block.iter(f"{{{NS['w']}}}tr"):
                cells = ["".join(t.text or "" for t in tc.iter(f"{{{NS['w']}}}t")).strip() for tc in tr.findall("w:tc", NS)]
                if any(cells):
                    lines.append(" | ".join(cells))
    return [{"label": "Word document", "text": "\n".join(lines)}] if lines else []


OUT.mkdir(exist_ok=True)
for f in sorted((ROOT / "pdf").glob("*")):
    if f.read_bytes()[:2] != b"PK":
        continue
    try:
        z = zipfile.ZipFile(f)
    except zipfile.BadZipFile:
        continue
    names = z.namelist()
    kind = "xlsx" if "xl/workbook.xml" in names else "docx" if "word/document.xml" in names else None
    if not kind:
        continue
    pages = xlsx_pages(z) if kind == "xlsx" else docx_pages(z)
    # Pictures inside the file (a statement pasted in as an image): saved for the reader to look at.
    images = []
    for name in names:
        if name.startswith(("word/media/", "xl/media/")) and Path(name).suffix.lower() in IMAGE_TYPES and z.getinfo(name).file_size > 20_000:
            dest = ROOT / "pages" / f.stem.split("-")[0] / f"{f.stem}-{Path(name).name}"
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(z.read(name))
            images.append(str(dest.relative_to(ROOT)).replace("\\", "/"))
    (OUT / f"{f.stem}.json").write_text(json.dumps({"kind": kind, "pages": pages, "images": images}, ensure_ascii=False), encoding="utf-8")
    print(f.name, kind, len(pages), "pages/sheets,", sum(len(p["text"]) for p in pages), "chars,", len(images), "images")

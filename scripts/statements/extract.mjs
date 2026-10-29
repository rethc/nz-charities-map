// Statement reviews, step 3 (after office_extract.py): text from each statement, page by page. Long
// documents keep only the pages that matter for the checks (plus a contents line for every page);
// scanned pages become images to read. Excel and Word filings come from office_extract.py.
// Usage: node scripts/statements/extract.mjs <batch folder>
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import * as mupdf from 'mupdf'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.argv[2] ?? '')
const picks = JSON.parse(fs.readFileSync(`${ROOT}/picks.json`, 'utf8'))
fs.mkdirSync(`${ROOT}/text`, { recursive: true })
const KEY = /statement of (financial performance|financial position|cash ?flows?|receipts and payments|resources and commitments|service performance|comprehensive revenue|changes in (net assets|equity))|entity information|basis of preparation|accounting polic|audit|review(er)?'?s? report|independent|draft|approved|signed|total (revenue|income|receipts|expenses|expenditure|payments|assets|liabilities)|net assets|tier [1234]|pbe |simple format|not-for-profit standard|reduced disclosure/i
const WORDS = /\b(the|of|and|to|for|in|total|year)\b/i
const SIGNING = /\bapproved\b|on behalf of|signature|\bsigned\b|authorised for issue/i
const PICTURE_OPS = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat].filter((x) => x !== undefined))
const FULL_LIMIT = 30000 // characters: shorter documents are kept whole
const MAX_IMAGES = 24

function pageText(tc) {
  let text = '', lastY = null
  for (const item of tc.items) {
    const y = item.transform?.[5]
    if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) text += '\n'
    else if (text && !text.endsWith(' ')) text += ' '
    text += item.str
    if (y !== undefined) lastY = y
  }
  return text.replace(/[ \t]+/g, ' ').trim()
}

for (const p of picks.filter((p) => p.status === 'downloaded')) {
  const pages = []
  const officeImages = []
  for (const [di, doc] of p.documents.entries()) {
    const data = new Uint8Array(fs.readFileSync(`${ROOT}/${doc.file}`))
    // Excel and Word filings (often saved as .pdf): office_extract.py has read them already.
    if (data[0] === 0x50 && data[1] === 0x4b) {
      const office = `${ROOT}/office/${doc.file.split('/').pop().replace(/\.[^.]+$/, '')}.json`
      const o = fs.existsSync(office) ? JSON.parse(fs.readFileSync(office, 'utf8')) : { kind: 'office', pages: [], images: [] }
      o.pages.forEach((pg, i) => pages.push({ doc: di + 1, docName: `${doc.name} (${o.kind} ${pg.label})`, n: i + 1, text: pg.text, office: true }))
      if (!o.pages.length) pages.push({ doc: di + 1, docName: doc.name, n: 1, text: '[an Office file with no text: see its pictures]', office: true })
      officeImages.push(...o.images)
      continue
    }
    try {
      const pdf = await getDocument({ data, verbosity: 0 }).promise
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n)
        const text = pageText(await page.getTextContent())
        // Signatures are often pictures on a text page, so the text alone shows an empty line.
        const pictures = SIGNING.test(text) && (await page.getOperatorList()).fnArray.some((f) => PICTURE_OPS.has(f))
        pages.push({ doc: di + 1, docName: doc.name, n, text, pictures })
      }
    } catch (err) {
      pages.push({ doc: di + 1, docName: doc.name, n: 0, text: '', error: String(err).slice(0, 100) })
    }
  }
  // A page needs reading from its image when it has almost no text (a scan, or a scan with only a
  // signature stamp) or text with no ordinary words (a broken font encoding that scrambles letters
  // and drops digits).
  for (const x of pages) x.unusable = !x.office && x.text.length >= 40 && !WORDS.test(x.text)
  const chars = pages.reduce((s, x) => s + (x.unusable ? 0 : x.text.length), 0)
  const noText = pages.filter((x) => !x.office && (x.text.length < 40 || x.unusable))
  for (const x of pages) if (x.unusable) x.text = '[the text on this page is unreadable: read its image]'
  const signing = pages.filter((x) => x.pictures && !noText.includes(x)).slice(0, 3)
  for (const x of signing) x.text += '\n[this page also has pictures, perhaps signatures: check its image]'
  const label = (x) => (x.office ? `document ${x.doc} ${x.docName.match(/\((.*)\)$/)?.[1] ?? 'page ' + x.n} (page ${x.n})` : `document ${x.doc} page ${x.n}`)
  let body
  if (chars <= FULL_LIMIT) {
    body = pages.map((x) => `===== ${label(x)} =====\n${x.text || '[no text on this page]'}`).join('\n\n')
  } else {
    const contents = pages.map((x) => `${label(x)}: ${(x.text.split('\n').find((l) => l.trim().length > 3) ?? '[no text]').slice(0, 90)}`).join('\n')
    const keep = pages.filter((x, i) => i < 2 || KEY.test(x.text))
    body = `CONTENTS (first line of every page; only the pages below are given in full)\n${contents}\n\n` +
      keep.map((x) => `===== ${label(x)} =====\n${x.text}`).join('\n\n')
  }
  fs.writeFileSync(`${ROOT}/text/${p.cc}.txt`, `${p.documents.map((d, i) => `document ${i + 1}: ${d.name}`).join('\n')}\n\n${body}`)
  p.text = { pages: pages.length, chars, pagesWithoutText: noText.length, kept: chars <= FULL_LIMIT ? 'all' : 'key pages' }
  // Scanned or unreadable pages, and approval pages with pictures: images to read.
  p.images = [...officeImages]
  const toRender = [...noText.slice(0, MAX_IMAGES), ...signing]
  if (toRender.length > 0) {
    const imgDir = `${ROOT}/pages/${p.cc}`
    fs.mkdirSync(imgDir, { recursive: true })
    for (const x of toRender) {
      if (!x.n) continue
      const doc = mupdf.Document.openDocument(fs.readFileSync(`${ROOT}/${p.documents[x.doc - 1].file}`), 'application/pdf')
      const pix = doc.loadPage(x.n - 1).toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false, true)
      const file = `${imgDir}/d${x.doc}-p${String(x.n).padStart(2, '0')}.png`
      fs.writeFileSync(file, pix.asPNG())
      p.images.push(file.replace(`${ROOT}/`, ''))
    }
    p.imagesTruncated = noText.length > MAX_IMAGES
  }
  console.log(p.cc, `T${p.tier}`, `${pages.length} pages, ${chars} chars, ${noText.length} without text, ${signing.length} signing, kept ${p.text.kept}, ${p.images.length} images`)
}
fs.writeFileSync(`${ROOT}/picks.json`, JSON.stringify(picks, null, 1))
// What the readers may open: each charity's number and page images, never the return's figures.
fs.writeFileSync(`${ROOT}/reading_list.json`, JSON.stringify(picks.filter((p) => p.status === 'downloaded').map((p) => ({ cc: p.cc, images: p.images ?? [] })), null, 1))

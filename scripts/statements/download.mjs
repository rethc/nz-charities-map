// Statement reviews, step 2: download the statement files filed with each picked charity's latest
// return, from its public register page, the way the page itself does. Unhurried: one charity at a
// time, pauses between files and charities. Needs Google Chrome installed.
// Usage: node scripts/statements/download.mjs <batch folder> [how many, default 25]
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'

const BATCH = path.resolve(process.argv[2] ?? '')
const WANT = Number(process.argv[3] ?? 25)
const dir = `${BATCH}/pdf`
fs.mkdirSync(dir, { recursive: true })
const picks = JSON.parse(fs.readFileSync(`${BATCH}/picks.json`, 'utf8'))
const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext({
  acceptDownloads: true,
  userAgent: 'Mozilla/5.0 (compatible; nz-charities-map-statement-review/1.0; +https://github.com/rethc/nz-charities-map)',
})
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
let got = 0
for (const p of picks) {
  if (got >= WANT) { p.status = 'not needed'; continue }
  const page = await context.newPage()
  try {
    await page.goto(`https://register.charities.govt.nz/Charity/${p.cc}`, { waitUntil: 'networkidle', timeout: 90000 })
    const [y, m, d] = p.year_ended.split('-').map(Number)
    const docs = await page.evaluate(([y, m, d]) => {
      const same = (t) => { const x = t.trim().split('/').map(Number); return x.length === 3 && x[0] === d && x[1] === m && x[2] === y }
      const row = [...document.querySelectorAll('tr')].find((tr) => same(tr.querySelector('td')?.textContent ?? ''))
      if (!row) return null
      return [...row.querySelectorAll('.downloadPublicFile')].map((el) => ({ id: el.dataset.documentId, list: el.dataset.searchId, name: el.title }))
    }, [y, m, d])
    p.documents = []
    if (!docs) p.status = 'no row for that year on the register'
    else if (!docs.length) p.status = 'no statement files (filed in the return form)'
    for (const [i, doc] of (docs ?? []).slice(0, 3).entries()) {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 90000 }),
        page.evaluate(([a, b]) => DownloadPublicFile(a, b), [doc.id, doc.list]),
      ])
      const file = `${dir}/${p.cc}-${i + 1}.pdf`
      await download.saveAs(file)
      p.documents.push({ file: `pdf/${p.cc}-${i + 1}.pdf`, name: doc.name, bytes: fs.statSync(file).size })
      await pause(1500)
    }
    if (p.documents.length) { p.status = 'downloaded'; got++ }
  } catch (err) {
    p.status = `error: ${String(err).slice(0, 120)}`
  }
  console.log(`${got}/${WANT}`, p.cc, `T${p.tier}`, p.status, p.documents?.map((x) => `${Math.round(x.bytes / 1024)} KB`).join(', ') ?? '')
  await page.close()
  fs.writeFileSync(`${BATCH}/picks.json`, JSON.stringify(picks, null, 1))
  await pause(3000)
}
await browser.close()
console.log('done:', got, 'charities with statements')

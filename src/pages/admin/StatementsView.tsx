import {
  Badge,
  Body1,
  Body1Strong,
  Button,
  Card,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  SearchBox,
  Spinner,
  Subtitle1,
  Subtitle2,
  Tab,
  TabList,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
  type BadgeProps,
} from '@fluentui/react-components'
import {
  ArrowMaximize20Regular,
  ArrowUpload20Regular,
  CheckmarkCircle20Filled,
  ChevronDown20Regular,
  ChevronUp20Regular,
  Dismiss24Regular,
  ErrorCircle20Filled,
  Open20Regular,
  SubtractCircle20Regular,
} from '@fluentui/react-icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { registerUrl } from '../../lib/charities'
import type { Json, StatementCheckStatus, StatementReview, StatementReviews } from '../../lib/database.types'
import { formatCount } from '../../lib/dom'
import { fold } from '../../lib/search'
import { supabase } from '../../lib/supabase'

/**
 * Statements tab of /admin/returns: each charity's published financial statements, read and
 * checked against the annual return they were filed with. Results come from a file an admin
 * uploads (statement_reviews migration); a reading is a lead to check, never a ruling.
 */

type Verdict = StatementReview['verdict']
type Filter = 'all' | Verdict
type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: StatementReviews }
  | { status: 'error'; message: string; missing: boolean }
type UploadState = { status: 'idle' } | { status: 'busy' } | { status: 'done'; count: number } | { status: 'error'; message: string }

const VERDICTS: Record<Verdict, { label: string; color: BadgeProps['color']; foot: string }> = {
  look: { label: 'Worth a look', color: 'severe', foot: 'a serious check failed' },
  minor: { label: 'Small things', color: 'warning', foot: 'only minor issues' },
  unread: { label: "Couldn't read", color: 'informative', foot: 'unreadable statements' },
  fine: { label: 'Looks fine', color: 'success', foot: 'every check passed' },
}
const ORDER: Verdict[] = ['look', 'minor', 'unread', 'fine']
const UPLOAD_KIND = 'nz-charities-map/statement-reviews'
/** Reviews per call: the database takes up to 500 at a time. */
const CHUNK = 200
const NARROW = '(max-width: 640px)'
/** Below this the review panel would drop under the list (560 + 400 px columns, plus gaps and margins). */
const COMPACT = '(max-width: 1040px)'
/** Fluent's own breakpoint for dialogs. */
const PHONE_DIALOG = '@media screen and (max-width: 480px)'
/** The list and the review pane beside it share this height, each scrolling on its own. */
const PANE_HEIGHT = 'min(75vh, 64rem)'
const COLUMNS = '150px minmax(0, 1fr) 72px 124px 104px'

const dateFormat = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const showDate = (iso: string) => dateFormat.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`))
const keyOf = (r: StatementReview) => `${r.cc}-${r.year_ended}`

const useStyles = makeStyles({
  wrap: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '16px', minWidth: 0 },
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '8px 12px' },
  search: { maxWidth: 'none' },
  // The two columns: the list (and the verdict filters above it), and the assessment (and the search).
  listSide: { flex: '999 1 min(100%, 560px)', minWidth: 0 },
  detailSide: { flex: '1 1 min(100%, 400px)', minWidth: 0 },
  filterRow: { alignItems: 'center' },
  kpis: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 13rem), 1fr))', gap: '16px' },
  kpi: { display: 'grid', gap: '6px', alignContent: 'start' },
  kpiValue: {
    fontSize: tokens.fontSizeHero800,
    lineHeight: tokens.lineHeightHero800,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
  },
  muted: { color: tokens.colorNeutralForeground3 },
  filters: { flexWrap: 'wrap', rowGap: '4px' },
  split: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '16px', minWidth: 0 },
  list: { padding: 0, gap: 0, overflow: 'hidden' },
  // The list scrolls in its own box, as the check lists do, so its headings stay in view.
  listBox: { overflow: 'auto', maxHeight: PANE_HEIGHT },
  head: {
    display: 'grid',
    gridTemplateColumns: COLUMNS,
    gap: '12px',
    padding: '10px 16px',
    position: 'sticky',
    top: 0,
    zIndex: 1,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: `0 1px 0 ${tokens.colorNeutralStroke2}`,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
    [`@media ${NARROW}`]: { display: 'none' },
  },
  row: {
    display: 'grid',
    gridTemplateColumns: COLUMNS,
    gap: '12px',
    alignItems: 'center',
    width: '100%',
    padding: '12px 16px',
    border: 0,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '-2px' },
    [`@media ${NARROW}`]: { gridTemplateColumns: 'minmax(0, 1fr)', gap: '6px' },
  },
  rowOn: {
    backgroundColor: tokens.colorBrandBackground2,
    boxShadow: `inset 3px 0 0 ${tokens.colorBrandStroke1}`,
    ':hover': { backgroundColor: tokens.colorBrandBackground2Hover },
  },
  wideOnly: { [`@media ${NARROW}`]: { display: 'none' } },
  rowName: { display: 'grid', gap: '2px', minWidth: 0 },
  name: { fontWeight: tokens.fontWeightSemibold, color: tokens.colorBrandForeground1, overflowWrap: 'anywhere' },
  top: { color: tokens.colorNeutralForeground2 },
  num: { fontVariantNumeric: 'tabular-nums' },
  empty: { padding: '24px 16px' },
  // A reading pane: as tall as the list at most, scrolling on its own, so a click never moves the page.
  detail: { display: 'grid', alignContent: 'start', gap: '20px', padding: '20px', maxHeight: PANE_HEIGHT, overflowY: 'auto' },
  section: { display: 'grid', gap: '8px', minWidth: 0 },
  badgeRow: { justifySelf: 'start' },
  checks: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  check: {
    display: 'grid',
    gridTemplateColumns: '20px minmax(0, 1fr)',
    gap: '10px',
    padding: '10px 12px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    ':last-child': { borderBottom: 0 },
  },
  checkText: { display: 'grid', gap: '2px', minWidth: 0, overflowWrap: 'anywhere' },
  pass: { color: tokens.colorStatusSuccessForeground1 },
  fail: { color: '#ad5400' },
  warn: { color: '#8a6d00' },
  na: { color: tokens.colorNeutralForeground3 },
  tableBox: { overflowX: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  right: { textAlign: 'end', fontVariantNumeric: 'tabular-nums' },
  off: { backgroundColor: '#fdf6f0' },
  offValue: { color: '#8a4300', fontWeight: tokens.fontWeightSemibold },
  quote: {
    margin: 0,
    padding: '10px 12px',
    display: 'grid',
    gap: '4px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  quoteText: { margin: 0, fontFamily: tokens.fontFamilyMonospace, overflowWrap: 'anywhere' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
  dialog: { width: 'min(1120px, calc(100vw - 32px))', maxWidth: 'none' },
  dialogContent: { display: 'grid', gap: '20px' },
  dialogGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', gap: '24px', alignItems: 'start' },
  column: { display: 'grid', gap: '20px', minWidth: 0 },
  // Fluent stacks dialog buttons on phones; Previous and Next stay side by side, and the X
  // in the title stands in for Close.
  navActions: { alignItems: 'center', [`${PHONE_DIALOG}`]: { flexDirection: 'row', justifySelf: 'stretch' } },
  navButton: { [`${PHONE_DIALOG}`]: { flex: '1 1 0' } },
  counter: { whiteSpace: 'nowrap' },
  closeActions: { [`${PHONE_DIALOG}`]: { display: 'none' } },
  hidden: { display: 'none' },
})

export function StatementsView() {
  const s = useStyles()
  const narrow = useMediaQuery(NARROW)
  const compact = useMediaQuery(COMPACT)
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [upload, setUpload] = useState<UploadState>({ status: 'idle' })
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const loading = load.status === 'loading'
  useEffect(() => {
    if (!loading) return
    let active = true
    supabase.rpc('get_statement_reviews').then(({ data, error }) => {
      if (!active) return
      if (error) {
        // Before the statement_reviews migration the function doesn't exist yet.
        const missing = error.code === 'PGRST202' || /could not find the function/i.test(error.message)
        setLoad({ status: 'error', missing, message: error.message })
      } else {
        setLoad({ status: 'ready', data: data as unknown as StatementReviews })
      }
    })
    return () => {
      active = false
    }
  }, [loading])

  const reviews = useMemo(() => {
    if (load.status !== 'ready') return []
    return load.data.reviews
      .slice()
      .sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict) || a.name.localeCompare(b.name))
  }, [load])
  const count = (v: Filter) => (v === 'all' ? reviews.length : reviews.filter((r) => r.verdict === v).length)
  const visible = useMemo(() => {
    const q = fold(query.trim())
    return reviews.filter(
      (r) => (filter === 'all' || r.verdict === filter) && (!q || fold(r.name).includes(q) || fold(r.cc).includes(q)),
    )
  }, [reviews, filter, query])
  const selected = visible.find((r) => keyOf(r) === picked) ?? visible[0] ?? null
  const index = selected ? visible.indexOf(selected) : -1
  const [full, setFull] = useState(false)
  // Each review starts at its top in the pane.
  const paneRef = useRef<HTMLDivElement>(null)
  const selectedKey = selected ? keyOf(selected) : null
  useEffect(() => {
    if (selectedKey) paneRef.current?.scrollTo({ top: 0 })
  }, [selectedKey])

  const previous = index > 0 ? visible[index - 1] : undefined
  const next = index >= 0 ? visible[index + 1] : undefined
  // Wide: a click shows the review beside the list, to scan many quickly. Compact: there's no room
  // beside the list, so a click opens the full review.
  const choose = (r: StatementReview) => {
    setPicked(keyOf(r))
    if (compact) setFull(true)
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setUpload({ status: 'busy' })
    try {
      const stored = await uploadReviews(await file.text())
      setUpload({ status: 'done', count: stored })
      setLoad({ status: 'loading' })
    } catch (err) {
      setUpload({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  if (load.status === 'loading') {
    return <Spinner label="Loading the statement reviews…" />
  }
  if (load.status === 'error') {
    return (
      <MessageBar intent={load.missing ? 'warning' : 'error'} layout="multiline">
        <MessageBarBody>
          <MessageBarTitle>{load.missing ? 'Statement reviews aren’t set up yet.' : 'Couldn’t load the statement reviews.'}</MessageBarTitle>
          {load.missing
            ? 'Run the statement_reviews migration in the Supabase SQL editor, then upload a results file here.'
            : load.message}
        </MessageBarBody>
        {!load.missing && (
          <MessageBarActions>
            <Button onClick={() => setLoad({ status: 'loading' })}>Try again</Button>
          </MessageBarActions>
        )}
      </MessageBar>
    )
  }

  const uploadedAt = load.data.reviewed_at ? new Date(load.data.reviewed_at) : null
  return (
    <div className={s.wrap}>
      <div className={s.toolbar}>
        <Body1 className={s.muted}>
          Each charity's published financial statements, read and checked against the annual return they were filed with.
          {uploadedAt && ` Last upload ${dateFormat.format(uploadedAt)}.`}
        </Body1>
        <Button icon={<ArrowUpload20Regular />} disabled={upload.status === 'busy'} onClick={() => fileRef.current?.click()}>
          {upload.status === 'busy' ? 'Uploading…' : 'Upload results'}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className={s.hidden}
          aria-label="Results file"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
      </div>

      {upload.status === 'done' && (
        <MessageBar intent="success">
          <MessageBarBody>
            Uploaded {formatCount(upload.count)} {upload.count === 1 ? 'review' : 'reviews'}. A charity and year uploaded again replaces its earlier review.
          </MessageBarBody>
        </MessageBar>
      )}
      {upload.status === 'error' && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Couldn't upload that file.</MessageBarTitle>
            {upload.message}
          </MessageBarBody>
        </MessageBar>
      )}

      {reviews.length === 0 ? (
        <Card>
          <Subtitle2 as="h2">No statement reviews yet</Subtitle2>
          <Body1>Upload a results file to add them.</Body1>
        </Card>
      ) : (
        <>
          <section aria-label="Statement review summary" className={s.kpis}>
            <Card className={s.kpi}>
              <Body1>Statements read</Body1>
              <Text className={s.kpiValue}>{formatCount(reviews.length)}</Text>
              <Body1 className={s.muted}>across all four tiers</Body1>
            </Card>
            {(['look', 'minor', 'fine'] as const).map((v) => (
              <Card key={v} className={s.kpi}>
                <Body1>{VERDICTS[v].label}</Body1>
                <Text className={s.kpiValue}>{formatCount(count(v))}</Text>
                <Body1 className={s.muted}>{VERDICTS[v].foot}</Body1>
              </Card>
            ))}
          </section>

          {/* Split like the list and assessment below, so the search box lines up with the assessment. */}
          <div className={mergeClasses(s.split, s.filterRow)}>
            <TabList
              appearance="subtle-circular"
              className={mergeClasses(s.listSide, s.filters)}
              selectedValue={filter}
              onTabSelect={(_, d) => setFilter(d.value as Filter)}
              aria-label="Filter by verdict"
            >
              {(['all', ...ORDER] as Filter[]).map((v) => (
                <Tab key={v} value={v}>
                  {v === 'all' ? 'All' : VERDICTS[v].label}{' '}
                  <Badge appearance="tint" color="informative" shape="circular" size="small">
                    {formatCount(count(v))}
                  </Badge>
                </Tab>
              ))}
            </TabList>
            <SearchBox
              className={mergeClasses(s.detailSide, s.search)}
              placeholder="Search name or CC number"
              aria-label="Search the statement reviews"
              value={query}
              onChange={(_, d) => setQuery(d.value)}
            />
          </div>

          <div className={s.split}>
            <Card className={mergeClasses(s.listSide, s.list)}>
              <div className={s.listBox}>
                <div className={s.head} aria-hidden="true">
                  <span>Verdict</span>
                  <span>Charity and main finding</span>
                  <span>Tier</span>
                  <span>Year ended</span>
                  <span>Confidence</span>
                </div>
                {visible.map((r) => {
                  const on = selected !== null && keyOf(r) === keyOf(selected)
                  return (
                    <button
                      key={keyOf(r)}
                      type="button"
                      aria-current={on ? 'true' : undefined}
                      className={mergeClasses(s.row, on && s.rowOn)}
                      onClick={() => choose(r)}
                    >
                      <span>
                        <Badge appearance="tint" shape="rounded" color={VERDICTS[r.verdict].color}>
                          {VERDICTS[r.verdict].label}
                        </Badge>
                      </span>
                      <span className={s.rowName}>
                        <span className={s.name}>{r.name}</span>
                        <span className={s.top}>{r.review.top}</span>
                      </span>
                      <span className={mergeClasses(s.num, s.wideOnly)}>{r.tier ? `Tier ${r.tier}` : '—'}</span>
                      <span className={mergeClasses(s.num, s.wideOnly)}>{showDate(r.year_ended)}</span>
                      <span className={s.wideOnly}>{r.review.confidence}</span>
                    </button>
                  )
                })}
                {visible.length === 0 && <Body1 className={mergeClasses(s.empty, s.muted)}>No charities match.</Body1>}
              </div>
            </Card>

            {selected && !compact && (
              <Card ref={paneRef} className={mergeClasses(s.detailSide, s.detail)} aria-label="Assessment" role="region" tabIndex={0}>
                <QuickView review={selected} onOpen={() => setFull(true)} />
              </Card>
            )}
            {selected && full && (
              <FullReview
                review={selected}
                position={index + 1}
                total={visible.length}
                narrow={narrow}
                onPrevious={previous ? () => setPicked(keyOf(previous)) : null}
                onNext={next ? () => setPicked(keyOf(next)) : null}
                onClose={() => setFull(false)}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}

const CHECK_ICON: Record<StatementCheckStatus, { icon: typeof CheckmarkCircle20Filled; label: string }> = {
  pass: { icon: CheckmarkCircle20Filled, label: 'Passed' },
  fail: { icon: ErrorCircle20Filled, label: 'Worth a look' },
  warn: { icon: ErrorCircle20Filled, label: 'Small thing' },
  na: { icon: SubtractCircle20Regular, label: 'Not checked' },
}

/** Verdict, name, and the charity's number, tier and year. */
function Heading({ review: r, title = true }: { review: StatementReview; title?: boolean }) {
  const s = useStyles()
  return (
    <div className={s.section}>
      <Badge className={s.badgeRow} appearance="tint" shape="rounded" size="large" color={VERDICTS[r.verdict].color}>
        {VERDICTS[r.verdict].label}
      </Badge>
      {title && <Subtitle1 as="h2">{r.name}</Subtitle1>}
      <Body1 className={s.muted}>
        {r.cc} · {r.tier ? `Tier ${r.tier}` : 'Tier unknown'} · year ended {showDate(r.year_ended)}
      </Body1>
    </div>
  )
}

function AssessmentText({ review: r }: { review: StatementReview }) {
  const s = useStyles()
  return (
    <div className={s.section}>
      <Subtitle2 as="h3">Assessment</Subtitle2>
      <Body1>{r.review.assessment}</Body1>
      <Body1 className={s.muted}>
        Confidence: {r.review.confidence}. {r.review.confidence_why}
      </Body1>
    </div>
  )
}

function Checks({ review: r }: { review: StatementReview }) {
  const s = useStyles()
  return (
    <div className={s.section}>
      <Subtitle2 as="h3">Checks</Subtitle2>
      <ul className={s.checks}>
        {r.review.checks.map((c) => {
          const { icon: Icon, label } = CHECK_ICON[c.status] ?? CHECK_ICON.na
          return (
            <li key={c.label} className={s.check}>
              <Icon className={s[c.status] ?? s.na} role="img" aria-label={label} />
              <span className={s.checkText}>
                <Body1Strong>{c.label}</Body1Strong>
                <Body1>{c.detail}</Body1>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function Figures({ review: r, narrow }: { review: StatementReview; narrow: boolean }) {
  const s = useStyles()
  if (r.review.figures.length === 0) return null
  return (
    <div className={s.section}>
      <Subtitle2 as="h3">Figures: return against statement</Subtitle2>
      <div className={s.tableBox}>
        <Table size="small" aria-label="Figures: return against statement">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Figure</TableHeaderCell>
              <TableHeaderCell className={s.right}>In the return</TableHeaderCell>
              <TableHeaderCell className={s.right}>In the statement</TableHeaderCell>
              {!narrow && <TableHeaderCell className={s.right}>Page</TableHeaderCell>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.review.figures.map((g) => (
              <TableRow key={g.what} className={g.ok ? undefined : s.off}>
                <TableCell>{g.what}</TableCell>
                <TableCell className={s.right}>{g.declared}</TableCell>
                <TableCell className={mergeClasses(s.right, !g.ok && s.offValue)}>{g.statement}</TableCell>
                {!narrow && <TableCell className={s.right}>{g.page === '–' ? '–' : `p.${g.page}`}</TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function Evidence({ review: r }: { review: StatementReview }) {
  const s = useStyles()
  if (r.review.evidence.length === 0) return null
  return (
    <div className={s.section}>
      <Subtitle2 as="h3">From the statement</Subtitle2>
      {r.review.evidence.map((e) => (
        <figure key={`${e.where}-${e.page}-${e.quote}`} className={s.quote}>
          <blockquote className={s.quoteText}>“{e.quote}”</blockquote>
          <figcaption>
            <Body1 className={s.muted}>
              {e.page ? `Page ${e.page}, ` : ''}
              {e.where}
            </Body1>
          </figcaption>
        </figure>
      ))}
    </div>
  )
}

function RegisterLink({ review: r, appearance }: { review: StatementReview; appearance: 'primary' | 'secondary' }) {
  return (
    <Button appearance={appearance} as="a" href={registerUrl(r.cc)} target="_blank" rel="noopener noreferrer" icon={<Open20Regular />}>
      Open the register page
    </Button>
  )
}

function WhereToLook({ review: r }: { review: StatementReview }) {
  const s = useStyles()
  return (
    <Body1 className={s.muted}>
      The statement is filed with the return for the year ended {showDate(r.year_ended)}; start at page {r.review.first_page}. A lead to
      check, never a ruling.
    </Body1>
  )
}

/** The panel beside the list: the verdict, the assessment and the checks. */
function QuickView({ review: r, onOpen }: { review: StatementReview; onOpen: () => void }) {
  const s = useStyles()
  return (
    <>
      <Heading review={r} />
      <AssessmentText review={r} />
      <div className={s.actions}>
        <Button appearance="primary" icon={<ArrowMaximize20Regular />} onClick={onOpen}>
          Open full review
        </Button>
        <RegisterLink review={r} appearance="secondary" />
      </div>
      <Checks review={r} />
    </>
  )
}

/**
 * Everything about one review in a large dialog, in two columns, with Previous and Next to step
 * through the filtered list without closing it (as a record form does in Dynamics 365).
 */
function FullReview({ review: r, position, total, narrow, onPrevious, onNext, onClose }: {
  review: StatementReview
  position: number
  total: number
  narrow: boolean
  onPrevious: (() => void) | null
  onNext: (() => void) | null
  onClose: () => void
}) {
  const s = useStyles()
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={s.dialog}>
        <DialogBody>
          <DialogTitle
            action={
              <DialogTrigger action="close">
                <Button appearance="subtle" aria-label="Close" icon={<Dismiss24Regular />} />
              </DialogTrigger>
            }
          >
            {r.name}
          </DialogTitle>
          <DialogContent className={s.dialogContent}>
            <Heading review={r} title={false} />
            <div className={s.dialogGrid}>
              <div className={s.column}>
                <AssessmentText review={r} />
                <Checks review={r} />
              </div>
              <div className={s.column}>
                <Figures review={r} narrow={narrow} />
                <Evidence review={r} />
                <div className={s.section}>
                  <div className={s.actions}>
                    <RegisterLink review={r} appearance="primary" />
                  </div>
                  <WhereToLook review={r} />
                </div>
              </div>
            </div>
          </DialogContent>
          <DialogActions position="start" className={s.navActions}>
            <Button className={s.navButton} icon={<ChevronUp20Regular />} disabled={!onPrevious} onClick={onPrevious ?? undefined}>
              Previous
            </Button>
            <Button className={s.navButton} icon={<ChevronDown20Regular />} disabled={!onNext} onClick={onNext ?? undefined}>
              Next
            </Button>
            <Body1 className={mergeClasses(s.muted, s.counter)} aria-live="polite">
              {formatCount(position)} of {formatCount(total)}
            </Body1>
          </DialogActions>
          <DialogActions position="end" className={s.closeActions}>
            <DialogTrigger action="close">
              <Button appearance="secondary">Close</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}

/** Checks a results file and uploads its reviews in batches. Returns how many were stored. */
async function uploadReviews(text: string): Promise<number> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('That file isn’t valid JSON.')
  }
  const file = parsed as { kind?: unknown; version?: unknown; reviews?: unknown }
  if (file?.kind !== UPLOAD_KIND || file.version !== 1 || !Array.isArray(file.reviews)) {
    throw new Error('That isn’t a statement review results file.')
  }
  const reviews = file.reviews as StatementReview[]
  const bad = reviews.find(
    (r) => !r || typeof r.cc !== 'string' || typeof r.name !== 'string' || !ORDER.includes(r.verdict) || typeof r.review !== 'object',
  )
  if (bad) throw new Error(`A review in the file is incomplete${bad && typeof bad.cc === 'string' ? ` (${bad.cc})` : ''}.`)
  let stored = 0
  for (let i = 0; i < reviews.length; i += CHUNK) {
    const { data, error } = await supabase.rpc('upsert_statement_reviews', { p_reviews: reviews.slice(i, i + CHUNK) as unknown as Json })
    if (error) throw new Error(stored ? `${error.message} (${stored} were stored before this)` : error.message)
    stored += data ?? 0
  }
  return stored
}

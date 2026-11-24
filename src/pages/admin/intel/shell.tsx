import {
  Badge,
  Body1,
  Breadcrumb,
  BreadcrumbButton,
  BreadcrumbDivider,
  BreadcrumbItem,
  Button,
  Caption1,
  Card,
  FluentProvider,
  makeStyles,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Subtitle2,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TabList,
  Title3,
  tokens,
} from '@fluentui/react-components'
import { ArrowSync20Regular, DataBarVertical20Regular, Eye16Regular, Flag16Filled, Table20Regular } from '@fluentui/react-icons'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { RequireAdmin } from '../../../components/RequireAdmin'
import { SetupScreen } from '../../../components/StatusScreens'
import { missingEnv } from '../../../lib/env'
import { hasPreview, LEVEL_NAME, loadIntel, MEASURE, type Intel, type IntelRow, type Level, type MeasureKey } from '../../../lib/intel'
import { AdminBar, theme } from '../AdminFrame'

/** What the three intelligence pages share: signing in, loading the snapshot, the heading and the tabs. */

export type View = 'overview' | 'watchlist' | 'charity'

export const PATHS: Record<View, string> = {
  overview: '/admin/intelligence',
  watchlist: '/admin/intelligence/watchlist',
  charity: '/admin/intelligence/charity',
}
export const charityPath = (cc: string) => `${PATHS.charity}/${encodeURIComponent(cc)}`
/** The watchlist ranked by a measure, with the filters the overview had on. */
export function watchlistPath(options: { measure?: MeasureKey | 'combined'; size?: number | null; sector?: string | null; flagged?: boolean } = {}) {
  const params = new URLSearchParams()
  if (options.measure && options.measure !== 'combined') params.set('m', options.measure)
  if (options.size) params.set('size', String(options.size))
  if (options.sector) params.set('sector', options.sector)
  if (options.flagged) params.set('flagged', '1')
  const query = params.toString()
  return query ? `${PATHS.watchlist}?${query}` : PATHS.watchlist
}

const longDate = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'long', year: 'numeric' })
export const showDay = (iso: string | null) => {
  if (!iso) return '—'
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`)
  return Number.isNaN(d.getTime()) ? '—' : longDate.format(d)
}

const useStyles = makeStyles({
  root: { height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: tokens.colorNeutralBackground3 },
  scroll: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto' },
  page: { maxWidth: '1760px', margin: '0 auto', padding: '16px clamp(16px, 3vw, 32px) 40px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '16px' },
  head: { display: 'grid', gap: '6px' },
  titleRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px' },
  tabs: { flexWrap: 'wrap', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  center: { display: 'grid', placeItems: 'center', minHeight: '240px' },
  card: { display: 'grid', gap: '12px', alignContent: 'start', minWidth: 0 },
  cardHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' },
  cardTitle: { display: 'grid', gap: '2px', minWidth: 0 },
  cardActions: { display: 'flex', flex: 'none', gap: '4px' },
  muted: { color: tokens.colorNeutralForeground3 },
  foot: { color: tokens.colorNeutralForeground3, borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: '8px' },
  tableBox: { overflowX: 'auto', minWidth: 0 },
  number: { textAlign: 'end', fontVariantNumeric: 'tabular-nums' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: '4px 6px' },
})

type Load = { status: 'loading' } | { status: 'ready'; intel: Intel } | { status: 'error'; message: string }

/** The snapshot, shared by the pages once one has loaded it. */
function useIntel() {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    loadIntel(attempt > 0).then(
      (intel) => active && setLoad({ status: 'ready', intel }),
      (err: unknown) => active && setLoad({ status: 'error', message: err instanceof Error ? err.message : String(err) }),
    )
    return () => {
      active = false
    }
  }, [attempt])
  const retry = useCallback(() => {
    setLoad({ status: 'loading' })
    setAttempt((n) => n + 1)
  }, [])
  return { load, retry }
}

export function IntelShell({ view, title, children }: { view: View; title: string; children: (intel: Intel) => ReactNode }) {
  // `npm run dev` can serve a dry run of the script: those pages need no sign-in and no database.
  const [preview, setPreview] = useState<boolean | null>(import.meta.env.DEV ? null : false)
  useEffect(() => {
    if (preview !== null) return
    let active = true
    void hasPreview().then((yes) => active && setPreview(yes))
    return () => {
      active = false
    }
  }, [preview])

  const page = (email: string | null) => (
    <Frame view={view} email={email}>
      {children}
    </Frame>
  )
  return (
    <>
      <title>{`${title} – NZ Charities Map`}</title>
      {preview === null ? null : preview ? (
        page(null)
      ) : missingEnv.length ? (
        <SetupScreen missing={missingEnv} />
      ) : (
        <RequireAdmin>{(session) => page(session.user.email ?? null)}</RequireAdmin>
      )}
    </>
  )
}

function Frame({ view, email, children }: { view: View; email: string | null; children: (intel: Intel) => ReactNode }) {
  const s = useStyles()
  const navigate = useNavigate()
  const { load, retry } = useIntel()
  const intel = load.status === 'ready' ? load.intel : null

  return (
    <FluentProvider theme={theme} className={s.root}>
      <AdminBar email={email} current="/admin/intelligence" />
      <div className={s.scroll}>
        <main className={s.page}>
          <div className={s.head}>
            <Breadcrumb aria-label="Breadcrumb" size="small">
              <BreadcrumbItem>
                <BreadcrumbButton onClick={() => navigate('/admin/triage')}>Admin</BreadcrumbButton>
              </BreadcrumbItem>
              <BreadcrumbDivider />
              <BreadcrumbItem>
                <BreadcrumbButton current>Intelligence</BreadcrumbButton>
              </BreadcrumbItem>
            </Breadcrumb>
            <div className={s.titleRow}>
              <Title3 as="h1">Intelligence</Title3>
              {intel && (
                <Badge appearance="outline" color="informative" size="large" icon={<ArrowSync20Regular />}>
                  Register read {showDay(intel.meta.as_of)}
                </Badge>
              )}
              <Badge appearance="tint" color="brand" size="large">
                Public data, post-publication
              </Badge>
              {intel?.preview && (
                <Badge appearance="filled" color="warning" size="large">
                  Preview from this computer
                </Badge>
              )}
            </div>
          </div>

          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Reasons to look, not findings.</MessageBarTitle>
              Automated measures of the Charities Register's public data, read after publication. Some are wrong: check
              the register before acting on one.
            </MessageBarBody>
          </MessageBar>

          <TabList
            className={s.tabs}
            selectedValue={view}
            onTabSelect={(_, d) => navigate(PATHS[d.value as View])}
            aria-label="Intelligence pages"
          >
            <Tab value="overview">Sector overview</Tab>
            <Tab value="watchlist">Watchlist</Tab>
            <Tab value="charity">Charity profile</Tab>
          </TabList>

          {load.status === 'loading' && (
            <div className={s.center}>
              <Spinner label="Loading every charity's measures…" />
            </div>
          )}
          {load.status === 'error' && (
            <MessageBar intent="error" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>Couldn't load the intelligence.</MessageBarTitle>
                {load.message}
              </MessageBarBody>
              <MessageBarActions>
                <Button onClick={retry}>Try again</Button>
              </MessageBarActions>
            </MessageBar>
          )}
          {intel && children(intel)}
        </main>
      </div>
    </FluentProvider>
  )
}

// ---- Parts the pages share --------------------------------------------------------------------

export interface TableView {
  head: string[]
  rows: (string | number)[][]
}

/** A card around a chart, with a button that shows the same figures as a table. */
export function ChartCard({
  title,
  description,
  action,
  table,
  foot,
  children,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  table?: TableView
  foot?: ReactNode
  children: ReactNode
}) {
  const s = useStyles()
  const [asTable, setAsTable] = useState(false)
  return (
    <Card className={s.card}>
      <div className={s.cardHead}>
        <div className={s.cardTitle}>
          <Subtitle2 as="h3">{title}</Subtitle2>
          {description && <Body1 className={s.muted}>{description}</Body1>}
        </div>
        <div className={s.cardActions}>
          {table && (
            <Button
              appearance="subtle"
              icon={asTable ? <DataBarVertical20Regular /> : <Table20Regular />}
              aria-pressed={asTable}
              onClick={() => setAsTable((v) => !v)}
            >
              {asTable ? 'Chart' : 'Table'}
            </Button>
          )}
          {action}
        </div>
      </div>
      {asTable && table ? <FigureTable table={table} label={title} /> : children}
      {foot && <Caption1 className={s.foot}>{foot}</Caption1>}
    </Card>
  )
}

export function FigureTable({ table, label }: { table: TableView; label: string }) {
  const s = useStyles()
  return (
    <div className={s.tableBox}>
      <Table size="small" aria-label={label}>
        <TableHeader>
          <TableRow>
            {table.head.map((h, i) => (
              <TableHeaderCell key={h} className={i ? s.number : undefined}>
                {h}
              </TableHeaderCell>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {table.rows.map((row) => (
            <TableRow key={String(row[0])}>
              {row.map((cell, i) => (
                <TableCell key={i} className={i ? s.number : undefined}>
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** A signal level as a badge: an icon and words, never colour alone. */
export function LevelBadge({ level, children }: { level: Level; children?: ReactNode }) {
  if (level === 0) {
    return (
      <Badge appearance="tint" color="subtle" shape="rounded">
        {children ?? LEVEL_NAME[0]}
      </Badge>
    )
  }
  return (
    <Badge
      appearance={level === 2 ? 'filled' : 'tint'}
      color={level === 2 ? 'danger' : 'warning'}
      shape="rounded"
      icon={level === 2 ? <Flag16Filled /> : <Eye16Regular />}
      title={LEVEL_NAME[level]}
    >
      {children ?? LEVEL_NAME[level]}
    </Badge>
  )
}

/** The signals a charity trips, by name. */
export function SignalChips({ intel, row, max }: { intel: Intel; row: IntelRow; max?: number }) {
  const s = useStyles()
  const flagged = intel.meta.signal_order.filter((k) => row.levels[k] > 0).sort((a, b) => row.levels[b] - row.levels[a])
  if (!flagged.length) return null
  const shown = max ? flagged.slice(0, max) : flagged
  return (
    <span className={s.chips}>
      {shown.map((k) => (
        <LevelBadge key={k} level={row.levels[k]}>
          {MEASURE[k].chip ?? MEASURE[k].title}
        </LevelBadge>
      ))}
      {shown.length < flagged.length && (
        <Badge appearance="tint" color="subtle" shape="rounded">
          +{flagged.length - shown.length}
        </Badge>
      )}
    </span>
  )
}

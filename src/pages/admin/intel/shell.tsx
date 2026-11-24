import {
  Badge,
  Body1,
  Body1Strong,
  Breadcrumb,
  BreadcrumbButton,
  BreadcrumbDivider,
  BreadcrumbItem,
  Button,
  Caption1,
  Card,
  CardHeader,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  FluentProvider,
  InfoLabel,
  makeStyles,
  mergeClasses,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Skeleton,
  SkeletonItem,
  Subtitle1,
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
  ToggleButton,
  tokens,
  typographyStyles,
  type InfoLabelProps,
} from '@fluentui/react-components'
import { ArrowSync20Regular, Eye16Regular, Flag16Filled, QuestionCircle16Regular, QuestionCircle20Regular, Table20Regular } from '@fluentui/react-icons'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { RequireAdmin } from '../../../components/RequireAdmin'
import { SetupScreen } from '../../../components/StatusScreens'
import { missingEnv } from '../../../lib/env'
import {
  bandName,
  BAND_RANGE,
  BANDS,
  GROUP_ORDER,
  GROUPS,
  hasPreview,
  isSignal,
  LEVEL_NAME,
  loadIntel,
  MEASURE,
  MEASURES,
  ruleText,
  SIGNAL_MEANS,
  TIER_MEANS,
  type Intel,
  type IntelRow,
  type Level,
  type MeasureKey,
} from '../../../lib/intel'
import { AdminBar, theme } from '../AdminFrame'

/**
 * What the three intelligence pages share: signing in, loading the snapshot, the page heading
 * and tabs, and the building blocks (sections, cards, figures) that keep the pages alike.
 * Spacing, colour and type come from Fluent's tokens, so the pages follow the theme.
 */

export type View = 'overview' | 'watchlist' | 'charity'

export const PATHS: Record<View, string> = {
  overview: '/admin/intelligence',
  watchlist: '/admin/intelligence/watchlist',
  charity: '/admin/intelligence/charity',
}
const VIEW_NAME: Record<View, string> = { overview: 'Sector overview', watchlist: 'Watchlist', charity: 'Charity profile' }
export const charityPath = (cc: string) => `${PATHS.charity}/${encodeURIComponent(cc)}`
/** The watchlist ranked by a measure, with the filters the overview had on. */
export function watchlistPath(options: { measure?: MeasureKey | 'combined'; tier?: number | null; sector?: string | null; show?: 1 | 2 } = {}) {
  const params = new URLSearchParams()
  if (options.measure && options.measure !== 'combined') params.set('m', options.measure)
  if (options.tier) params.set('tier', String(options.tier))
  if (options.sector) params.set('sector', options.sector)
  if (options.show) params.set('show', String(options.show))
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
  page: {
    maxWidth: '1600px',
    margin: '0 auto',
    padding: `${tokens.spacingVerticalL} clamp(16px, 3vw, 32px) ${tokens.spacingVerticalXXXL}`,
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    gap: tokens.spacingVerticalL,
  },
  head: { display: 'grid', gap: tokens.spacingVerticalXS },
  titleRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}` },
  lead: { color: tokens.colorNeutralForeground2, maxWidth: '80ch' },
  tabs: { flexWrap: 'wrap', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  // Sections and cards
  section: { display: 'grid', gap: tokens.spacingVerticalM, minWidth: 0 },
  sectionHead: { display: 'grid', gap: tokens.spacingVerticalXXS },
  card: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', alignContent: 'start', gap: tokens.spacingVerticalM, minWidth: 0 },
  cardHeader: { alignItems: 'start' },
  cardActions: { display: 'flex', flex: 'none', alignItems: 'center', gap: tokens.spacingHorizontalXS, whiteSpace: 'nowrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  foot: { color: tokens.colorNeutralForeground3, borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: tokens.spacingVerticalS },
  tableBox: { overflowX: 'auto', minWidth: 0 },
  number: { textAlign: 'end', fontVariantNumeric: 'tabular-nums' },
  numberHead: { justifyContent: 'flex-end' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalXS}` },
  // A figure with its name and a line under it
  stat: {
    display: 'grid',
    gap: tokens.spacingVerticalXXS,
    alignContent: 'start',
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    borderInlineStartWidth: '3px',
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: tokens.colorNeutralStroke2,
    minWidth: 0,
  },
  statLook: { borderInlineStartColor: tokens.colorPaletteMarigoldBorderActive },
  statPriority: { borderInlineStartColor: tokens.colorPaletteRedBorderActive },
  statValue: { ...typographyStyles.title3, fontVariantNumeric: 'tabular-nums' },
  // Nothing to show
  empty: {
    display: 'grid',
    justifyItems: 'center',
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalXXXL} ${tokens.spacingHorizontalL}`,
    textAlign: 'center',
  },
  emptyIcon: {
    display: 'grid',
    placeItems: 'center',
    width: '56px',
    height: '56px',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground3,
  },
  emptyText: { color: tokens.colorNeutralForeground2, maxWidth: '56ch' },
  // What the measures mean
  guide: { display: 'grid', gap: tokens.spacingVerticalL },
  guideGroup: { display: 'grid', gap: tokens.spacingVerticalS },
  guideList: { display: 'grid', gap: tokens.spacingVerticalM, margin: 0 },
  guideItem: { display: 'grid', gap: tokens.spacingVerticalXXS },
  guideText: { margin: 0 },
  guideLimits: { margin: 0, paddingInlineStart: tokens.spacingHorizontalXL },
  // While the snapshot loads
  skeleton: { display: 'grid', gap: tokens.spacingVerticalL },
  skeletonRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 15rem), 1fr))', gap: tokens.spacingHorizontalL },
  skeletonCard: { display: 'grid', gap: tokens.spacingVerticalM },
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
    // Fluent would otherwise copy the page's own styles (full height, a background) onto the layer
    // its menus and dialogs open in, and that layer would cover the page.
    <FluentProvider theme={theme} className={s.root} applyStylesToPortals={false}>
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
                <BreadcrumbButton onClick={() => navigate(PATHS.overview)}>Intelligence</BreadcrumbButton>
              </BreadcrumbItem>
              <BreadcrumbDivider />
              <BreadcrumbItem>
                <BreadcrumbButton current>{VIEW_NAME[view]}</BreadcrumbButton>
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
                <Badge appearance="tint" color="warning" size="large">
                  Preview from this computer
                </Badge>
              )}
            </div>
            <Body1 className={s.lead}>
              Every registered charity's last 5 years, from the Charities Register's public data: annual returns, officers and
              what each charity says it does.
            </Body1>
          </div>

          <TabList className={s.tabs} selectedValue={view} onTabSelect={(_, d) => navigate(PATHS[d.value as View])} aria-label="Intelligence pages">
            <Tab value="overview">{VIEW_NAME.overview}</Tab>
            <Tab value="watchlist">{VIEW_NAME.watchlist}</Tab>
            <Tab value="charity">{VIEW_NAME.charity}</Tab>
          </TabList>

          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>These are reasons to look, not findings.</MessageBarTitle>
              The figures are worked out automatically, and some will be wrong. Check the register before acting on one.
            </MessageBarBody>
          </MessageBar>

          {load.status === 'loading' && <PageSkeleton />}
          {load.status === 'error' && (
            <MessageBar intent="error" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>The figures could not be loaded.</MessageBarTitle>
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

/** Grey shapes where the page will be, while every charity's figures download. */
function PageSkeleton() {
  const s = useStyles()
  return (
    <Skeleton aria-label="Loading every charity's figures" className={s.skeleton}>
      <div className={s.skeletonRow}>
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} size="large" className={s.skeletonCard}>
            <SkeletonItem size={16} style={{ width: '50%' }} />
            <SkeletonItem size={36} style={{ width: '40%' }} />
            <SkeletonItem size={12} style={{ width: '70%' }} />
          </Card>
        ))}
      </div>
      {[0, 1].map((i) => (
        <Card key={i} size="large" className={s.skeletonCard}>
          <SkeletonItem size={20} style={{ width: '18rem', maxWidth: '100%' }} />
          {[0, 1, 2, 3, 4].map((j) => (
            <SkeletonItem key={j} size={16} />
          ))}
        </Card>
      ))}
    </Skeleton>
  )
}

// ---- Building blocks the pages share ----------------------------------------------------------

/** A part of a page: a heading, a line under it, and what belongs to it. */
export function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  const s = useStyles()
  return (
    <section className={s.section} aria-label={title}>
      <div className={s.sectionHead}>
        <Subtitle1 as="h2">{title}</Subtitle1>
        {description && <Body1 className={s.muted}>{description}</Body1>}
      </div>
      {children}
    </section>
  )
}

/** A card with Fluent's card header: a title, a line under it, and actions at the right. */
export function Panel({
  title,
  description,
  action,
  foot,
  level = 3,
  className,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  foot?: ReactNode
  /** The heading level of the title: 2 for a card that stands on its own, 3 inside a section. */
  level?: 2 | 3
  className?: string
  children: ReactNode
}) {
  const s = useStyles()
  return (
    <Card size="large" className={mergeClasses(s.card, className)}>
      <CardHeader
        className={s.cardHeader}
        header={<Subtitle2 as={level === 2 ? 'h2' : 'h3'}>{title}</Subtitle2>}
        description={description ? <Caption1 className={s.muted}>{description}</Caption1> : undefined}
        action={action ? <div className={s.cardActions}>{action}</div> : undefined}
      />
      {children}
      {foot && <Caption1 className={s.foot}>{foot}</Caption1>}
    </Card>
  )
}

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
  level,
  children,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  table: TableView
  foot?: ReactNode
  level?: 2 | 3
  children: ReactNode
}) {
  const [asTable, setAsTable] = useState(false)
  return (
    <Panel
      title={title}
      description={description}
      foot={foot}
      level={level}
      action={
        <>
          <ToggleButton appearance="subtle" icon={<Table20Regular />} checked={asTable} onClick={() => setAsTable((v) => !v)}>
            Table
          </ToggleButton>
          {action}
        </>
      }
    >
      {asTable ? <FigureTable table={table} label={title} /> : children}
    </Panel>
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
              <TableHeaderCell key={h} button={i ? { className: s.numberHead } : undefined}>
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

/** One figure: what it counts, the number, and a line under it. `level` marks a signal's figure. */
export function Stat({ label, value, foot, level = 0 }: { label: ReactNode; value: ReactNode; foot?: ReactNode; level?: Level }) {
  const s = useStyles()
  return (
    <div className={mergeClasses(s.stat, level === 1 && s.statLook, level === 2 && s.statPriority)}>
      <Caption1 className={s.muted}>{label}</Caption1>
      <span className={s.statValue}>{value}</span>
      {foot && <Caption1 className={s.muted}>{foot}</Caption1>}
    </div>
  )
}

/** Shown where a list or a page has nothing to show yet. */
export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  const s = useStyles()
  return (
    <div className={s.empty}>
      <span className={s.emptyIcon} aria-hidden="true">
        {icon}
      </span>
      <Subtitle2 as="h2">{title}</Subtitle2>
      {children && <Body1 className={s.emptyText}>{children}</Body1>}
      {action}
    </div>
  )
}

/** A label with Fluent's help button beside it: select the button to read what the label means. */
export function HelpLabel({ info, children, ...props }: InfoLabelProps) {
  return (
    <InfoLabel {...props} info={info} infoButton={{ children: <QuestionCircle16Regular />, 'aria-label': 'What this means' }}>
      {children}
    </InfoLabel>
  )
}

/** A button that opens every measure's meaning, and where its signal starts, in one dialog. */
export function MeasureGuide({ intel }: { intel: Intel }) {
  const s = useStyles()
  return (
    <Dialog>
      <DialogTrigger disableButtonEnhancement>
        <Button appearance="subtle" icon={<QuestionCircle20Regular />}>
          About these measures
        </Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>What the measures mean</DialogTitle>
          <DialogContent className={s.guide}>
            <Body1>
              {SIGNAL_MEANS} A signal has 2 levels: “worth a look” and “priority”. The other measures give context and do not
              count as signals.
            </Body1>
            {GROUP_ORDER.map((g) => (
              <section key={g} className={s.guideGroup}>
                <Subtitle2 as="h3">{GROUPS[g]}</Subtitle2>
                <dl className={s.guideList}>
                  {MEASURES.filter((m) => m.group === g).map((m) => (
                    <div key={m.key} className={s.guideItem}>
                      <dt>
                        <Body1Strong>{m.title}</Body1Strong>
                      </dt>
                      <dd className={s.guideText}>
                        <Body1>{m.description}</Body1>
                      </dd>
                      {isSignal(intel.meta, m.key) && (
                        <dd className={s.guideText}>
                          <Caption1 className={s.muted}>Signal. {ruleText(intel.meta, m.key)}</Caption1>
                        </dd>
                      )}
                    </div>
                  ))}
                </dl>
              </section>
            ))}
            <section className={s.guideGroup}>
              <Subtitle2 as="h3">Reporting tier</Subtitle2>
              <Body1>{TIER_MEANS}</Body1>
              <ul className={s.guideLimits}>
                {BANDS.map((b) => (
                  <li key={b}>
                    <Body1>
                      {bandName(b)}: {BAND_RANGE[b]}
                    </Body1>
                  </li>
                ))}
              </ul>
            </section>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="primary">Close</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
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

/** The signals a charity has, by name, the most serious first. */
export function SignalChips({ intel, row, max }: { intel: Intel; row: IntelRow; max?: number }) {
  const s = useStyles()
  const flagged = intel.meta.signal_order.filter((k) => row.levels[k] > 0).sort((a, b) => row.levels[b] - row.levels[a])
  if (!flagged.length) return null
  const shown = max ? flagged.slice(0, max) : flagged
  return (
    <span className={s.chips}>
      {shown.map((k) => (
        <LevelBadge key={k} level={row.levels[k]}>
          {MEASURE[k].short}
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

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useCharityDetail } from '../hooks/useCharityDetail'
import { directionsUrl, formatAddress, registerUrl, type CharityPoint } from '../lib/charities'
import { BackIcon, CloseIcon, DirectionsIcon, ExternalIcon, LinkIcon } from './Icons'

interface CommonProps {
  titleId: string
  onClose: () => void
  /** Move focus to the heading when opened from the keyboard (e.g. a search result). */
  focusOnMount?: boolean
}

/** The registered group a charity is a member of; `point` is set when the group itself is on the map. */
export interface PartOf {
  name: string
  point: CharityPoint | null
}

const textLink = 'font-semibold underline decoration-ink/30 underline-offset-4 hover:decoration-ink'
const button =
  'inline-flex grow items-center justify-center gap-2 rounded-xl px-3.5 py-2.5 text-[0.9375rem] font-semibold transition duration-150 active:scale-[0.98] motion-reduce:active:scale-100'
const buttonQuiet = `${button} border border-line hover:border-ink/40 hover:bg-paper`
const fieldName = 'text-sm text-muted'

function useFocusOnMount<T extends HTMLElement>(enabled: boolean | undefined) {
  const ref = useRef<T>(null)
  useEffect(() => {
    if (enabled) ref.current?.focus({ preventScroll: true })
  }, [enabled])
  return ref
}

/**
 * The popup and the sheet keep their scroll position when their content is swapped, so a
 * charity opened from a link further down (its group, a member) would start part-way through.
 */
function useStartAtTop<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    for (let el = ref.current?.parentElement; el; el = el.parentElement) {
      if (el.scrollTop > 0) el.scrollTop = 0
    }
  }, [])
  return ref
}

function CloseButton({ onClose, label }: { onClose: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label={label}
      className="-mt-1 -mr-2 grid size-9 flex-none place-items-center rounded-full text-muted transition-colors hover:bg-paper hover:text-ink"
    >
      <CloseIcon />
    </button>
  )
}

const NewTab = () => <span className="sr-only">(opens in a new tab)</span>

/** A `tel:` link for a single plain number; anything wordier ("0800 SALLIES", two numbers) stays as text. */
function telHref(phone: string): string | null {
  const digits = phone.replace(/\D/g, '').length
  return /^[\d\s()+.-]+$/.test(phone) && digits >= 7 && digits <= 15 ? `tel:${phone.replace(/[^\d+]/g, '')}` : null
}

/** The address is register data, so only ever link to plain web addresses. */
function webLink(website: string | null | undefined): { href: string; text: string } | null {
  if (!website || !/^https?:\/\//i.test(website)) return null
  try {
    const url = new URL(website)
    return { href: url.href, text: url.host.replace(/^www\./i, '') }
  } catch {
    return null
  }
}

export function CharityDetails({
  point,
  colour,
  titleId,
  onClose,
  onBack,
  backLabel,
  focusOnMount,
  partOf,
  members = [],
  colourOf,
  onGoTo,
}: CommonProps & {
  point: CharityPoint
  colour: string
  onBack?: () => void
  backLabel?: string
  partOf?: PartOf | null
  /** For a registered group: its member charities that are on the map. */
  members?: CharityPoint[]
  colourOf: (sector: string) => string
  /** Show another charity (a member, or the group) and move the map to it. */
  onGoTo: (point: CharityPoint) => void
}) {
  const detail = useCharityDetail(point.cc)
  const headingRef = useFocusOnMount<HTMLHeadingElement>(focusOnMount)
  const topRef = useStartAtTop<HTMLElement>()
  const info = detail.status === 'ready' ? detail.detail : null
  const website = webLink(info?.website)
  const tel = info?.phone ? telHref(info.phone) : null
  const summary = point.isGroup ? 'group summary' : 'charity summary'

  return (
    <article ref={topRef} aria-labelledby={titleId} className="p-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="-ml-1.5 mb-2 inline-flex items-center gap-1 rounded-md py-0.5 pr-2 pl-1 text-sm font-semibold text-muted hover:bg-paper hover:text-ink"
            >
              <BackIcon size={16} />
              {backLabel ?? 'Back'}
            </button>
          )}
          {point.isGroup && (
            <p className="mb-1 text-xs font-bold tracking-wider text-muted uppercase">Registered group</p>
          )}
          <h2
            id={titleId}
            ref={headingRef}
            tabIndex={-1}
            className="text-xl leading-snug font-bold tracking-tight text-balance break-words focus:outline-none focus-visible:outline-2"
          >
            {point.name}
          </h2>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="font-semibold tabular-nums">
              <span className="sr-only">Registration number </span>
              {point.cc}
            </span>
            <span className="text-muted" aria-hidden="true">
              ·
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="sr-only">Sector: </span>
              <span className="sector-dot text-ink" style={{ backgroundColor: colour }} aria-hidden="true" />
              {point.sector}
            </span>
          </p>
        </div>
        <CloseButton onClose={onClose} label="Close details" />
      </div>

      {detail.status === 'loading' ? (
        <div className="mt-4 space-y-2" aria-hidden="true">
          <span className="skeleton block h-3.5 w-full" />
          <span className="skeleton block h-3.5 w-4/5" />
        </div>
      ) : (
        info?.purpose && <Purpose text={info.purpose} />
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <a
          href={registerUrl(point.cc)}
          target="_blank"
          rel="noopener noreferrer"
          className={`${button} basis-full bg-ink text-paper hover:bg-ink-soft`}
        >
          Open {summary}
          <ExternalIcon size={16} />
          <NewTab />
        </a>
        <a href={directionsUrl(point.lonLat)} target="_blank" rel="noopener noreferrer" className={buttonQuiet}>
          <DirectionsIcon size={16} />
          Directions
          <NewTab />
        </a>
        <CopyLinkButton cc={point.cc} />
      </div>

      <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 border-t border-line pt-4 text-[0.9375rem] leading-snug">
        {info?.activity && (
          <>
            <dt className={fieldName}>Activity</dt>
            <dd>{info.activity}</dd>
          </>
        )}
        {info?.beneficiary && (
          <>
            <dt className={fieldName}>Helps</dt>
            <dd>{info.beneficiary}</dd>
          </>
        )}
        {partOf && (
          <>
            <dt className={fieldName}>Part of</dt>
            <dd>
              {partOf.point ? (
                <button type="button" onClick={() => onGoTo(partOf.point!)} className={`${textLink} text-left`}>
                  {partOf.name}
                </button>
              ) : (
                partOf.name
              )}
            </dd>
          </>
        )}

        <dt className={fieldName}>Address</dt>
        <dd aria-live="polite" aria-busy={detail.status === 'loading'}>
          {detail.status === 'loading' && (
            <span className="block space-y-1.5 pt-1" aria-label="Loading address">
              <span className="skeleton block h-3.5 w-11/12" />
              <span className="skeleton block h-3.5 w-2/3" />
            </span>
          )}
          {detail.status === 'ready' &&
            ((info && formatAddress(info)) || <span className="text-muted">Not listed</span>)}
          {detail.status === 'error' && (
            <span className="text-muted">Couldn't load the details. The {summary} lists them.</span>
          )}
        </dd>

        {info?.phone && (
          <>
            <dt className={fieldName}>Phone</dt>
            <dd>
              {tel ? (
                <a href={tel} className={textLink}>
                  {info.phone}
                </a>
              ) : (
                info.phone
              )}
            </dd>
          </>
        )}
        {info?.email && (
          <>
            <dt className={fieldName}>Email</dt>
            <dd>
              <a href={`mailto:${info.email}`} className={`${textLink} break-all`}>
                {info.email}
              </a>
            </dd>
          </>
        )}
        {website && (
          <>
            <dt className={fieldName}>Website</dt>
            <dd>
              <a
                href={website.href}
                target="_blank"
                rel="noopener noreferrer"
                className={`${textLink} inline-flex max-w-full items-center gap-1.5`}
              >
                <span className="min-w-0 truncate">{website.text}</span>
                <ExternalIcon size={14} className="flex-none" />
                <NewTab />
              </a>
            </dd>
          </>
        )}
      </dl>

      {members.length > 0 && <Members members={members} colourOf={colourOf} onGoTo={onGoTo} />}
    </article>
  )
}

/** The charity's own statement of what it is for; long ones start folded. */
function Purpose({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 170

  return (
    <div className="mt-3 text-[0.9375rem] leading-relaxed">
      <p className={long && !open ? 'line-clamp-3' : undefined}>
        <span className="sr-only">Purpose: </span>
        {text}
      </p>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={`${textLink} mt-1 text-sm`}
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

/** A registered group's member charities. Only those with a pin: the group summary lists them all. */
function Members({
  members,
  colourOf,
  onGoTo,
}: {
  members: CharityPoint[]
  colourOf: (sector: string) => string
  onGoTo: (point: CharityPoint) => void
}) {
  const headingId = useId()
  const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name, 'en-NZ'))

  return (
    <section aria-labelledby={headingId} className="mt-5 border-t border-line pt-4">
      <h3 id={headingId} className="text-sm font-semibold">
        Members on the map <span className="font-normal text-muted tabular-nums">({members.length})</span>
      </h3>
      <ul className="mt-2 max-h-48 overflow-y-auto overscroll-contain rounded-lg border border-line">
        {sorted.map((m) => (
          <li key={m.cc} className="border-b border-line last:border-b-0">
            <button
              type="button"
              onClick={() => onGoTo(m)}
              aria-label={m.place ? `${m.name}, ${m.place}` : m.name}
              className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-paper focus-visible:-outline-offset-2"
            >
              <span
                className="sector-dot mt-1.5 text-ink"
                style={{ backgroundColor: colourOf(m.sector) }}
                aria-hidden="true"
              />
              <span className="min-w-0">
                <span className="block text-[0.9375rem] leading-snug font-semibold break-words">{m.name}</span>
                {m.place && <span className="block text-sm text-muted">{m.place}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function CopyLinkButton({ cc }: { cc: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const id = window.setTimeout(() => setState('idle'), 2500)
    return () => window.clearTimeout(id)
  }, [state])

  async function copy() {
    const url = new URL('/', window.location.origin)
    url.searchParams.set('cc', cc)
    try {
      await navigator.clipboard.writeText(url.toString())
      setState('copied')
    } catch {
      setState('failed')
    }
  }

  return (
    <button type="button" onClick={copy} className={buttonQuiet}>
      <LinkIcon size={16} />
      <span aria-live="polite">{state === 'copied' ? 'Link copied' : state === 'failed' ? "Couldn't copy" : 'Copy link'}</span>
    </button>
  )
}

/** Several charities registered at the same address — pick one. */
export function CharityGroup({
  points,
  colourOf,
  titleId,
  onClose,
  onPick,
  focusOnMount,
}: CommonProps & {
  points: CharityPoint[]
  colourOf: (sector: string) => string
  onPick: (point: CharityPoint) => void
}) {
  const headingRef = useFocusOnMount<HTMLHeadingElement>(focusOnMount)
  const topRef = useStartAtTop<HTMLElement>()
  const sorted = [...points].sort((a, b) => a.name.localeCompare(b.name, 'en-NZ'))

  return (
    <section ref={topRef} aria-labelledby={titleId} className="flex max-h-[inherit] flex-col">
      <div className="flex items-start gap-3 px-5 pt-5 pb-3">
        <h2
          id={titleId}
          ref={headingRef}
          tabIndex={-1}
          className="min-w-0 flex-1 text-lg leading-snug font-bold focus:outline-none focus-visible:outline-2"
        >
          {points.length} charities share this location
        </h2>
        <CloseButton onClose={onClose} label="Close list" />
      </div>
      <ul className="max-h-80 overflow-y-auto overscroll-contain border-t border-line">
        {sorted.map((p) => (
          <li key={p.cc} className="border-b border-line last:border-b-0">
            <button
              type="button"
              onClick={() => onPick(p)}
              aria-label={`${p.name}, ${p.cc}, ${p.sector}`}
              className="flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-paper focus-visible:-outline-offset-2"
            >
              <span
                className="sector-dot mt-1.5 text-ink"
                style={{ backgroundColor: colourOf(p.sector) }}
                aria-hidden="true"
              />
              <span className="min-w-0">
                <span className="block leading-snug font-semibold break-words">{p.name}</span>
                <span className="block text-sm text-muted">
                  {p.cc}, {p.sector}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

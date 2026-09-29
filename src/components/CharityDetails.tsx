import { useEffect, useRef, useState } from 'react'
import { useCharityDetail } from '../hooks/useCharityDetail'
import { formatAddress, registerUrl, type CharityPoint } from '../lib/charities'
import { BackIcon, CloseIcon, ExternalIcon, LinkIcon } from './Icons'

interface CommonProps {
  titleId: string
  onClose: () => void
  /** Move focus to the heading when opened from the keyboard (e.g. a search result). */
  focusOnMount?: boolean
}

function useFocusOnMount<T extends HTMLElement>(enabled: boolean | undefined) {
  const ref = useRef<T>(null)
  useEffect(() => {
    if (enabled) ref.current?.focus({ preventScroll: true })
  }, [enabled])
  return ref
}

function CloseButton({ onClose, label }: { onClose: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label={label}
      className="-mt-1 -mr-2 grid size-9 flex-none place-items-center rounded-full text-muted hover:bg-paper hover:text-ink"
    >
      <CloseIcon />
    </button>
  )
}

export function CharityDetails({
  point,
  colour,
  titleId,
  onClose,
  onBack,
  backLabel,
  focusOnMount,
}: CommonProps & {
  point: CharityPoint
  colour: string
  onBack?: () => void
  backLabel?: string
}) {
  const detail = useCharityDetail(point.cc)
  const headingRef = useFocusOnMount<HTMLHeadingElement>(focusOnMount)

  return (
    <article aria-labelledby={titleId} className="p-5">
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
          <h2
            id={titleId}
            ref={headingRef}
            tabIndex={-1}
            className="text-xl leading-snug font-bold text-balance break-words focus:outline-none focus-visible:outline-2"
          >
            {point.name}
          </h2>
        </div>
        <CloseButton onClose={onClose} label="Close details" />
      </div>

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-[0.9375rem] leading-snug">
        <dt className="text-sm text-muted">Registration</dt>
        <dd className="font-semibold tabular-nums">{point.cc}</dd>

        <dt className="text-sm text-muted">Sector</dt>
        <dd className="flex items-center gap-2">
          <span className="sector-dot text-ink" style={{ backgroundColor: colour }} aria-hidden="true" />
          {point.sector}
        </dd>

        <dt className="text-sm text-muted">Address</dt>
        <dd aria-live="polite" aria-busy={detail.status === 'loading'}>
          {detail.status === 'loading' && (
            <span className="block space-y-1.5 pt-1" aria-label="Loading address">
              <span className="skeleton block h-3.5 w-11/12" />
              <span className="skeleton block h-3.5 w-2/3" />
            </span>
          )}
          {detail.status === 'ready' &&
            ((detail.detail && formatAddress(detail.detail)) || <span className="text-muted">Not listed</span>)}
          {detail.status === 'error' && (
            <span className="text-muted">Couldn't load the address. The register profile lists it.</span>
          )}
        </dd>
      </dl>

      <div className="mt-5 flex flex-wrap gap-2">
        <a
          href={registerUrl(point.cc)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg bg-ink px-3.5 py-2 text-[0.9375rem] font-semibold text-paper hover:bg-ink-soft"
        >
          Open register profile
          <ExternalIcon size={16} />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
        <CopyLinkButton cc={point.cc} />
      </div>
    </article>
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
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-2 rounded-lg border border-line px-3.5 py-2 text-[0.9375rem] font-semibold hover:border-ink"
    >
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
  const sorted = [...points].sort((a, b) => a.name.localeCompare(b.name, 'en-NZ'))

  return (
    <section aria-labelledby={titleId} className="flex max-h-[inherit] flex-col">
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

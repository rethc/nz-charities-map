import {
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'

export interface PanelSize {
  width: number
  height: number
}

interface PanelProps {
  labelledBy: string
  /** Reports the panel's size so the map can keep the selected place clear of it (zero once it has gone). */
  onSizeChange?: (size: PanelSize) => void
  children: ReactNode
}

function useReportSize(ref: RefObject<HTMLElement | null>, onSizeChange: PanelProps['onSizeChange']) {
  useEffect(() => {
    const el = ref.current
    if (!el || !onSizeChange) return
    let last = { width: -1, height: -1 }
    const observer = new ResizeObserver(() => {
      const next = { width: Math.round(el.offsetWidth), height: Math.round(el.offsetHeight) }
      if (next.width === last.width && next.height === last.height) return
      last = next
      onSizeChange(next)
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      onSizeChange({ width: 0, height: 0 })
    }
  }, [ref, onSizeChange])
}

const DISMISS_DISTANCE = 96 // px dragged down
const DISMISS_VELOCITY = 0.6 // px per ms (a quick flick)

/**
 * Non-modal sheet along the bottom: the map stays usable above it. Drag the handle down to close.
 * `clearTop` is the height that must stay free above it (the header, and room for the selected
 * place), so the sheet never grows over them; longer content scrolls inside.
 */
export function BottomSheet({
  labelledBy,
  onClose,
  onSizeChange,
  clearTop = 0,
  children,
}: PanelProps & { onClose: () => void; clearTop?: number }) {
  const sheetRef = useRef<HTMLElement>(null)
  const drag = useRef<{ startY: number; lastY: number; lastT: number; velocity: number } | null>(null)
  useReportSize(sheetRef, onSizeChange)

  function setOffset(px: number, animate: boolean) {
    const el = sheetRef.current
    if (!el) return
    el.style.transition = animate ? 'transform 180ms var(--ease-out-quart)' : 'none'
    el.style.transform = px ? `translateY(${px}px)` : ''
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startY: e.clientY, lastY: e.clientY, lastT: e.timeStamp, velocity: 0 }
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d) return
    const dt = Math.max(1, e.timeStamp - d.lastT)
    d.velocity = (e.clientY - d.lastY) / dt
    d.lastY = e.clientY
    d.lastT = e.timeStamp
    setOffset(Math.max(0, e.clientY - d.startY), false)
  }

  function onPointerEnd(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current
    drag.current = null
    if (!d) return
    const distance = e.clientY - d.startY
    if (distance > DISMISS_DISTANCE || (distance > 24 && d.velocity > DISMISS_VELOCITY)) onClose()
    else setOffset(0, true)
  }

  return (
    <section
      ref={sheetRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={labelledBy}
      style={{ maxHeight: `max(11rem, min(58dvh, calc(100dvh - ${clearTop}px)))` }}
      // Full width on a phone; on anything wider it sits centred rather than stretching edge to edge.
      className="animate-sheet-in fixed inset-x-0 bottom-0 z-30 mx-auto flex max-w-xl flex-col rounded-t-2xl bg-white shadow-float"
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        className="flex h-6 flex-none cursor-grab touch-none items-center justify-center active:cursor-grabbing"
        aria-hidden="true"
      >
        <span className="h-1 w-8 rounded-full bg-mist" />
      </div>
      <div className="-mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
        {children}
      </div>
    </section>
  )
}

/**
 * For screens too short for a sheet under the header (a phone on its side): the details take
 * the left edge, over the header, and the map keeps the rest.
 */
export function SidePanel({ labelledBy, onSizeChange, children }: PanelProps) {
  const panelRef = useRef<HTMLElement>(null)
  useReportSize(panelRef, onSizeChange)

  return (
    <section
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={labelledBy}
      className="animate-side-in fixed inset-y-0 left-0 z-30 w-[min(24rem,52vw)] overflow-y-auto overscroll-contain bg-white pl-[env(safe-area-inset-left)] shadow-float"
    >
      {children}
    </section>
  )
}

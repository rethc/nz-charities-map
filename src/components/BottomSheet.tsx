import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'

interface BottomSheetProps {
  labelledBy: string
  onClose: () => void
  /** Reports the sheet's height so the map can keep the selected place above it. */
  onHeightChange?: (height: number) => void
  children: ReactNode
}

const DISMISS_DISTANCE = 96 // px dragged down
const DISMISS_VELOCITY = 0.6 // px per ms (a quick flick)

/** Non-modal sheet for phones: the map stays usable above it. Drag the handle down to close. */
export function BottomSheet({ labelledBy, onClose, onHeightChange, children }: BottomSheetProps) {
  const sheetRef = useRef<HTMLElement>(null)
  const drag = useRef<{ startY: number; lastY: number; lastT: number; velocity: number } | null>(null)

  useEffect(() => {
    const el = sheetRef.current
    if (!el || !onHeightChange) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) onHeightChange(Math.round(entry.borderBoxSize[0]?.blockSize ?? el.offsetHeight))
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      onHeightChange(0)
    }
  }, [onHeightChange])

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
      className="animate-sheet-in fixed inset-x-0 bottom-0 z-30 flex max-h-[72dvh] flex-col rounded-t-2xl bg-white shadow-float"
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        className="flex h-6 flex-none cursor-grab touch-none items-center justify-center active:cursor-grabbing"
        aria-hidden="true"
      >
        <span className="h-1.5 w-10 rounded-full bg-line" />
      </div>
      <div className="-mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
        {children}
      </div>
    </section>
  )
}

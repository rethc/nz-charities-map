import { useLayoutEffect, useRef, useState } from 'react'

export interface Box {
  width: number
  height: number
  /** Viewport coordinates of the right and bottom edges. */
  right: number
  bottom: number
}

/** Tracks an element's size and position, e.g. so the map can keep places clear of floating panels. */
export function useElementBox<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [box, setBox] = useState<Box>({ width: 0, height: 0, right: 0, bottom: 0 })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const r = el.getBoundingClientRect()
      const next = { width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }
      setBox((prev) =>
        prev.width === next.width && prev.height === next.height && prev.right === next.right && prev.bottom === next.bottom
          ? prev
          : next,
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])

  return [ref, box] as const
}

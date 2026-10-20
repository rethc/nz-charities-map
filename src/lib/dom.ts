/** True when a single-key shortcut should be ignored because the user is typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

/** 25415 → "25,415". Written out because the browser's number formatting is slow to start up. */
export const formatCount = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** Lets the browser paint and respond to input before a long job carries on. */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  return scheduler?.yield ? scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0))
}

/** The longest a download waits for the first paint, in case the browser never reports it. */
const MAX_PAINT_WAIT = 1000

let firstPaint: Promise<void> | undefined

/**
 * Resolves once the browser has put the page's first content on screen: straight away in a
 * background tab (which doesn't paint), and after a second at most.
 *
 * Large downloads wait for this so they don't compete with the first view. Lighthouse also
 * counts any download that finishes before that moment as delaying it, which made the score
 * swing from run to run.
 */
export function whenFirstPainted(): Promise<void> {
  firstPaint ??= new Promise<void>((resolve) => {
    if (document.visibilityState === 'hidden' || performance.getEntriesByName('first-contentful-paint').length) {
      resolve()
      return
    }
    let observer: PerformanceObserver | undefined
    const done = () => {
      observer?.disconnect()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onHidden)
      resolve()
    }
    const onHidden = () => {
      if (document.visibilityState === 'hidden') done()
    }
    const timer = setTimeout(done, MAX_PAINT_WAIT)
    document.addEventListener('visibilitychange', onHidden)

    if (PerformanceObserver.supportedEntryTypes?.includes('paint')) {
      observer = new PerformanceObserver((list) => {
        if (list.getEntriesByName('first-contentful-paint').length) done()
      })
      observer.observe({ type: 'paint', buffered: true })
    } else {
      // No paint timing: a timeout set inside an animation frame runs once that frame is drawn.
      requestAnimationFrame(() => setTimeout(done, 0))
    }
  })
  return firstPaint
}

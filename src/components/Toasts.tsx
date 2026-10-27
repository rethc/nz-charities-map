import { useCallback, useRef, useState } from 'react'
import { CheckIcon, CloseIcon } from './Icons'

export interface Toast {
  id: number
  tone: 'success' | 'error'
  message: string
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), [])
  const push = useCallback(
    (tone: Toast['tone'], message: string) => {
      const id = nextId.current++
      setToasts((all) => [...all.slice(-2), { id, tone, message }])
      window.setTimeout(() => dismiss(id), tone === 'error' ? 9000 : 4000)
    },
    [dismiss],
  )
  return { toasts, push, dismiss }
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'error' ? 'alert' : 'status'}
          className={`animate-toast-in pointer-events-auto flex items-start gap-3 rounded border-l-4 bg-white px-4 py-3 text-base text-ink shadow-float ${
            t.tone === 'error' ? 'border-alert' : t.tone === 'success' ? 'border-fern' : 'border-brand'
          }`}
        >
          {t.tone === 'success' && <CheckIcon className="flex-none text-fern" />}
          <p className="min-w-0 flex-1 break-words">{t.message}</p>
          <button
            type="button"
            onClick={() => onDismiss(t.id)}
            aria-label="Dismiss"
            className="-mr-1 grid size-7 flex-none place-items-center rounded text-muted hover:bg-paper hover:text-ink"
          >
            <CloseIcon size={16} />
          </button>
        </div>
      ))}
    </div>
  )
}

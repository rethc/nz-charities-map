/** True when a single-key shortcut should be ignored because the user is typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export const formatCount = (n: number) => n.toLocaleString('en-NZ')

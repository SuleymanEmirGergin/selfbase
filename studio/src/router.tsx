import { useSyncExternalStore } from 'react'
import type { AnchorHTMLAttributes, MouseEvent } from 'react'

// shortcut: a minimal history router (path only, no nested route objects); adopt a library if routes need loaders.
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((f) => f())
window.addEventListener('popstate', emit)
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f) } }

export function navigate(to: string, replace = false) {
  history[replace ? 'replaceState' : 'pushState'](null, '', to)
  emit()
}

export const usePath = () => useSyncExternalStore(subscribe, () => location.pathname)

export function Link({ to, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e)
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(to)
  }
  return <a href={to} onClick={click} {...rest} />
}

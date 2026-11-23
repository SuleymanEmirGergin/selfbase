// A reversible action waits `ms` before it is committed; undo() before then cancels it.

type Clock = { set: (fn: () => void, ms: number) => number; clear: (id: number) => void }
const browserClock: Clock = { set: (fn, ms) => window.setTimeout(fn, ms), clear: (id) => window.clearTimeout(id) }

/**
 * `onTick` gets the whole seconds left, starting with the full count. pause() stops the count (the toast has focus
 * or the pointer); resume() goes on from the second shown, so a pause never shortens the time left.
 */
export function startUndo(ms: number, commit: () => void, onTick: (left: number) => void, clock: Clock = browserClock) {
  let left = Math.ceil(ms / 1000)
  let open = true
  let paused = false
  let id: number | null = null
  const tick = () => {
    id = null
    if (!open || paused) return
    if (left <= 0) { open = false; commit(); return }
    onTick(left)
    left--
    id = clock.set(tick, Math.min(1000, ms))
  }
  const stop = () => { if (id !== null) clock.clear(id); id = null }
  tick()
  return {
    /** true when the action was still pending and is now cancelled */
    undo: () => { if (!open) return false; open = false; stop(); return true },
    pause: () => { paused = true; stop() },
    resume: () => { if (!paused) return; paused = false; if (open) id = clock.set(tick, Math.min(1000, ms)) },
  }
}

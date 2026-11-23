import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, PointerEvent } from 'react'
import { Icon, Status } from './ui.tsx'
import { Brand } from './glyphs.tsx'
import { rich, t } from './i18n/index.ts'

// Left half of the pages reachable without a session: sign-in direction A, "Malzeme" (sdd signin-v4.html?v=a).
// Self-contained so another direction can replace it without touching the forms. The art is decorative and aria-hidden:
// the pipeline is sample content, never fed from the API, and shows no project data. The one control is the video toggle.

const STEPS = ['ensure', 'healthy', 'certificate', 'warm']
const STEP_MS = 1500
const HOLD_MS = 6500
const TICK_MS = 250
const PAUSE_KEY = 'studio-signin-video-paused'

// Live media queries: the panel reacts when reduced motion is switched on, or the window narrows, while it is open.
const media = (q: string) => [
  (cb: () => void) => { const m = matchMedia(q); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb) },
  () => matchMedia(q).matches,
] as const
const REDUCE = media('(prefers-reduced-motion: reduce)')
const NARROW = media('(max-width: 760px)') // the stacked layout in styles.css
const subscribeVisible = (cb: () => void) => { document.addEventListener('visibilitychange', cb); return () => document.removeEventListener('visibilitychange', cb) }
const saveData = () => (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true
const readPaused = () => { try { return sessionStorage.getItem(PAUSE_KEY) === '1' } catch { return false } }

export function SignInPanel() {
  const reduce = useSyncExternalStore(...REDUCE)
  const narrow = useSyncExternalStore(...NARROW)
  const visible = useSyncExternalStore(subscribeVisible, () => !document.hidden)
  const [paused, setPaused] = useState(readPaused)
  // No video at all (so nothing is fetched) on a phone strip, with Data Saver on, or under reduced motion.
  const canVideo = !reduce && !narrow && !saveData()
  const motion = canVideo && !paused
  const video = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [run, setRun] = useState({ cycle: 0, t: 0 })

  useEffect(() => {
    const v = video.current
    if (!v) { setPlaying(false); return }
    v.defaultMuted = true // the muted attribute itself: old iOS Safari only autoplays inline with it
    // Autoplay can be refused (policy): then the still stays and nothing else happens.
    v.play().catch(() => {})
  }, [motion])
  useEffect(() => {
    if (!motion || !visible) return
    const id = setInterval(() => setRun((r) => (r.t + TICK_MS >= STEPS.length * STEP_MS + HOLD_MS ? { cycle: r.cycle + 1, t: 0 } : { ...r, t: r.t + TICK_MS })), TICK_MS)
    return () => clearInterval(id)
  }, [motion, visible])
  const toggle = () => {
    setPaused(!paused)
    try { sessionStorage.setItem(PAUSE_KEY, paused ? '0' : '1') } catch { /* private mode: the choice lasts for this page only */ }
  }

  // without motion the sample pipeline sits finished
  const k = motion ? Math.min(STEPS.length, Math.floor(run.t / STEP_MS)) : STEPS.length
  const ok = k >= STEPS.length
  // the pointer is a torch on the metal (hover devices only; the CSS hides it under a playing video)
  const torch = (e: PointerEvent<HTMLDivElement>) => {
    if (!motion || e.pointerType !== 'mouse') return
    const r = e.currentTarget.getBoundingClientRect()
    e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left + r.width * 0.04}px`)
    e.currentTarget.style.setProperty('--my', `${e.clientY - r.top + r.height * 0.04}px`)
  }

  return (
    <div className="si-left">
      <div className={`a-panel${motion ? '' : ' still'}`} onPointerMove={torch} aria-hidden="true">
        <div className={`a-art${motion && playing ? ' has-vid' : ''}`}>
          <i />
          {motion && (
            <video ref={video} className="a-vid" muted loop playsInline preload="metadata" poster="/signin/art.webp" onPlaying={() => setPlaying(true)}>
              <source src="/signin/loop.mp4" type="video/mp4" />
              <source src="/signin/loop.webm" type="video/webm" />
            </video>
          )}
          {/* light passes across the metal once per finished step, a full pass when the sample deploy lands */}
          {motion && k > 0 && <i key={`${run.cycle}-${k}`} className="sheen go" style={{ '--so': ok ? 0.7 : 0.32, '--sd': ok ? '3.2s' : '2.2s' } as CSSProperties} />}
          <i className="torch" />
        </div>
        <Brand />
        <div className="a-hero">
          <p className="si-title">{t('signin.line1')}<br />{rich('signin.line2', { server: <span className="serif">{t('signin.server')}</span> })}</p>
          <div className="placard">
            <div className="t">{t('signin.placardTitle')}</div>
            <div className="m">{t('signin.placardText')}</div>
            <div className="no"><span className="micro">{t('signin.deploy')}</span><b>{t('signin.sample')}</b></div>
            <div className="live">
              <Status tone={ok ? 'ok' : 'warn'} live={!ok}>{t(ok ? 'signin.healthy' : 'signin.deploying')}</Status>
              <span className="gl-p">
                {STEPS.map((s, i) => {
                  const st = i < k ? 'done' : i === k ? 'running' : ''
                  return (
                    <span key={s} style={{ display: 'contents' }}>
                      {i > 0 && <Icon name="caret-right" size={12} />}
                      <span className={`gl-c ${st}`}>
                        <span className="gi"><Icon name={st === 'done' ? 'check' : st === 'running' ? 'spinner' : 'dashed'} size={12} weight="bold" /></span>{s}
                      </span>
                    </span>
                  )
                })}
              </span>
            </div>
          </div>
        </div>
      </div>
      {canVideo && (
        <button type="button" className="a-toggle" onClick={toggle} aria-label={t(paused ? 'signin.play' : 'signin.pause')}>
          <Icon name={paused ? 'play' : 'pause'} size={12} weight="bold" />
        </button>
      )}
    </div>
  )
}

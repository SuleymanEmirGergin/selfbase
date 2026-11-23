import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent } from 'react'
import { Icon, Status } from './ui.tsx'
import { Brand } from './glyphs.tsx'

// Left half of the pages reachable without a session: sign-in direction A, "Malzeme" (sdd signin-v4.html?v=a).
// Self-contained so another direction can replace it without touching the forms. Wholly decorative and aria-hidden:
// the pipeline is sample content, never fed from the API, and shows no project data.

const STEPS = ['ensure', 'healthy', 'certificate', 'warm']
const STEP_MS = 1500
const HOLD_MS = 6500
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

export function SignInPanel() {
  const [reduce] = useState(reduced)
  const video = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [run, setRun] = useState({ cycle: 0, t: reduce ? STEPS.length * STEP_MS : 0 })

  // Autoplay can be refused (data saver, policy): then the still stays and nothing else happens.
  useEffect(() => { video.current?.play().catch(() => {}) }, [])
  useEffect(() => {
    if (reduce) return
    const id = setInterval(() => setRun((r) => (r.t + 100 >= STEPS.length * STEP_MS + HOLD_MS ? { cycle: r.cycle + 1, t: 0 } : { ...r, t: r.t + 100 })), 100)
    return () => clearInterval(id)
  }, [reduce])

  const k = Math.min(STEPS.length, Math.floor(run.t / STEP_MS))
  const ok = k >= STEPS.length
  // the pointer is a torch on the metal (hover devices only; the CSS hides it under a playing video)
  const torch = (e: PointerEvent<HTMLDivElement>) => {
    if (reduce || e.pointerType !== 'mouse') return
    const r = e.currentTarget.getBoundingClientRect()
    e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left + r.width * 0.04}px`)
    e.currentTarget.style.setProperty('--my', `${e.clientY - r.top + r.height * 0.04}px`)
  }

  return (
    <div className="si-left" aria-hidden="true">
      <div className="a-panel" onPointerMove={torch}>
        <div className={`a-art${playing ? ' has-vid' : ''}`}>
          <i />
          {!reduce && (
            <video ref={video} className="a-vid" muted loop playsInline preload="metadata" poster="/signin/art.webp" onPlaying={() => setPlaying(true)}>
              <source src="/signin/loop.mp4" type="video/mp4" />
              <source src="/signin/loop.webm" type="video/webm" />
            </video>
          )}
          {/* light passes across the metal once per finished step, a full pass when the sample deploy lands */}
          {!reduce && k > 0 && <i key={`${run.cycle}-${k}`} className="sheen go" style={{ '--so': ok ? 0.7 : 0.32, '--sd': ok ? '3.2s' : '2.2s' } as CSSProperties} />}
          <i className="torch" />
        </div>
        <Brand />
        <div className="a-hero">
          <p className="si-title">Verin senin.<br /><span className="serif">Sunucun</span> da.</p>
          <div className="placard">
            <div className="t">Eloksallı alüminyum, makro</div>
            <div className="m">Her dağıtım adımında ışık yüzeyden bir kez geçer.</div>
            <div className="no"><span className="micro">Dağıtım</span><b>örnek</b></div>
            <div className="live">
              <Status tone={ok ? 'ok' : 'warn'} live={!ok}>{ok ? 'Sağlıklı' : 'Dağıtılıyor'}</Status>
              <span className="gl-p">
                {STEPS.map((s, i) => {
                  const st = i < k ? 'done' : i === k ? 'running' : ''
                  return (
                    <span key={s} style={{ display: 'contents' }}>
                      {i > 0 && <Icon name="caret-right" size={10} weight="bold" />}
                      <span className={`gl-c ${st}`}>
                        <span className="gi"><Icon name={st === 'done' ? 'check' : st === 'running' ? 'spinner' : 'dashed'} size={10} weight="bold" /></span>{s}
                      </span>
                    </span>
                  )
                })}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

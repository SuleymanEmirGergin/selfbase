import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { Icon, Status } from './ui.tsx'
import { Brand } from './glyphs.tsx'
import { nf } from './lib/format.ts'

// Left half of the pages reachable without a session (v3 mockup). Self-contained so another sign-in direction can
// replace it without touching the forms. It shows no project data: the health card is a fixed illustration with
// sample labels, never fed from the API.

const RIBBONS: [string, number, number, number, number, number, number, number, number][] = [
  // x, width, blur, opacity, duration s, delay s, drift px, stop 1 %, stop 2 %
  ['3%', 38, 16, 0.5, 27, -3, 26, 26, 70], ['11%', 110, 44, 0.55, 34, -12, -30, 18, 64], ['24%', 22, 6, 0.7, 23, -8, 18, 34, 80],
  ['31%', 64, 22, 0.42, 31, -20, 34, 22, 66], ['44%', 140, 56, 0.5, 38, -5, -24, 30, 74], ['57%', 18, 5, 0.75, 21, -14, 16, 40, 82],
  ['64%', 78, 28, 0.5, 29, -9, -28, 20, 62], ['78%', 34, 12, 0.6, 25, -17, 22, 28, 76], ['86%', 120, 48, 0.45, 36, -24, -20, 24, 70],
  ['38%', 5, 1.5, 0.55, 24, -6, 40, 30, 68], ['71%', 8, 2.5, 0.45, 28, -15, -36, 24, 74],
]

const STEPS = ['ensure', 'healthy', 'certificate', 'warm']
const STEP_MS = 1100
const HOLD_MS = 3200
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** The sample pipeline ticks through its steps and starts over; under reduced motion it shows the finished state. */
function Glimpse() {
  const done = STEPS.length * STEP_MS
  const [t, setT] = useState(() => (reduced() ? done : 0))
  useEffect(() => {
    if (reduced()) return
    const id = setInterval(() => setT((x) => (x + 100 > done + HOLD_MS ? 0 : x + 100)), 100)
    return () => clearInterval(id)
  }, [])
  const k = Math.min(STEPS.length, Math.floor(t / STEP_MS))
  const ok = k >= STEPS.length
  return (
    <div className="glimpse" aria-hidden="true">
      <div className="gl">
        <div className="gl-h">
          <span className="avatar">Ö</span>
          <div><b>ornek-proje</b><small>örnek organizasyon · üretim</small></div>
          <Status tone={ok ? 'ok' : 'warn'} live={!ok}>{ok ? 'Sağlıklı' : 'Kuruluyor'}</Status>
        </div>
        <div className="gl-m">
          <div><span className="micro">Postgres</span><b>17</b></div>
          <div><span className="micro">Bellek</span><b>1,2 GB</b></div>
          <div><span className="micro">Boyut</span><b>small</b></div>
        </div>
        <div className="gl-p">
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
        </div>
        <div className="gl-f"><span>ÖRNEK · <b>kurulum adımları</b></span><span className="tnum">{nf(Math.min(t, done) / 1000, 1)} sn</span></div>
      </div>
    </div>
  )
}

export function SignInPanel() {
  return (
    <div className="si-left">
      <div className="si-panel">
        <div className="ribbons" aria-hidden="true">
          {RIBBONS.map(([x, w, b, o, d, dl, dx, s1, s2]) => (
            <i key={`${x}${w}`} style={{ '--x': x, '--w': `${w}px`, '--b': `${b}px`, '--o': o, '--d': `${d}s`, '--dl': `${dl}s`, '--dx': `${dx}px`, '--s1': `${s1}%`, '--s2': `${s2}%` } as CSSProperties} />
          ))}
        </div>
        <Brand />
        <div className="si-hero">
          <p className="si-title">Veriniz sizin.<br /><span className="serif">Sunucunuz</span> da.</p>
          <div className="si-stats">
            <div><span className="micro">İstemci</span><b>supabase-js</b></div>
            <div><span className="micro">Veritabanı</span><b>Postgres</b></div>
            <div><span className="micro">Sunucu</span><b>sizin</b></div>
          </div>
        </div>
      </div>
      <Glimpse />
    </div>
  )
}

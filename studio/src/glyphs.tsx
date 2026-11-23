import type { ReactNode } from 'react'

// The brand mark and the 7 service glyphs (24 grid, 1.5 stroke, round caps: the weight of Phosphor Regular).

type P = { size?: number; className?: string }
const svg = (children: ReactNode) => ({ size = 16, className }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className ?? 'icon'}>{children}</svg>
)

export const GLYPHS = {
  'g-postgres': svg(<><ellipse cx="11" cy="5.5" rx="7" ry="2.5" /><path d="M4 5.5v12c0 1.4 3.1 2.5 7 2.5 1.3 0 2.5-.1 3.5-.4" /><path d="M18 5.5V11" /><path d="M4 11.5c0 1.4 3.1 2.5 7 2.5" /><path d="M16 14.5c1.5-.6 3.5 0 3.5 2s-1.8 2.6-3 2.2" /></>),
  'g-rest': svg(<><path d="M8 4H7a2 2 0 0 0-2 2v3.5A2.5 2.5 0 0 1 2.5 12 2.5 2.5 0 0 1 5 14.5V18a2 2 0 0 0 2 2h1" /><path d="M16 4h1a2 2 0 0 1 2 2v3.5a2.5 2.5 0 0 0 2.5 2.5 2.5 2.5 0 0 0-2.5 2.5V18a2 2 0 0 1-2 2h-1" /><path d="M9.5 12h5M12.5 10l2 2-2 2" /></>),
  'g-auth': svg(<><path d="M12 3l7 2.8V11c0 4.6-3 8-7 10-4-2-7-5.4-7-10V5.8z" /><circle cx="12" cy="10.5" r="2" /><path d="M12 12.5V16" /></>),
  'g-realtime': svg(<><circle cx="12" cy="12" r="1.8" /><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.5 5.5a9.2 9.2 0 0 0 0 13M18.5 5.5a9.2 9.2 0 0 1 0 13" /></>),
  'g-storage': svg(<><path d="M4 7.5l1.6 11.2a2 2 0 0 0 2 1.8h8.8a2 2 0 0 0 2-1.8L20 7.5" /><ellipse cx="12" cy="7" rx="8" ry="2.8" /><path d="M9 13.5h6" /></>),
  'g-fn': svg(<><rect x="3.5" y="3.5" width="17" height="17" rx="5" /><path d="M9 7.5h1.4l4.6 9" /><path d="M12.3 11.4L9 16.5" /></>),
  'g-sites': svg(<><rect x="3" y="4" width="18" height="16" rx="3.5" /><path d="M3 8.5h18" /><path d="M10 16.5l4.5-4.5M10.5 12h4v4" /></>),
}

export const Logo = ({ size = 28 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="mark">
    <rect x="3" y="5" width="26" height="10" rx="5" fill="currentColor" opacity=".35" />
    <rect x="3" y="17" width="26" height="10" rx="5" fill="currentColor" />
    <circle cx="23.5" cy="22" r="2.6" fill="var(--accent-ink)" />
  </svg>
)

export const Brand = () => (
  <span className="brand"><Logo /><span>selfbase</span><span className="tag">STUDIO</span></span>
)

import { useCallback, useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import { onSignedOut, platform } from './api.ts'
import type { Me, OrgRef } from './api.ts'
import { Link, navigate, usePath } from './router.tsx'
import { ConfirmHost, Icon, Loading, ToastHost } from './ui.tsx'
import { AcceptInvite, ResetPassword, SignIn } from './auth.tsx'
import { Audit, Capacity, Members, Tokens } from './org/admin.tsx'
import { ImportProject, NewProject, Projects } from './org/projects.tsx'
import type { OrgProps } from './org/common.tsx'
import ProjectArea from './project/index.tsx'
import { clearProjectMemory } from './project/context.ts'

const TABS = [
  { id: '', label: 'Projeler', icon: 'folder', Screen: Projects },
  { id: 'members', label: 'Üyeler', icon: 'users', Screen: Members },
  { id: 'tokens', label: 'Erişim belirteçleri', icon: 'key', Screen: Tokens },
  { id: 'audit', label: 'Denetim kaydı', icon: 'file', Screen: Audit },
  { id: 'capacity', label: 'Kapasite', icon: 'table', Screen: Capacity },
] as const
const OUTSIDE_TABS = { new: NewProject, import: ImportProject } as const

/** Only same-origin targets are followed after sign-in (`/\evil.com` and the like resolve elsewhere and are dropped). */
const nextPath = () => {
  const n = new URLSearchParams(location.search).get('next')
  if (!n) return ''
  let u: URL
  try { u = new URL(n, location.origin) } catch { return '' } // `http://`, `//` and the like do not parse
  return u.origin === location.origin ? u.pathname + u.search + u.hash : ''
}
const homeOf = (me: Me) => (me.organizations[0] ? `/org/${me.organizations[0].slug}` : '/org')

function OrgShell({ me, org, tab, onSignOut }: { me: Me; org: OrgRef; tab: string; onSignOut: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const path = usePath()
  useEffect(() => setMenuOpen(false), [path])
  const props: OrgProps = { org, canManage: org.role === 'owner' || org.role === 'administrator', email: me.email }
  const Screen = (OUTSIDE_TABS as Record<string, ComponentType<OrgProps>>)[tab] ?? TABS.find((t) => t.id === tab)?.Screen ?? Projects
  const navTab = tab in OUTSIDE_TABS ? '' : tab

  return (
    <div className={`shell ${menuOpen ? 'menu-open' : ''}`}>
      <nav className="sidebar" aria-label="Ana menü">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">selfbase</span>
          <button className="icon-btn menu-toggle" aria-label="Menü" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
            <Icon name="menu" />
          </button>
        </div>
        <label className="org-switch field">
          <span>Organizasyon</span>
          <select value={org.slug} onChange={(e) => navigate(`/org/${e.target.value}${navTab ? `/${navTab}` : ''}`)}>
            {me.organizations.map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}
          </select>
        </label>
        <ul className="nav">
          {TABS.map((t) => (
            <li key={t.id}>
              <Link to={`/org/${org.slug}${t.id ? `/${t.id}` : ''}`} className={t.id === navTab ? 'active' : undefined} aria-current={t.id === navTab ? 'page' : undefined}>
                <Icon name={t.icon} />{t.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="nav-foot">
          <div className="who mono small" title={me.email}>{me.email}</div>
          <button className="nav-btn" onClick={onSignOut}><Icon name="logout" />Çıkış</button>
        </div>
      </nav>
      <main className="content">
        <Screen key={`${org.slug}/${tab}`} {...props} />
      </main>
    </div>
  )
}

function Routes({ me, signOut, reload }: { me: Me | null | undefined; signOut: () => void; reload: () => void }) {
  const path = usePath()
  const [first = '', second = '', third = ''] = path.split('/').filter(Boolean)

  // Redirects: no session → sign-in (remembering where to come back); a session on / or /sign-in → its home.
  useEffect(() => {
    if (me === undefined || first === 'invite' || first === 'reset-password') return
    if (me === null) {
      if (first !== 'sign-in') navigate(`/sign-in?next=${encodeURIComponent(path + location.search)}`, true)
    } else if (first === 'sign-in' || first === '') navigate(nextPath() || homeOf(me), true)
  }, [me, first, path])

  if (first === 'invite') return <AcceptInvite token={second} />
  if (first === 'reset-password') return <ResetPassword />
  if (me === undefined) return <div className="boot"><Loading /></div>
  if (me === null) return <SignIn onSignedIn={reload} />
  if (first === 'sign-in' || first === '') return <div className="boot"><Loading /></div>
  if (first === 'project') return <ProjectArea me={me} onSignOut={signOut} />

  const slug = first === 'org' ? second : first in OUTSIDE_TABS ? second : ''
  const tab = first === 'org' ? third : first
  const org = me.organizations.find((o) => o.slug === slug)
  if (!org) {
    return (
      <main className="login"><div className="login-card">
        <h1>Bulunamadı</h1>
        <p className="muted">{me.organizations.length ? 'Bu adreste erişebileceğiniz bir sayfa yok.' : 'Henüz bir organizasyona üye değilsiniz. Bir davet bağlantısı isteyin.'}</p>
        {me.organizations.length > 0 && <Link to={homeOf(me)} className="btn">Projelere dön</Link>}
        <button className="btn ghost" onClick={signOut}>Çıkış</button>
      </div></main>
    )
  }
  return <OrgShell me={me} org={org} tab={tab} onSignOut={signOut} />
}

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  const reload = useCallback(() => { platform.me().then(setMe, () => setMe(null)) }, [])

  useEffect(() => {
    onSignedOut(() => setMe(null))
    // A recovery link that lands on another path (the auth server's default redirect) belongs to the reset screen.
    if (location.hash.includes('type=recovery') && location.pathname !== '/reset-password') navigate(`/reset-password${location.hash}`, true)
    reload()
  }, [reload])

  // Every way out of a session (sign-out, a 401 that survived refresh, a failed /me) ends here: the next user on this
  // browser must not see this one's SQL query and rows.
  useEffect(() => { if (me === null) clearProjectMemory() }, [me])

  const signOut = useCallback(async () => {
    await platform.logout().catch(() => {})
    // An explicit sign-out keeps no `next`: the next account must not land on this one's page. Replacing the URL
    // without emitting keeps the redirect effect from adding it back; the render below reads the new path.
    history.replaceState(null, '', '/sign-in')
    setMe(null)
  }, [])

  return (
    <>
      <Routes me={me} signOut={signOut} reload={reload} />
      <ConfirmHost />
      <ToastHost />
    </>
  )
}

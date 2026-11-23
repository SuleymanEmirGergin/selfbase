import { useCallback, useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import { onSignedOut, platform } from './api.ts'
import type { Me, OrgRef } from './api.ts'
import { Link, navigate, usePath } from './router.tsx'
import { Dots, Icon } from './ui.tsx'
import { ConfirmHost, Loading, ToastHost } from './ui.tsx'
import { Shell } from './shell.tsx'
import { useLoad } from './org/common.tsx'
import { nf } from './lib/format.ts'
import { AcceptInvite, ResetPassword, SignIn } from './auth.tsx'
import { Audit, Capacity, Members, Tokens } from './org/admin.tsx'
import { ImportProject, NewProject, Projects } from './org/projects.tsx'
import type { OrgProps } from './org/common.tsx'
import ProjectArea from './project/index.tsx'
import { clearProjectMemory } from './project/context.ts'

const TABS = [
  { id: '', label: 'Projeler', icon: 'projects', Screen: Projects },
  { id: 'members', label: 'Üyeler', icon: 'users', Screen: Members },
  { id: 'tokens', label: 'Erişim belirteçleri', icon: 'key', Screen: Tokens },
  { id: 'audit', label: 'Denetim kaydı', icon: 'scroll', Screen: Audit },
  { id: 'capacity', label: 'Kapasite', icon: 'gauge', Screen: Capacity },
] as const
const OUTSIDE_TABS = { new: NewProject, import: ImportProject } as const

/**
 * Only same-origin targets are followed after sign-in (`/\evil.com` and the like resolve elsewhere and are dropped).
 * No backslash at all, and no path that starts `//` once resolved (`/.//evil.com`): history would read it as another host.
 */
const nextPath = () => {
  const n = new URLSearchParams(location.search).get('next')
  if (!n || n.includes('\\')) return ''
  let u: URL
  try { u = new URL(n, location.origin) } catch { return '' } // `http://`, `//` and the like do not parse
  return u.origin === location.origin && !u.pathname.startsWith('//') ? u.pathname + u.search + u.hash : ''
}
const homeOf = (me: Me) => (me.organizations[0] ? `/org/${me.organizations[0].slug}` : '/org')

/** Memory in use on the host, from the capacity endpoint; hidden when it cannot be read. */
function MemoryMeter() {
  const { data } = useLoad(platform.capacity, [])
  if (!data) return null
  const used = data.budget_mb - data.free_mb
  return (
    <div className="side-meter">
      <div className="row"><span>Bellek</span><b className="tnum">{nf(used / 1024, 1)} / {nf(data.budget_mb / 1024, 1)} GB</b></div>
      <Dots fill={used / data.budget_mb} n={20} />
    </div>
  )
}

function OrgShell({ me, org, tab, onSignOut }: { me: Me; org: OrgRef; tab: string; onSignOut: () => void }) {
  const props: OrgProps = { org, canManage: org.role === 'owner' || org.role === 'administrator', email: me.email }
  const sheet = (OUTSIDE_TABS as Record<string, ComponentType<OrgProps>>)[tab]
  const Screen = sheet ? Projects : TABS.find((t) => t.id === tab)?.Screen ?? Projects
  const Sheet = sheet
  const navTab = sheet ? '' : tab
  const base = `/org/${org.slug}`
  const current = TABS.find((t) => t.id === navTab) ?? TABS[0]

  return (
    <Shell
      email={me.email} onSignOut={onSignOut}
      switcher={
        <label className="switcher">
          <span className="avatar" aria-hidden="true">{org.name.slice(0, 1).toUpperCase()}</span>
          <span className="t"><b>{org.name}</b><span>organizasyon · {org.slug}</span></span>
          <select aria-label="Organizasyon" value={org.slug} onChange={(e) => navigate(`/org/${e.target.value}${navTab ? `/${navTab}` : ''}`)}>
            {me.organizations.map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}
          </select>
          <Icon name="caret-up-down" />
        </label>
      }
      nav={TABS.map((t) => ({ to: `${base}${t.id ? `/${t.id}` : ''}`, label: t.label, icon: t.icon, group: 'Organizasyon', active: t.id === navTab }))}
      crumbs={[{ label: org.name, to: base }, { label: current.label }]}
      commands={props.canManage ? [
        { label: 'Yeni proje oluştur', hint: org.name, icon: 'plus', group: 'Eylemler', run: () => navigate(`/new/${org.slug}`) },
        { label: 'Projeyi içe aktar', hint: 'yedekten', icon: 'download', group: 'Eylemler', run: () => navigate(`/import/${org.slug}`) },
      ] : []}
      loadCommands={() => platform.projects(org.slug).then((ps) => ps.map((p) => ({
        label: p.name, hint: p.ref, icon: 'database', group: 'Projeler', run: () => navigate(`/project/${p.ref}`),
      })))}
      foot={<MemoryMeter />}>
      <Screen key={`${org.slug}/${navTab}`} {...props} />
      {Sheet && <Sheet key={`${org.slug}/${tab}`} {...props} />}
    </Shell>
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

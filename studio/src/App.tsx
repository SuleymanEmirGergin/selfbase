import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import { onSignedOut, platform } from './api.ts'
import type { Me, OrgRef } from './api.ts'
import { Link, navigate, usePath } from './router.tsx'
import { Dots, Icon } from './ui.tsx'
import { ConfirmHost, Loading, ToastHost, flushUndo } from './ui.tsx'
import { Shell } from './shell.tsx'
import { useLoad } from './org/common.tsx'
import { nf, t, upper, useLocale } from './i18n/index.ts'
import { AcceptInvite, AuthCard, ResetPassword, SignIn } from './auth.tsx'
import { Audit, Capacity, Members, Tokens } from './org/admin.tsx'
import { ImportProject, NewProject, Projects } from './org/projects.tsx'
import type { OrgProps } from './org/common.tsx'
import ProjectArea from './project/index.tsx'
import { clearProjectMemory } from './project/context.ts'

const TABS = [
  { id: '', label: 'nav.projects', icon: 'projects', Screen: Projects },
  { id: 'members', label: 'nav.members', icon: 'users', Screen: Members },
  { id: 'tokens', label: 'nav.tokens', icon: 'key', Screen: Tokens },
  { id: 'audit', label: 'nav.audit', icon: 'scroll', Screen: Audit },
  { id: 'capacity', label: 'nav.capacity', icon: 'gauge', Screen: Capacity },
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
      <div className="row"><span>{t('shell.memory')}</span><b className="tnum">{nf(used / 1024, 1)} / {nf(data.budget_mb / 1024, 1)} GiB</b></div>
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
          <span className="avatar" aria-hidden="true">{upper(org.name.slice(0, 1))}</span>
          <span className="t"><b>{org.name}</b><span>{t('org.switcherSub', { slug: org.slug })}</span></span>
          <select aria-label={t('org.switcher')} value={org.slug} onChange={(e) => navigate(`/org/${e.target.value}${navTab ? `/${navTab}` : ''}`)}>
            {me.organizations.map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}
          </select>
          <Icon name="caret-up-down" />
        </label>
      }
      nav={TABS.map((x) => ({ to: `${base}${x.id ? `/${x.id}` : ''}`, label: t(x.label), icon: x.icon, group: t('nav.groupOrg'), active: x.id === navTab }))}
      crumbs={[{ label: org.name, to: base }, { label: t(current.label) }]}
      commands={props.canManage ? [
        { label: t('cmd.newProject'), hint: org.name, icon: 'plus', group: t('palette.groupActions'), run: () => navigate(`/new/${org.slug}`) },
        { label: t('cmd.import'), hint: t('cmd.importHint'), icon: 'download', group: t('palette.groupActions'), run: () => navigate(`/import/${org.slug}`) },
      ] : []}
      loadCommands={() => platform.projects(org.slug).then((ps) => ps.map((p) => ({
        label: p.name, hint: p.ref, icon: 'database', group: t('nav.projects'), run: () => navigate(`/project/${p.ref}`),
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
      <AuthCard title={t('notFound.title')} lead={t(me.organizations.length ? 'notFound.noAccess' : 'notFound.noOrg')}>
        {me.organizations.length > 0 && <Link to={homeOf(me)} className="btn primary lg block">{t('notFound.back')}</Link>}
        <button type="button" className="btn ghost" onClick={signOut}>{t('common.signOut')}</button>
      </AuthCard>
    )
  }
  return <OrgShell me={me} org={org} tab={tab} onSignOut={signOut} />
}

export default function App() {
  useLocale() // a locale switch re-renders the whole tree, so every t() reads the new catalogue
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

  // one sign-out at a time: a second click while the first waits for a delete must not log out early
  const leaving = useRef(false)
  const signOut = useCallback(async () => {
    if (leaving.current) return
    leaving.current = true
    // a delete still in its undo window, or already sent, must be answered before logout ends its session
    await Promise.race([flushUndo(), new Promise((r) => setTimeout(r, 3000))])
    await platform.logout().catch(() => {})
    // An explicit sign-out keeps no `next`: the next account must not land on this one's page. Replacing the URL
    // without emitting keeps the redirect effect from adding it back; the render below reads the new path.
    history.replaceState(null, '', '/sign-in')
    setMe(null)
    leaving.current = false
  }, [])

  return (
    <>
      <Routes me={me} signOut={signOut} reload={reload} />
      <ConfirmHost />
      <ToastHost />
    </>
  )
}

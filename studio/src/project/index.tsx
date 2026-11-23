import { Component, Suspense, lazy, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { ComponentType } from 'react'
import { platform, projectAdmin } from '../api.ts'
import type { Me } from '../api.ts'
import { Link, navigate, usePath } from '../router.tsx'
import { Shell } from '../shell.tsx'
import { ErrorBox, Icon, Loading, Status } from '../ui.tsx'
import { statusLabel, statusTone, useLoad } from '../org/common.tsx'
import { t, upper } from '../i18n/index.ts'
import type { Key } from '../i18n/index.ts'
import { Ctx, can, projectRole } from './context.ts'
import type { Action, ProjectCtx } from './context.ts'
import { Paused } from './parts.tsx'
import Home from './Home.tsx'
import Logs from './Logs.tsx'
import Settings from './Settings.tsx'
import Tables from './Tables.tsx'
import Users from './Users.tsx'
import Files from './Files.tsx'
import Policies from './Policies.tsx'
import Sites from './Sites.tsx'

// CodeMirror is most of the bundle; it loads with the SQL screen only.
const Sql = lazy(() => import('./Sql.tsx'))

/** A chunk that fails to load (a redeploy replaced it) shows a reload hint instead of unmounting the app. */
class ChunkBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="error-box" role="alert">
        <div>{t('project.chunkFailed')}</div>
        <button className="btn sm" onClick={() => location.reload()}>{t('project.reload')}</button>
      </div>
    )
  }
}

type Screen = { path: string; label: Key; icon: string; group?: Key; Screen: ComponentType; needs?: Action; data?: true; preview?: true }
// `data` screens talk to the project's own services, so they are unavailable unless it is ACTIVE_* (control forwards
// admin calls for an unhealthy project too: SQL is most needed then).
const SCREENS: Screen[] = [
  { path: 'home', label: 'nav.home', icon: 'home', Screen: Home },
  { path: 'editor', label: 'nav.tables', group: 'nav.groupDb', icon: 'table', Screen: Tables, data: true },
  { path: 'sql', label: 'nav.sql', group: 'nav.groupDb', icon: 'terminal', Screen: Sql, needs: 'project.sql', data: true },
  { path: 'policies', label: 'nav.rls', group: 'nav.groupDb', icon: 'shield', Screen: Policies, data: true },
  { path: 'auth/users', label: 'nav.users', group: 'nav.groupApp', icon: 'g-auth', Screen: Users, data: true },
  { path: 'storage', label: 'nav.files', group: 'nav.groupApp', icon: 'g-storage', Screen: Files, data: true },
  { path: 'sites', label: 'nav.sites', group: 'nav.groupApp', icon: 'g-sites', Screen: Sites, preview: true },
  { path: 'logs', label: 'nav.logs', group: 'nav.groupApp', icon: 'pulse', Screen: Logs },
  { path: 'settings', label: 'nav.settings', group: 'nav.groupApp', icon: 'gear', Screen: Settings },
]

export default function ProjectArea({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const path = usePath()
  const [, , ref = '', ...rest] = path.split('/')
  const sub = rest.join('/') || 'home'

  const { data: project, error, reload } = useLoad(() => platform.project(ref), [ref])
  const ctx = useMemo<ProjectCtx | null>(() => {
    if (!project || project.ref !== ref) return null
    const org = me.organizations.find((o) => o.id === project.organization_id)
    const role = projectRole(org, ref)
    return { ref, project, org, api: projectAdmin(ref), can: (a) => can(role, a), reload }
  }, [project, ref, me, reload])

  if (error) {
    return (
      <main className="login"><div className="login-card">
        <h1>{t('project.openFailed')}</h1>
        <ErrorBox message={error} onRetry={reload} />
        <Link to="/" className="btn">{t('notFound.back')}</Link>
      </div></main>
    )
  }
  if (!ctx) return <div className="boot"><Loading /></div>

  const paused = !ctx.project.status.startsWith('ACTIVE_')
  const visible = SCREENS.filter((s) => (!s.needs || ctx.can(s.needs)) && !(paused && s.data))
  const current = SCREENS.find((s) => s.path === sub) ?? SCREENS[0]
  const allowed = !current.needs || ctx.can(current.needs)
  const Screen = current.Screen

  const base = `/project/${ref}`
  const orgBase = ctx.org ? `/org/${ctx.org.slug}` : '/'
  return (
    <Ctx.Provider value={ctx}>
      <Shell
        email={me.email} onSignOut={onSignOut}
        switcher={
          <Link to={orgBase} className="switcher" title={t('notFound.back')}>
            <span className="avatar" aria-hidden="true">{upper(ctx.project.name.slice(0, 1))}</span>
            <span className="t"><b>{ctx.project.name}</b><span>{ref}{ctx.org ? ` · ${ctx.org.name}` : ''}</span></span>
            <Status tone={statusTone(ctx.project.status)} title={statusLabel(ctx.project.status)}><span className="sr-only">{statusLabel(ctx.project.status)}</span></Status>
            <Icon name="caret-up-down" />
          </Link>
        }
        nav={visible.map((s) => ({ to: `${base}/${s.path}`, label: t(s.label), icon: s.icon, group: s.group && t(s.group), active: s === current, preview: s.preview }))}
        crumbs={[...(ctx.org ? [{ label: ctx.org.name, to: orgBase }] : []), { label: ctx.project.name, to: `${base}/home` }, { label: t(current.label) }]}
        commands={[{ label: t('notFound.back'), hint: ctx.org?.name, icon: 'projects', group: t('palette.groupNav'), run: () => navigate(orgBase) }]}>
        {!allowed ? <div className="state">{t('project.noAccess')}</div>
          : paused && current.data ? <Paused />
          : <ChunkBoundary key={`${ref}/${current.path}`}><Suspense fallback={<Loading />}><Screen /></Suspense></ChunkBoundary>}
      </Shell>
    </Ctx.Provider>
  )
}

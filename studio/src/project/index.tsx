import { Component, Suspense, lazy, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ComponentType } from 'react'
import { platform, projectAdmin } from '../api.ts'
import type { Me } from '../api.ts'
import { Link, usePath } from '../router.tsx'
import { ErrorBox, Icon, Loading } from '../ui.tsx'
import { StatusBadge, useLoad } from '../org/common.tsx'
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
import './project.css'

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
        <div>Bu ekran yüklenemedi; Studio güncellenmiş olabilir. Sayfayı yenileyin.</div>
        <button className="btn sm" onClick={() => location.reload()}>Sayfayı yenileyin</button>
      </div>
    )
  }
}

type Screen = { path: string; label: string; icon: string; group?: string; Screen: ComponentType; needs?: Action; data?: true }
// `data` screens talk to the project's own services, so they are unavailable unless it is ACTIVE_HEALTHY.
const SCREENS: Screen[] = [
  { path: 'home', label: 'Ana sayfa', icon: 'folder', Screen: Home },
  { path: 'editor', label: 'Tablolar', icon: 'table', Screen: Tables, data: true },
  { path: 'sql', label: 'SQL', icon: 'terminal', Screen: Sql, needs: 'project.sql', data: true },
  { path: 'auth/users', label: 'Kullanıcılar', group: 'Kimlik doğrulama', icon: 'users', Screen: Users, data: true },
  { path: 'storage', label: 'Dosyalar', group: 'Depolama', icon: 'file', Screen: Files, data: true },
  { path: 'policies', label: 'RLS', group: 'Veritabanı', icon: 'shield', Screen: Policies, data: true },
  { path: 'logs', label: 'Günlükler', icon: 'file', Screen: Logs },
  { path: 'settings', label: 'Ayarlar', icon: 'key', Screen: Settings },
]

export default function ProjectArea({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const path = usePath()
  const [, , ref = '', ...rest] = path.split('/')
  const sub = rest.join('/') || 'home'
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => setMenuOpen(false), [path])

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
        <h1>Proje açılamadı</h1>
        <ErrorBox message={error} onRetry={reload} />
        <Link to="/" className="btn">Projelere dön</Link>
      </div></main>
    )
  }
  if (!ctx) return <div className="boot"><Loading /></div>

  const paused = ctx.project.status !== 'ACTIVE_HEALTHY'
  const visible = SCREENS.filter((s) => (!s.needs || ctx.can(s.needs)) && !(paused && s.data))
  const current = SCREENS.find((s) => s.path === sub) ?? SCREENS[0]
  const allowed = !current.needs || ctx.can(current.needs)
  const Screen = current.Screen

  return (
    <Ctx.Provider value={ctx}>
      <div className={`shell ${menuOpen ? 'menu-open' : ''}`}>
        <nav className="sidebar" aria-label="Ana menü">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-name">selfbase</span>
            <button className="icon-btn menu-toggle" aria-label="Menü" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
              <Icon name="menu" />
            </button>
          </div>
          <div className="project-head">
            {ctx.org && <Link to={`/org/${ctx.org.slug}`} className="muted small">← {ctx.org.name}</Link>}
            <div className="cell-main project-title" title={ctx.project.name}>{ctx.project.name}</div>
            <StatusBadge status={ctx.project.status} />
          </div>
          <ul className="nav">
            {visible.map((s, i) => (
              <li key={s.path}>
                {s.group && s.group !== visible[i - 1]?.group && <div className="nav-group">{s.group}</div>}
                {!s.group && visible[i - 1]?.group && <div className="nav-sep" />}
                <Link to={`/project/${ref}/${s.path}`} className={s === current ? 'active' : undefined} aria-current={s === current ? 'page' : undefined}>
                  <Icon name={s.icon} />{s.label}
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
          {!allowed ? <div className="state">Bu ekran için yetkiniz yok.</div>
            : paused && current.data ? <Paused />
            : <ChunkBoundary key={`${ref}/${current.path}`}><Suspense fallback={<Loading />}><Screen /></Suspense></ChunkBoundary>}
        </main>
      </div>
    </Ctx.Provider>
  )
}

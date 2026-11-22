import { useCallback, useEffect, useState } from 'react'
import { api, onUnauthorized } from './api.ts'
import { ConfirmHost, Icon, Loading, ToastHost } from './ui.tsx'
import Login from './pages/Login.tsx'
import Tables from './pages/Tables.tsx'
import Policies from './pages/Policies.tsx'
import Sql from './pages/Sql.tsx'
import Users from './pages/Users.tsx'
import Files from './pages/Files.tsx'

const NAV = [
  { id: 'tables', label: 'Tablolar', icon: 'table', Page: Tables },
  { id: 'rls', label: 'RLS', icon: 'shield', Page: Policies },
  { id: 'sql', label: 'SQL', icon: 'terminal', Page: Sql },
  { id: 'users', label: 'Kullanıcılar', icon: 'users', Page: Users },
  { id: 'files', label: 'Dosyalar', icon: 'folder', Page: Files },
] as const

// shortcut: hash routing with one segment per page, no router library; add one if pages need nested URLs
const route = () => NAV.find((n) => location.hash === `#/${n.id}`) ?? NAV[0]

export default function App() {
  const [me, setMe] = useState<{ email: string } | null | undefined>(undefined)
  const [page, setPage] = useState(route)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    onUnauthorized(() => setMe(null))
    api.me().then(setMe, () => setMe(null))
    const onHash = () => { setPage(route()); setMenuOpen(false) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const logout = useCallback(async () => {
    await api.logout().catch(() => {})
    setMe(null)
  }, [])

  if (me === undefined) return <div className="boot"><Loading /></div>
  if (me === null) return <Login onLogin={setMe} />

  const { Page } = page
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
        <ul className="nav">
          {NAV.map((n) => (
            <li key={n.id}>
              <a href={`#/${n.id}`} className={n.id === page.id ? 'active' : undefined} aria-current={n.id === page.id ? 'page' : undefined}>
                <Icon name={n.icon} />{n.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="nav-foot">
          <div className="who mono small" title={me.email}>{me.email}</div>
          <button className="nav-btn" onClick={logout}><Icon name="logout" />Çıkış</button>
        </div>
      </nav>
      <main className="content">
        <Page key={page.id} />
      </main>
      <ConfirmHost />
      <ToastHost />
    </div>
  )
}

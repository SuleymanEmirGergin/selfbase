import { Link, usePath } from '../router.tsx'

// Placeholder for /project/:ref/*; Task 16 replaces it with the project screens.
export default function ProjectArea() {
  const ref = usePath().split('/')[2] ?? ''
  return (
    <main className="login">
      <div className="login-card">
        <h1>Proje <span className="mono">{ref}</span></h1>
        <p className="muted">Proje ekranları bir sonraki adımda geliyor.</p>
        <Link to="/" className="btn">Projelere dön</Link>
      </div>
    </main>
  )
}

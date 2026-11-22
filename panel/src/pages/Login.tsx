import { useState } from 'react'
import type { FormEvent } from 'react'
import { api, errMsg } from '../api.ts'

export default function Login({ onLogin }: { onLogin: (me: { email: string }) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      onLogin(await api.login(email, password))
    } catch (err) {
      setError(errMsg(err) === 'invalid login' ? 'E-posta ya da parola hatalı.' : errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand login-brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">selfbase</span>
        </div>
        <h1>Yönetim paneli</h1>
        <p className="muted">Devam etmek için yönetici hesabınızla giriş yapın.</p>
        <label className="field">
          <span>E-posta</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>Parola</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="error-box" role="alert">{error}</div>}
        <button className="btn primary block" disabled={busy}>{busy ? 'Giriş yapılıyor…' : 'Giriş yap'}</button>
      </form>
    </div>
  )
}

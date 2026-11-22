import { useState } from 'react'
import type { FormEvent } from 'react'
import { ApiError, api, errMsg } from '../api.ts'

// core/src/admin/session.ts answers a disabled login (no PANEL_ADMIN_* set) with the same 401 as a wrong password,
// on purpose, so the 401 text names both causes.
const loginError = (err: unknown) => {
  const status = err instanceof ApiError ? err.status : 0
  if (status === 401) return 'E-posta ya da parola hatalı. Sunucuda PANEL_ADMIN_EMAIL ve PANEL_ADMIN_PASSWORD_HASH ayarlı değilse panel girişi kapalıdır.'
  if (status === 429) return 'Çok fazla hatalı deneme. 15 dakika bekleyip tekrar deneyin.'
  if (status === 403) return 'İstek reddedildi: panele yalnızca kendi adresinden giriş yapılabilir.'
  return errMsg(err)
}

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
      setError(loginError(err))
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

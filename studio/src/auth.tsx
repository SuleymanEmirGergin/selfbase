import { useEffect, useState } from 'react'
import type { FormEvent, InputHTMLAttributes, ReactNode } from 'react'
import { ApiError, errMsg, platform } from './api.ts'
import type { Me } from './api.ts'
import { Link, navigate } from './router.tsx'

// Sign-in, invitation and password reset: the screens reachable without a session.

const signInError = (err: unknown) => {
  const status = err instanceof ApiError ? err.status : 0
  if (status === 400 || status === 401) return 'E-posta ya da parola hatalı.'
  if (status === 429) return 'Çok fazla hatalı deneme. Biraz bekleyip tekrar deneyin.'
  if (status === 403) return 'İstek reddedildi: Studio’ya yalnızca kendi adresinden giriş yapılabilir.'
  return errMsg(err)
}

function Card({ title, lead, children, onSubmit }: { title: string; lead?: ReactNode; children: ReactNode; onSubmit?: (e: FormEvent) => void }) {
  return (
    <main className="login">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="brand login-brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">selfbase</span>
        </div>
        <h1>{title}</h1>
        {lead && <p className="muted">{lead}</p>}
        {children}
      </form>
    </main>
  )
}

/** Runs a submit with busy/error state; `fail` turns an error into the text shown. */
function useSubmit(run: () => Promise<void>, fail: (e: unknown) => string = errMsg) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try { await run() } catch (err) { setError(fail(err)) } finally { setBusy(false) }
  }
  return { busy, error, submit }
}

const Field = ({ label, ...input }: { label: string } & InputHTMLAttributes<HTMLInputElement>) => (
  <label className="field"><span>{label}</span><input required {...input} /></label>
)

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const { busy, error, submit } = useSubmit(async () => { await platform.login(email, password); onSignedIn() }, signInError)
  const accepted = new URLSearchParams(location.search).has('accepted')
  return (
    <Card title="Studio’ya giriş" lead="Hesabınızla giriş yapın." onSubmit={submit}>
      {accepted && <div className="note" role="status">Davet kabul edildi. Şimdi giriş yapabilirsiniz.</div>}
      <Field label="E-posta" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      <Field label="Parola" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <div className="error-box" role="alert">{error}</div>}
      <button className="btn primary block" disabled={busy}>{busy ? 'Giriş yapılıyor…' : 'Giriş yap'}</button>
      <Link to="/reset-password" className="muted small">Parolamı unuttum</Link>
    </Card>
  )
}

function NewPasswordCard({ title, label, onSave }: { title: string; label: string; onSave: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const { busy, error, submit } = useSubmit(async () => {
    if (password !== again) throw new Error('Parolalar aynı değil.')
    await onSave(password)
  })
  return (
    <Card title={title} lead="Hesabınız için bir parola belirleyin." onSubmit={submit}>
      <Field label="Yeni parola" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      <Field label="Yeni parola (tekrar)" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      {error && <div className="error-box" role="alert">{error}</div>}
      <button className="btn primary block" disabled={busy}>{label}</button>
    </Card>
  )
}

/**
 * A new address sets its password here. An address that already has an account cannot (control answers
 * account_exists): its owner signs in first, comes back here and accepts with the token only.
 */
export function AcceptInvite({ token }: { token: string }) {
  // undefined: still asking whether there is a session
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  const [hasAccount, setHasAccount] = useState(false)
  useEffect(() => { platform.me().then(setMe, () => setMe(null)) }, [])
  const signedInAccept = useSubmit(async () => {
    await platform.acceptInvitation(token)
    location.assign('/') // a full reload, so the new organization is in the session's list
  })
  const signInLink = `/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`

  if (me === undefined) return <Card title="Daveti kabul et">{null}</Card>
  if (me) {
    return (
      <Card title="Daveti kabul et" lead={<><strong>{me.email}</strong> olarak giriş yaptınız. Davet bu hesaba eklenecek.</>} onSubmit={signedInAccept.submit}>
        {signedInAccept.error && <div className="error-box" role="alert">{signedInAccept.error}</div>}
        <button className="btn primary block" disabled={signedInAccept.busy}>Daveti kabul et</button>
      </Card>
    )
  }
  if (hasAccount) {
    return (
      <Card title="Daveti kabul et">
        <div className="note" role="status">Bu adresin zaten bir hesabı var. Önce giriş yapın.</div>
        <Link to={signInLink} className="btn primary block">Giriş yap</Link>
      </Card>
    )
  }
  return (
    <NewPasswordCard title="Daveti kabul et" label="Daveti kabul et" onSave={async (password) => {
      try {
        await platform.acceptInvitation(token, password)
      } catch (err) {
        if (err instanceof ApiError && err.code === 'account_exists') return setHasAccount(true)
        throw err
      }
      navigate('/sign-in?accepted=1', true)
    }} />
  )
}

export function ResetPassword() {
  // A recovery link ends here with the session in the fragment (GoTrue's implicit flow); it never reaches a server.
  const hash = new URLSearchParams(location.hash.slice(1))
  const accessToken = hash.get('type') === 'recovery' ? hash.get('access_token') : null
  const [email, setEmail] = useState('')
  const [done, setDone] = useState('')
  const recover = useSubmit(async () => { await platform.recover(email.trim()); setDone('sent') })

  if (done === 'saved') return <Card title="Parola değişti" lead={<>Yeni parolanızla <Link to="/sign-in">giriş yapın</Link>.</>}>{null}</Card>
  if (accessToken) {
    return (
      <NewPasswordCard title="Yeni parola" label="Parolayı kaydet" onSave={async (password) => {
        await platform.setPassword(accessToken, password)
        history.replaceState(null, '', location.pathname) // drop the token from the address bar
        setDone('saved')
      }} />
    )
  }
  return (
    <Card title="Parolayı sıfırla" onSubmit={recover.submit}
      lead={done ? 'Bu adres kayıtlıysa sıfırlama bağlantısı gönderildi.' : 'Hesabınızın e-posta adresini yazın; sıfırlama bağlantısı gönderilir.'}>
      {hash.get('error_description') && <div className="error-box" role="alert">{hash.get('error_description')}</div>}
      <Field label="E-posta" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      {recover.error && <div className="error-box" role="alert">{recover.error}</div>}
      <button className="btn primary block" disabled={recover.busy}>Bağlantı gönder</button>
      <Link to="/sign-in" className="muted small">Girişe dön</Link>
    </Card>
  )
}

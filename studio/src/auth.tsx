import { useEffect, useId, useState } from 'react'
import type { FormEvent, InputHTMLAttributes, ReactNode } from 'react'
import { ApiError, errMsg, platform } from './api.ts'
import type { Me } from './api.ts'
import { Link, navigate } from './router.tsx'
import { Icon } from './ui.tsx'
import { Brand } from './glyphs.tsx'
import { SignInPanel } from './SignInPanel.tsx'

// Sign-in, invitation and password reset: the screens reachable without a session.

const signInError = (err: unknown) => {
  const status = err instanceof ApiError ? err.status : 0
  if (status === 400 || status === 401) return 'E-posta ya da şifre hatalı.'
  if (status === 429) return 'Çok fazla hatalı deneme. Biraz bekleyip tekrar deneyin.'
  if (status === 403) return 'İstek reddedildi: Studio’ya yalnızca kendi adresinden giriş yapılabilir.'
  return errMsg(err)
}

/** The split page of the v3 mockup: the illustrated panel on the left, the form straight on the page. */
export function AuthCard({ title, lead, children, onSubmit }: { title: string; lead?: ReactNode; children: ReactNode; onSubmit?: (e: FormEvent) => void }) {
  return (
    <main className="login">
      <SignInPanel />
      <div className="si-right">
        <form className="si-form" onSubmit={onSubmit}>
          <Brand />
          <h1>{title}</h1>
          {lead && <p className="sub">{lead}</p>}
          {children}
          <div className="si-foot"><span>Davetle mi geldiniz? E-postadaki bağlantıyı açın.</span><span className="mono">{location.host}</span></div>
        </form>
      </div>
    </main>
  )
}
const Card = AuthCard

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

/** A pill input with its icon; a password field can show its characters. `extra` sits on the label row (a link). */
function Field({ label, extra, type, ...input }: { label: string; extra?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId()
  const [plain, setPlain] = useState(false)
  return (
    <div className="field">
      <div className="lbl"><label htmlFor={id}>{label}</label>{extra}</div>
      <div className="input">
        <Icon name={type === 'password' ? 'lock' : 'mail'} />
        <input id={id} required type={type === 'password' && plain ? 'text' : type} {...input} />
        {type === 'password' && (
          <button type="button" className="icon-btn sm" aria-pressed={plain} onClick={() => setPlain((v) => !v)}
            aria-label={plain ? 'Karakterleri gizle' : 'Karakterleri göster'} title={plain ? 'Karakterleri gizle' : 'Karakterleri göster'}>
            <Icon name={plain ? 'eye-slash' : 'eye'} />
          </button>
        )}
      </div>
    </div>
  )
}

const Submit = ({ busy, children }: { busy?: boolean; children: ReactNode }) => (
  <button className="btn primary lg block" disabled={busy}>{children}<span className="ic"><Icon name="arrow-right" size={14} weight="bold" /></span></button>
)

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const { busy, error, submit } = useSubmit(async () => { await platform.login(email, password); onSignedIn() }, signInError)
  const accepted = new URLSearchParams(location.search).has('accepted')
  return (
    <Card title="Tekrar hoş geldiniz" lead="Studio’ya devam etmek için giriş yapın." onSubmit={submit}>
      {accepted && <div className="note" role="status">Davet kabul edildi. Şimdi giriş yapabilirsiniz.</div>}
      <Field label="E-posta" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      <Field label="Şifre" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
        extra={<Link to="/reset-password">Şifremi unuttum</Link>} />
      {error && <div className="error-box" role="alert">{error}</div>}
      <Submit busy={busy}>{busy ? 'Giriş yapılıyor…' : 'Giriş yap'}</Submit>
    </Card>
  )
}

function NewPasswordCard({ title, label, onSave }: { title: string; label: string; onSave: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const { busy, error, submit } = useSubmit(async () => {
    if (password !== again) throw new Error('Şifreler aynı değil.')
    await onSave(password)
  })
  return (
    <Card title={title} lead="Hesabınız için bir şifre belirleyin." onSubmit={submit}>
      <Field label="Yeni şifre" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      <Field label="Yeni şifre (tekrar)" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      {error && <div className="error-box" role="alert">{error}</div>}
      <Submit busy={busy}>{label}</Submit>
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
  const [otherAccount, setOtherAccount] = useState(false)
  useEffect(() => { platform.me().then(setMe, () => setMe(null)) }, [])
  const signedInAccept = useSubmit(async () => {
    try {
      await platform.acceptInvitation(token)
    } catch (err) {
      // 403: the invitation is for another account; 422: for a new address (it needs a password, so no session)
      if (err instanceof ApiError && (err.status === 403 || err.status === 422)) return setOtherAccount(true)
      throw err
    }
    location.assign('/') // a full reload, so the new organization is in the session's list
  })
  const signOutHere = async () => {
    await platform.logout().catch(() => {})
    setOtherAccount(false)
    setMe(null) // back on this invitation, signed out
  }
  const signInLink = `/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`

  if (me === undefined) return <Card title="Daveti kabul et">{null}</Card>
  if (me && otherAccount) {
    return (
      <Card title="Daveti kabul et">
        <div className="note" role="status">
          Bu davet başka bir e-posta adresine gönderilmiş; <strong>{me.email}</strong> hesabıyla kabul edilemez. Çıkış yapıp davetin
          gönderildiği adresle devam edin.
        </div>
        <button type="button" className="btn primary lg block" onClick={signOutHere}>Başka bir hesapla devam et</button>
      </Card>
    )
  }
  if (me) {
    return (
      <Card title="Daveti kabul et" lead={<><strong>{me.email}</strong> olarak giriş yaptınız. Davet bu hesaba eklenecek.</>} onSubmit={signedInAccept.submit}>
        {signedInAccept.error && <div className="error-box" role="alert">{signedInAccept.error}</div>}
        <Submit busy={signedInAccept.busy}>Daveti kabul et</Submit>
      </Card>
    )
  }
  if (hasAccount) {
    return (
      <Card title="Daveti kabul et">
        <div className="note" role="status">Bu adresin zaten bir hesabı var. Önce giriş yapın.</div>
        <Link to={signInLink} className="btn primary lg block">Giriş yap</Link>
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
  // Read once, then stripped from the address bar (history, copy-paste) right away.
  const [hash] = useState(() => new URLSearchParams(location.hash.slice(1)))
  useEffect(() => { if (location.hash) history.replaceState(null, '', location.pathname + location.search) }, [])
  const accessToken = hash.get('type') === 'recovery' ? hash.get('access_token') : null
  const [email, setEmail] = useState('')
  const [done, setDone] = useState('')
  const recover = useSubmit(async () => { await platform.recover(email.trim()); setDone('sent') })

  if (done === 'saved') return <Card title="Şifre değişti" lead={<>Yeni şifrenizle <Link to="/sign-in">giriş yapın</Link>.</>}>{null}</Card>
  if (accessToken) {
    return (
      <NewPasswordCard title="Yeni şifre" label="Şifreyi kaydet" onSave={async (password) => {
        await platform.setPassword(accessToken, password)
        setDone('saved')
      }} />
    )
  }
  return (
    <Card title="Şifreyi sıfırla" onSubmit={recover.submit}
      lead={done ? 'Bu adres kayıtlıysa sıfırlama bağlantısı gönderildi.' : 'Hesabınızın e-posta adresini yazın; sıfırlama bağlantısı gönderilir.'}>
      {/* the fragment's own error text is attacker-controllable, so only a fixed message is shown */}
      {(hash.has('error') || hash.has('error_description')) && (
        <div className="error-box" role="alert">Bağlantı geçersiz ya da süresi dolmuş. Yeni bir sıfırlama bağlantısı isteyin.</div>
      )}
      <Field label="E-posta" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      {recover.error && <div className="error-box" role="alert">{recover.error}</div>}
      <Submit busy={recover.busy}>Bağlantı gönder</Submit>
      <Link to="/sign-in" className="small">Girişe dön</Link>
    </Card>
  )
}

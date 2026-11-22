// The system being replaced used the default English templates (docs/auth-settings.md), so these are
// plain Turkish ones with the same variables: {{ .ConfirmationURL }}, {{ .Email }}, {{ .SiteURL }}.
export type MailKind = 'signup' | 'recovery' | 'magiclink' | 'email_change'

const button = '<p><a href="{{ .ConfirmationURL }}">{{ label }}</a></p>'
const footer = '<p>Bu isteği siz yapmadıysanız bu e-postayı yok sayabilirsiniz.</p>'

const templates: Record<MailKind, { subject: string; html: string }> = {
  signup: {
    subject: 'E-posta adresinizi doğrulayın',
    html: `<h2>Kaydınızı tamamlayın</h2><p>{{ .Email }} adresiyle {{ .SiteURL }} için kayıt oldunuz. Adresinizi doğrulamak için bağlantıya tıklayın:</p>${button.replace('{{ label }}', 'E-postamı doğrula')}${footer}`,
  },
  recovery: {
    subject: 'Şifrenizi sıfırlayın',
    html: `<h2>Şifre sıfırlama</h2><p>{{ .Email }} hesabının şifresini sıfırlamak için bağlantıya tıklayın:</p>${button.replace('{{ label }}', 'Şifremi sıfırla')}${footer}`,
  },
  magiclink: {
    subject: 'Giriş bağlantınız',
    html: `<h2>Giriş bağlantısı</h2><p>{{ .Email }} olarak {{ .SiteURL }} sitesine giriş yapmak için bağlantıya tıklayın:</p>${button.replace('{{ label }}', 'Giriş yap')}${footer}`,
  },
  email_change: {
    subject: 'Yeni e-posta adresinizi onaylayın',
    html: `<h2>E-posta değişikliği</h2><p>Hesabınızın e-posta adresini {{ .Email }} olarak değiştirmek için bağlantıya tıklayın:</p>${button.replace('{{ label }}', 'Değişikliği onayla')}${footer}`,
  },
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

/** Subject and HTML for one auth mail, variables HTML-escaped. */
export function render(kind: MailKind, vars: { ConfirmationURL: string; Email: string; SiteURL: string }) {
  const t = templates[kind]
  const html = t.html.replace(/\{\{ \.(ConfirmationURL|Email|SiteURL) \}\}/g, (_, k: keyof typeof vars) => escapeHtml(vars[k]))
  return { subject: t.subject, html }
}

# Dev Supabase Auth settings (read 2026-11-22, project mhkblulknwrimirzipyd, read-only)

Source of truth for selfbase auth defaults. No secrets in this file.

## URL configuration
- Site URL: `https://<coolify-host>/`
- Redirect allowlist: `http://localhost:8099/**`, `http://127.0.0.1:8099/**`

## Sign-ups
- Allow new users to sign up: ON
- Confirm email: ON
- Allow manual linking: OFF
- Allow anonymous sign-ins: OFF

## Providers
- Email: ENABLED
- Phone: DISABLED
- Google: DISABLED in dev (the app calls signInWithOAuth google; it only works on live). Every other provider: DISABLED.

## Email provider
- Secure email change: ON (confirm on old and new address)
- Secure password change: OFF
- Require current password when updating: OFF
- Prevent leaked passwords: OFF
- Minimum password length: 6
- Password requirements: none
- Magic links and email OTP: ON
- Email OTP / link expiry: 3600 seconds
- Email OTP length: 8 digits

## Rate limits
- Emails: 2 per hour (Supabase built-in mailer limit; not meaningful with own SMTP)
- Token refresh: 150 per 5 min per IP
- Token verifications (OTP / magic link): 30 per 5 min per IP
- Sign-ups and sign-ins: 30 per 5 min per IP
- Minimum interval between emails to the same user: 60 seconds
- IP address forwarding: OFF

## Email templates
No custom SMTP is configured in dev, so Supabase's default English templates are in use
(Confirm sign up, Invite, Magic link, Change email, Reset password). There is nothing custom to copy:
selfbase writes its own plain Turkish templates with the same variables
(`{{ .ConfirmationURL }}`, `{{ .Email }}`, `{{ .SiteURL }}`).

## Not read
API keys, database password, SMTP settings tab, Sessions, Auth Hooks, Attack Protection.

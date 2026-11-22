# supabase-js surface used by CorteQS (inventory, 2026-11-22)

Source: `D:\Dev\corteqsemir` at the time of Task 8, `src/` and `supabase/functions/` (tests excluded), supabase-js 2.108.2.
Method: grep for `@supabase/` imports and for `.auth.`, `.storage.`, `.functions.`, `.channel(` call chains, then a full
`tsc` run of the app (`tsconfig.app.json`, 2753 files) with `@supabase/supabase-js` mapped to `dist/selfbase.d.ts`: 0 errors,
same as with the real package.

## Imported names

| Name | Where |
|---|---|
| `createClient` | `src/integrations/supabase/client.ts`; 24 function files via `https://esm.sh/@supabase/supabase-js@2.108.2` |
| `Session` (type) | `src/components/admin/shell/AdminShell.tsx`, `src/components/auth/{auth-context.ts,AuthProvider.tsx}`, `src/hooks/admin/useAdminAccess.ts` |
| `User` (type) | `src/components/auth/auth-context.ts`, `src/lib/early-signup/early-signup-draft.ts` |
| `SupabaseClient` (type) | `supabase/functions/radar-news-scan/{index.ts,lib/*.ts}`, other functions |

Only the esm.sh specifier `@supabase/supabase-js@2.108.2` appears in functions (no `npm:`/`jsr:` forms).

## createClient options in use

- App: `{ auth: { storage: localStorage, persistSession: true, autoRefreshToken: true } }` (detectSessionInUrl default true).
- Functions: `{ auth: { persistSession: false, autoRefreshToken?: false } }`, `{ global: { headers: { Authorization } } }`.
  With a global `Authorization`, PostgREST/storage/functions calls carry that header and `auth.getUser()` (no argument,
  no session) asks `/auth/v1/user` with it (supabase-js `hasCustomAuthorizationHeader` behaviour) — implemented.

## auth

| Call | Count | Sites |
|---|---|---|
| `getUser()` / `getUser(token)` | 36 | 17 app files; 8 function files pass a token (`_shared/edge-authorization.ts`, `delete-account`, `find-matches`, …), 5 call it bare with a global header |
| `getSession` | 6 | `AuthProvider.tsx`, `useAdminAccess.ts`, `group-claims.ts`, `group-submit.ts`, `radarNewsPipeline.ts`, `ResetPasswordPage.tsx` |
| `onAuthStateChange` | 3 | `AuthProvider.tsx`, `useAdminAccess.ts`, `ResetPasswordPage.tsx` (waits for `PASSWORD_RECOVERY`) |
| `signInWithOAuth` google + `redirectTo` | 5 | `CreateEventFormSection.tsx`, `early-signup-api.ts`, `AddWhatsAppPage.tsx` (2), `LoginPage.tsx` |
| `signUp` with `emailRedirectTo`, `data` | 2 | `early-signup-api.ts`, `LoginPage.tsx` (reads `data.session`, `user.identities`) |
| `signInWithPassword` | 2 | `useAdminAccess.ts`, `LoginPage.tsx` (reads `error.code` / `error.message`, `src/lib/auth-messages.ts`) |
| `signOut` | 4 | `AuthProvider.tsx`, `useAdminAccess.ts`, `ProfilePage.tsx`, `ResetPasswordPage.tsx` |
| `updateUser` (`password`, `data`, `phone`) | 3 | `early-signup-api.ts`, `phone-verification-api.ts`, `ResetPasswordPage.tsx` |
| `resetPasswordForEmail` + `redirectTo` | 2 | `useAdminAccess.ts`, `ForgotPasswordPage.tsx` |
| `signInWithOtp` (`shouldCreateUser:false`, `emailRedirectTo`) | 1 | `pending-onboarding-api.ts` |
| `resend` `type:'signup'` | 1 | `LoginPage.tsx` |
| `verifyOtp` `type:'phone_change'` | 1 | `phone-verification-api.ts` |
| `admin.deleteUser` | 1 | `supabase/functions/delete-account/index.ts` |

Also in the brief, not used by the app today: `refreshSession`, `setSession`, `admin.listUsers` — implemented.

## storage (`storage.from(bucket).…`)

`upload` (9; options `contentType`, `upsert`, `cacheControl`), `remove` (12), `createSignedUrl` (9, no options),
`getPublicUrl` (5), `list` (1, `{ limit: 100 }`). `download` is in the brief only. Functions do not use storage.

## functions

`functions.invoke(name, { body })` and `{ method: 'GET' }` (12 sites). Errors are read as `error.message` and
`error.context.status` / `await error.context.json()` (`admin-knowledge-api.ts`, `integration-credentials-api.ts`,
`payments-api.ts`, `site-assistant-api.ts`, `bot-failure.ts`) — `context` is the `Response`, as in supabase-js.

## realtime

5 channels, all `.on('postgres_changes', { event: 'INSERT', schema: 'public', table, filter? }, cb).subscribe()` and
`supabase.removeChannel(ch)`: `MessagesInbox.tsx` (direct_messages), `ServiceRequestsList.tsx` (service_proposals),
`useCaddeCommentsRealtime.ts` (cadde_post_comments, `post_id=eq.<id>`), `useCaddeFeedRealtime.ts` (cadde_posts),
`cadde-notifications-api.ts` (notifications, `user_id=eq.<id>`). No subscribe status callback, no broadcast/presence.

## PostgREST

`.from()` / `.rpc()` throughout (≈300 call sites); `.schema()` is not used. Served by vendored postgrest-js 2.108.2 unchanged.

## Not covered

Nothing the app or the functions call is missing. Deliberately not implemented because nothing calls them:
`auth.getClaims`, `auth.mfa`, `signInAnonymously`, `exchangeCodeForSession` / PKCE flow (`flowType: 'pkce'` is accepted
but behaves as implicit), `storage.createSignedUrls`, `createSignedUploadUrl`, `update`/`move`/`copy`, image transforms,
realtime broadcast/presence, `realtime.setAuth` from app code.

Out of scope of the grep (not `src/` or `supabase/functions/`): Node scripts under `corteqsemir/scripts/` import
`@supabase/supabase-js` too (`scripts/seed/*`, `scripts/ai-knowledge/client.mjs`, `scripts/ops/sync-admin-updates.mjs`);
they keep using the real package unless pointed at selfbase-js separately.

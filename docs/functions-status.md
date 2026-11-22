# Edge function status on the selfbase function host

Checked 2026-11-22 against `D:\Dev\corteqsemir\supabase` (mounted read-only at `/supabase`, no function edited).
The folder holds **24** functions (plus `_shared`), not 25.

Setup: in `.env`, `SUPABASE_DIR` = host path of the app's `supabase/` folder (it holds `functions/` and `config.toml`).
compose mounts it read-only at `/supabase`; the host reads `/supabase/functions` and `/supabase/config.toml` only.
Unset, an empty placeholder (`fn/empty`) is mounted and every name answers 404.

verify_jwt: from `[functions.<name>]` in config.toml, default true. A request with `OPTIONS` and an
`Access-Control-Request-Method` header (a real CORS preflight) skips the check; any other OPTIONS needs a valid JWT like other methods.

How: `fn` image (`denoland/deno:alpine-2.1.4`), client stub at `/client`, one CORS preflight per function
(`OPTIONS /<name>`, `Origin: http://localhost:5173`, `Access-Control-Request-Method: POST`). No real secrets: `SUPABASE_URL=http://core:8080` (unresolvable in the check),
throwaway values for `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, nothing from `fn.env`.
No request other than OPTIONS was sent. Remote modules (esm.sh zod and generative-ai, npm fast-xml-parser) downloaded fine.

A 405 on OPTIONS means the module imported and its handler ran; the function only accepts POST (server-to-server caller, no CORS).
Without the host-provided keys, `stripe-checkout`, `stripe-portal` and `verification-send` also fail at import
(`required server configuration is missing`); in the stack the host sets those keys, so they are listed as OK.

| Function | verify_jwt | OPTIONS | Status |
|---|---|---|---|
| admin-knowledge | true | 200 | OK |
| delete-account | default (true) | 200 | OK |
| directory-search | false | 200 | OK |
| find-matches | true | 200 | OK |
| group-claim-verify | default (true) | 200 | OK |
| group-link-health | false | 405 | OK (POST only) |
| group-preview | default (true) | 200 | OK |
| integration-status | true | 200 | OK |
| lansman-admin | true | 200 | OK |
| radar-news-scan | false | 204 | OK |
| relocation-assistant | default (true) | 200 | OK |
| relocation-notifications | default (true) | 200 | OK |
| send-notification-emails | false | 200 | OK |
| send-phone-otp-hook | false | 500 | waiting for key: `SEND_SMS_HOOK_SECRET`, `WHATSAPP_OTP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_OTP_TEMPLATE` |
| site-assistant | true | 200 | OK |
| stripe-checkout | true | 200 | OK |
| stripe-portal | true | 200 | OK |
| stripe-webhook | false | 500 | waiting for key: `STRIPE_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY` |
| submit-survey-response | false | 200 | OK |
| verification-send | default (true) | 200 | OK |
| wabot-assistant | false | 405 | OK (POST only) |
| whatsapp-autoreply | false | 500 | waiting for key: `GEMINI_API_KEY`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_GRAPH_API_VERSION`, `WHATSAPP_AUTOREPLY_SECRET` |
| whatsapp-reply | true | 500 | waiting for key: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET` |
| whatsapp-webhook | false | 500 | waiting for key: `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` |

Summary: 19 import and answer, 5 waiting for keys, 0 failing for another reason.
`whatsapp-autoreply` imports `https://deno.land/std@0.168.0/http/server.ts`; the import map sends it to `fn/std_serve.ts`
(that `serve()` needs `Deno.serveHttp`, removed in Deno 2).

Re-run the host tests: `sh fn/test/run.sh` (Docker only, no local Deno).

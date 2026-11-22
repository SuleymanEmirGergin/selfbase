# Studio

selfbase's dashboard (React + Vite). control serves the build at `/` (`STUDIO_DIR`).

- `npx vite`: the dev server. `/platform` is proxied to a running control at `STUDIO_DEV_API` (default
  `http://localhost:8080`).
- `npx playwright test`: the e2e specs. Every `/platform` call is answered from `e2e/fixtures`, so no control is needed.

## Dev against a real control

control answers only requests for `PUBLIC_URL`'s hostname (the port is not compared). Every other host gets
`404 {"message":"not found"}`, or `540` for a project's host. Start control with `PUBLIC_URL` set to the Vite address,
for example `PUBLIC_URL=http://localhost:5173`:

- the host check passes, because the proxy sends `Host: localhost:8080` and only the hostname `localhost` is compared;
- cookie writes pass the same-origin check, because the browser's `Origin` is the Vite address;
- the session cookies are not `Secure` over plain http, so the browser keeps them.

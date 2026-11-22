// Calls Deno.serve only after the host's import timeout, while slow-ok is loading.
await new Promise((r) => setTimeout(r, 700))
Deno.serve(() => new Response('late'))

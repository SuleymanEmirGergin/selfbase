// Import outlasts the host's import timeout (500 ms in tests). A timer rather than a bare
// never-settling promise: Deno aborts a stalled top-level await once the event loop is idle,
// which in production never happens because the listener keeps the loop busy.
await new Promise((r) => setTimeout(r, 3000))
Deno.serve(() => new Response('never'))

// Registers first, then keeps its import open long enough for late's Deno.serve to arrive mid-load.
Deno.serve(() => new Response('slow ok'))
await new Promise((r) => setTimeout(r, 400))

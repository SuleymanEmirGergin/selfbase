Deno.serve((req) => Response.json({ hello: 'world', path: new URL(req.url).pathname }))

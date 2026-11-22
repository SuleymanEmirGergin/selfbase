Deno.serve(() => {
  Promise.reject(new Error('background failure'))
  return new Response('rejects ok')
})

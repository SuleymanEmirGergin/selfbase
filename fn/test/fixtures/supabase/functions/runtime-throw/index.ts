Deno.serve(() => {
  throw new Error('upstream failed for https://api.example.test/v1?key=leaked-key')
})

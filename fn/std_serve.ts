// Import-map target for https://deno.land/std@0.168.0/http/server.ts: that serve() needs
// Deno.serveHttp, which Deno 2 removed. Routing it through Deno.serve lets the host capture it.
type Handler = (req: Request, info: Deno.ServeHandlerInfo) => Response | Promise<Response>

export function serve(handler: Handler, options: Deno.ServeOptions = {}): Promise<void> {
  return Deno.serve(options, handler).finished
}

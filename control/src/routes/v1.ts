import { Hono } from 'hono'

// Empty until a later task fills it; mounted at /v1 by app.ts. Each route names its Management API operationId.
export const v1 = new Hono()

import { Hono } from 'hono'

// Empty until a later task fills them; app.ts mounts platformOrgs at /platform and v1Orgs at /v1.
export const platformOrgs = new Hono()
export const v1Orgs = new Hono()

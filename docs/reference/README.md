# Reference documents

## management-api.json

Supabase's published Management API OpenAPI document (spec 7.8), fetched unchanged from
`https://api.supabase.com/api/v1-json`.

- Fetched: 2026-11-22
- sha256: `9dea9aa28a93fcdc223fa3e003bdf7189c2320cc6f7c4c8ed792c1428c83c080`
- `openapi` 3.0.0, `info.version` 1.0.0, 368 601 bytes

The snapshot is authoritative: every `/v1` route names the `operationId` it implements, and
`control/test/openapi.test.ts` checks path, method, operationId and response fields against this file. A mismatch is
fixed in our routes, never here. To refresh it, fetch the URL again, update the date and hash above, and run the
control tests.

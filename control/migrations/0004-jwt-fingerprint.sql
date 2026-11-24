-- An import keeps the source's JWT secret by default (an app moves without changing its keys). A second live copy of
-- the same secret would let one project's keys open another's API, so control compares fingerprints: an HMAC of the
-- secret under the master key (src/secrets.ts), never the secret itself. Control fills rows written before this
-- column at start (db.ts), because SQL cannot decrypt them.
alter table control.project_secrets add column if not exists fingerprint bytea;
create index if not exists project_secrets_fingerprint_idx on control.project_secrets (fingerprint) where fingerprint is not null;

# Database and process resource boundaries

SQLite supports the beta's single-process deployment. Do not run multiple
MayoAuth processes against this file, put it on network storage, or describe it
as a horizontally scalable database tier.

`instance.json` has explicit `limits`:

```json
{
  "databaseMiB": 256,
  "cacheKiB": 8192,
  "auditRows": 10000,
  "auditDays": 30,
  "transientRows": 10000
}
```

SQLite uses 4096-byte pages and `max_page_count` to enforce the main-file ceiling.
The negative `cache_size` sets its page-cache budget in KiB. DELETE journaling
avoids a separately accumulating WAL, and synchronous FULL protects transactions.
The rollback journal can still grow while a transaction runs. Reserve at least
1 GiB of filesystem headroom for the default 256 MiB database and configure a
filesystem/project quota for a strict whole-directory cap. Backups need a separate
budget. Container memory limits do not constrain host disk usage.

Audit data is pruned to the row ceiling on writes; expired audit rows, sessions,
and OIDC records are cleaned at startup, each OIDC upsert and once per minute.
Identity/account records are never pruned to reclaim space. Audit retention is
local housekeeping, not tamper evidence or an immutable compliance archive.
Export to independently operated storage for that purpose.

Administration JSON bodies are bounded to 16 KiB. Interaction forms are bounded
to 8 KiB. Password derivations run at most two at a time, with a bounded queue.
Admin sessions are bounded to 1,000 records and one hour. OIDC session/token TTLs
are explicit. The Compose file sets 256 MiB RAM, 0.5 CPU, 80 processes, a 16 MiB
temporary filesystem, and two rotated 5 MiB container logs.

Inspect `mayoauth status` or authenticated `/api/v1/status`. `/metrics` requires
operator authentication and exposes database bytes and the configured ceiling.
For this beta, alerting is provided by an operator's existing monitoring stack.

A full database returns HTTP 507 for API storage failures. Authentication cannot
complete without writing its required audit/session records. Existing identities
are preserved. Add space or raise the configured ceiling; do not delete the
instance keys. Back up the database and instance configuration separately and
protect both as credentials. With the instance stopped, copy `identity.db` and
the private instance configuration. Test restores into an isolated directory.

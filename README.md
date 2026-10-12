# MayoAuth · beta

**Your identity. Your infrastructure. Your budget.**

An Apache-2.0 identity foundation: a self-hosted OIDC server, upstream OIDC
connectors, an operator console, an API, audit export, metrics, and a CLI.

[Website](https://mayoauth.com) · [No-signup sample workspace](https://mayoauth.com/demo)
· [Docs](https://mayoauth.com/docs) · [Edition boundary](docs/EDITIONS.md)

**Early beta. Use non-sensitive test accounts.** This is a single-instance OIDC
foundation, not a complete Okta replacement or an independently audited system.
Built-in MFA, SAML, SCIM, refresh tokens, self-service recovery and multi-tenant
Cloud are not implemented. See [verified scope](docs/BETA.md).

## Run locally

Requires **Node.js 24 LTS**. No vendor signup, license key, or self-hosted user cap.

```bash
git clone https://github.com/securelyprogramming/MayoAuth.git
cd MayoAuth
npm ci
npm link

read -r -s -p "Admin password: " MAYOAUTH_INIT_PASSWORD
printf '%s' "$MAYOAUTH_INIT_PASSWORD" | mayoauth init \
  --issuer http://localhost:8787 \
  --admin-email admin@example.test --password-stdin
unset MAYOAUTH_INIT_PASSWORD

mayoauth serve
```

Open <http://localhost:8787/login>. The public sample workspace is `/demo` and
needs no account. It holds up to **20 synthetic users**, entirely in the browser;
it does not create real identities or issue tokens.

Instance data and secrets live in `.mayoauth/`, which is ignored by Git. Choose a
different persistent directory with `--data-dir` or `MAYOAUTH_DATA_DIR`. Re-running
`init` never replaces an existing instance. Instance and CLI credentials are saved
with private file permissions. There is no published npm package yet.

## CLI

```bash
mayoauth status
mayoauth doctor
mayoauth users list
mayoauth apps add --name "Local application" \
  --redirect-uri http://localhost:3000/callback
mayoauth connectors list
mayoauth logs --export > audit.json
mayoauth --help
```

Remote operations accept `--url` or `MAYOAUTH_URL`; authenticate with the private
`MAYOAUTH_TOKEN` environment variable. Passwords and connector secrets are read
from stdin, never command arguments. Remote endpoints require HTTPS.

## OIDC

Discovery: `INSTANCE_ORIGIN/.well-known/openid-configuration`.

- Authorization-code flow with required PKCE S256, signed ID tokens, consent,
  JWKS, and userinfo, implemented by the maintained `oidc-provider` library.
- Applications have exact callback URLs; public dynamic registration is disabled.
- Upstream connectors use `openid-client` with state, nonce and PKCE validation.
- Upstream accounts require an explicit `(connector, sub)` mapping to an existing
  local user. Accounts are never auto-linked by matching email addresses.
- Passwords use bounded-concurrency scrypt. Connector secrets use AES-256-GCM at
  rest. Operator API authentication supports a private token or HttpOnly sessions.
- User suspension revokes persisted sessions/grants. Previously issued ID tokens
  may remain valid until expiry; relying applications manage their own sessions.

See [connector setup](docs/OIDC.md). Generic connector tests use a real local OIDC
fixture; named cloud providers still need live tenant validation.

## Database and container budgets

The beta deliberately uses **one SQLite process**. Defaults:

| Resource | Limit |
| --- | --- |
| Main database file | 256 MiB, enforced by SQLite |
| SQLite page cache | 8 MiB configured budget |
| Audit data | 10,000 events / 30 days |
| Transient OIDC records | 10,000, expired records removed |
| Container | 256 MiB memory, 0.5 CPU, 80 processes |
| Temporary files / container logs | 16 MiB tmpfs / 2 × 5 MiB |

The database-file cap excludes rollback journals, backups, and filesystem overhead.
Use a host quota for a hard directory-level ceiling. Full storage rejects writes;
identities are not deleted to make room. [Details](docs/DATA-LIMITS.md).

Initialize the data directory first, make it writable by container UID 1000, set
`MAYOAUTH_DATA_PATH`, then run `docker compose up -d --build`. The example exposes
only loopback port 8787. For a reverse proxy, use the exact external HTTPS issuer
and set `trustedProxyHops` only for your known proxy topology. Do not expose the
app directly with a trusted-proxy configuration.

## Community and commercial services

Community includes core identity, OIDC, connectors, audit export, metrics, and the
CLI without a per-user license. Built-in MFA will also belong in Community when
implemented. You supply infrastructure and operate it.

Planned Cloud Free: managed production service for up to 20 users. Planned Premium:
managed capacity beyond 20 users, longer managed retention, backups, operational
alerts, and support. **Neither service, checkout, payments nor an SLA exists yet.**
Commercial operations belong in a separate private repository; engine improvements
stay here. [Full edition policy](docs/EDITIONS.md).

## Development and validation

```bash
npm ci
npx playwright install chromium
npm run check
npm test
npm run test:browser
npm run build
```

Tests cover real OIDC code/PKCE flows, token validation, code reuse, redirect
validation, CSRF, authentication boundaries, suspension, connector secrets,
database-full behavior, retention ceilings, CLI operations, and browser/mobile
demo workflows. CI runs these on Node 24.

## Contributing

Open an issue or pull request. Keep runtime data, keys, deployment inventory and
customer information out of Git. Security-sensitive changes need boundary tests.
Use the private security-reporting process in [SECURITY.md](SECURITY.md).

Copyright 2026 Programming Securely contributors. Apache-2.0; see [LICENSE](LICENSE).

# Beta scope

Implemented: self-hosted single-instance OIDC using `oidc-provider`, authorization
code/PKCE, public JWKS and discovery, local passwords, explicit upstream OIDC
linking using `openid-client`, operator API and console, CLI, audit JSON export,
Prometheus counters, user suspension, SQLite resource caps, and a browser-only demo.

Not implemented: native MFA/passkeys, self-service signup/recovery, email delivery
or verification, SAML, LDAP, SCIM, directory synchronization, refresh tokens,
multi-tenant hosted signup, managed Cloud, billing, high availability, distributed
rate limits, external security assessment or availability/support SLAs.

The public site and operator-controlled inspection instance are beta software.
Use synthetic, non-sensitive accounts. The demo is explicitly a simulation.
Do not describe managed Cloud as available, the product as independently audited,
the audit table as immutable, or the project as a complete Okta replacement.

Relying applications must handle their own application sessions. Suspension
removes server-side grants and sessions; already issued ID tokens may still be
cryptographically valid until expiry. Container/disk monitoring and verified
backup/restore procedures remain operational responsibilities.

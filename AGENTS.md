# MayoAuth

Public Apache-2.0 repository. Keep credentials, runtime data, customer information,
hostnames and deployment inventories outside the repository. The commercial
operations repository is separate. Never commit generated instance configuration.

Keep the beta label visible. Distinguish implemented features, browser simulations,
and planned commercial services. Do not claim production certification or full
Okta parity. Core authentication, connectors and basic audit exports stay open.

Use the maintained oidc-provider/openid-client libraries for protocol validation.
Require exact redirect URIs, PKCE S256, bounded sessions and authorization on every
administration endpoint. Add regression tests for authentication boundaries.

Before publication run npm run check, npm test, npm run test:browser, and inspect
the staged diff for secrets. Do not publish private operational files.

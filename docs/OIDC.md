# OIDC setup

Register a relying application using the console or CLI:

```bash
mayoauth apps add --name "Example app" \
  --redirect-uri http://localhost:3000/callback
```

Use the returned client ID, discovery metadata, and authorization code with PKCE
S256. Supported scopes: `openid email profile`. Access/ID tokens expire after
10 minutes, authorization codes after 60 seconds, interactions after 10 minutes,
sessions after one hour. Email is operator-provisioned and always reported as
unverified; no email verification service exists. Profile/email are available
through userinfo under the requested and approved scopes.

Upstream OIDC provider:

1. Register a web OIDC client at your provider, with the exact callback
   `INSTANCE_ORIGIN/connectors/callback` and client-secret POST authentication.
2. Configure its issuer/client ID with `mayoauth connectors add --name "Provider"
   --issuer https://identity.example.com --client-id CLIENT_ID --secret-stdin`.
   Pipe the secret on stdin from a secure source. It is encrypted at rest.
3. Provision the local user, then use `mayoauth connectors link --id CONNECTOR_ID
   --subject IMMUTABLE_PROVIDER_SUB --user-id LOCAL_USER_ID`.
4. Start a relying application's sign-in, then select the connector.

Never map accounts by an unverified email claim. The connector validates state,
nonce, issuer, signature, audience and PKCE through `openid-client`. Its short
continuation ticket returns to the original interaction before sign-in finishes.
Disabled connectors and inactive/unlinked users cannot finish that flow.

The connector is generic OIDC. Google/Microsoft/Okta tenants require their own
configuration and live validation. A regular GitHub OAuth app does not supply a
generic OIDC login issuer. This beta supports no SAML/LDAP/SCIM or refresh tokens.

# plugin-idp-oidc-client-manager

Admin UI and persistent public OIDC client registry for `@nocobase/plugin-idp-oauth`.

## Enable

```powershell
yarn pm enable @nocobase/plugin-idp-oauth
yarn pm enable plugin-idp-oidc-client-manager
```

Open **Settings → OIDC applications** and create a public application. Public clients do not receive or store a client secret.

## Supported client profile

- Authorization Code flow
- PKCE S256, required by the provider
- `token_endpoint_auth_method: none`
- Refresh tokens through the `offline_access` scope
- RFC 8252 loopback redirects with an optional dynamic callback port
- RP-initiated logout callback registration
- Per-application allowed scopes selected from the scopes advertised by the provider

Confidential clients, client secrets, Client Credentials, and hybrid grants are intentionally disabled until a provider extension compatible with the standard NocoBase Docker image is available.

Client IDs are stored exactly as entered. The manager does not automatically add the legacy `app:` prefix. Existing `app:` IDs remain valid and continue to receive the upstream consent behavior. IDs without that prefix use the normal consent screen.

Production callback URLs must use HTTPS. HTTP is accepted only for `localhost`, `127.0.0.1`, and IPv6 loopback development callbacks. Callback URLs are matched exactly by the OIDC provider.

The built-in provider advertises `openid`, `profile`, `email`, `offline_access`, and registered API scopes. Selecting scopes in this plugin limits what a particular application may request; it does not create new claims.

## Authorization Code example

Use the discovery URL shown on the settings page with an OpenID Connect client such as `openid-client`.

```text
scope: openid profile email offline_access
response_type: code
PKCE: S256
client authentication: none
```

For a public/native client, register a loopback callback without a fixed port, for example `http://127.0.0.1/callback`, and enable **Allow dynamic loopback redirect port**. The application may then authorize with `http://127.0.0.1:49152/callback`. Only the port may vary; scheme, loopback host, path, and query must still match.

Validate `state`, `nonce`, the PKCE code verifier, ID-token signature, issuer, audience, and expiry before creating the application session.

## Identity and API access

For sign-in with `plugin-oidc-auth`, select **NocoBase IdP** as the identity provider profile, select **Public client (none, PKCE)** and use `openid profile email`. Leave the client secret empty. This profile sends the explicit API resource in authorization and code exchange, validates the ID-token signature using JWKS, and uses its issuer and subject (`iss` + `sub`) as the identity. It does not call UserInfo. Selecting a resource does not grant the `api` scope.

For API access, also allow/request `api` and send the exact API resource shown in the integration guide in authorization, code exchange, and refresh requests. Use the validated ID token for identity and the API access token for API requests. API access tokens are audience-bound and cannot call UserInfo. API scopes do not replace the user's NocoBase ACL permissions.

The stock NocoBase provider infers `email_verified` from email presence. The **NocoBase IdP** profile in `plugin-oidc-auth` ignores that claim and rejects automatic linking to an existing account by email. Existing issuer/subject links remain usable; new accounts can be created if auto-signup is enabled. External applications must also avoid trusting this claim for account linking.

This plugin uses the unchanged `@nocobase/plugin-idp-oauth` APIs. Its own middleware runs before the provider's resource authentication and validates the signature, issuer, API audience, expiry, client status, and `api` scope for clients registered by this manager. The user's NocoBase ACL remains required. Clients and resources outside this manager retain upstream behavior; the plugin does not replace or patch provider methods.

External clients should send the exact API resource even for sign-in, validate the ID token, and disable UserInfo retrieval. This works with the stock provider's resource selection regardless of whether MCP is also enabled. API access requires separately allowing and requesting `api`. Native NocoBase session tokens and OAuth access tokens are not application identity documents.

Implicit flow, password grant, client credentials, confidential clients, and wildcard non-loopback callbacks are intentionally not supported.

## Regression tests

Run server suites sequentially against a disposable NocoBase test database and a separate `STORAGE_PATH`:

```powershell
yarn test packages/plugins/plugin-idp-oidc-client-manager/src/server --run --single-thread=true
yarn test packages/plugins/plugin-oidc-auth/src/server --run --single-thread=true
yarn test packages/plugins/@nocobase/plugin-idp-oauth/src/server --run --single-thread=true
```

The browser sign-in test is opt-in. It requires Playwright, an installed Chromium browser, OpenSSL, and the same isolated test database/storage. It drives actual NocoBase handlers through minimal test pages; it does not cover the production application's full UI.

```powershell
$env:OIDC_BROWSER_E2E = '1'
# Set these to installed executables when they are not available through the defaults.
$env:OIDC_TEST_BROWSER_EXECUTABLE = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$env:OIDC_TEST_OPENSSL = 'C:\Program Files\Git\usr\bin\openssl.exe'
yarn test packages/plugins/plugin-idp-oidc-client-manager/src/server/__tests__/browser-signin.test.ts --run --single-thread=true
```

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

Implicit flow, password grant, client credentials, confidential clients, and wildcard non-loopback callbacks are intentionally not supported.

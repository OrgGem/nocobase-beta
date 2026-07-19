# plugin-idp-oidc-client-manager

Admin UI and persistent confidential-client registry for `@nocobase/plugin-idp-oauth`.

## Enable

```powershell
yarn pm enable @nocobase/plugin-idp-oauth
yarn pm enable plugin-idp-oidc-client-manager
```

Open **Settings → OIDC applications**, create an application, copy the generated secret, and store it in the relying application's secret manager. The secret is encrypted at rest with NocoBase `app.aesEncryptor` and is only returned by the create/reset response.

Production callback URLs must use HTTPS. HTTP is accepted only for `localhost`, `127.0.0.1`, and IPv6 loopback development callbacks. Callback URLs are matched exactly by the OIDC provider.

## Supported client profile

- Authorization Code flow
- PKCE S256 (required by the provider)
- Refresh tokens through the `offline_access` scope
- `client_secret_basic` and `client_secret_post`
- Public/native clients with `token_endpoint_auth_method: none` and mandatory PKCE
- RFC 8252 loopback redirects with a dynamic callback port for native clients
- RP-initiated logout callback registration
- Per-application allowed scopes selected from the scopes advertised by the provider

The built-in provider currently advertises `openid`, `profile`, `email`, `offline_access`, and `api`. Selecting scopes in this plugin limits what a particular application may request; it does not create new claims. A new custom scope also requires a resource-server or claims extension to be registered with `@nocobase/plugin-idp-oauth`.

Implicit flow, password grant, and wildcard non-loopback callbacks are intentionally not supported.

For a public/native client, register a loopback callback without a fixed port, for example `http://127.0.0.1/callback`, and enable **Allow dynamic loopback redirect port**. The application may then authorize with `http://127.0.0.1:49152/callback`. Only the port may vary; scheme, loopback host, path, and query must still match.

## Node.js example

Use the discovery URL shown on the settings page with an OpenID Connect client such as `openid-client`. Configure:

```text
scope: openid profile email offline_access
response_type: code
PKCE: S256
```

Keep the client secret on the Node.js backend. Validate `state`, `nonce`, the ID-token signature, issuer, audience, and expiry before creating the application session.

## ASP.NET Core example

```csharp
services.AddAuthentication()
    .AddOpenIdConnect("NocoBase", options =>
    {
        options.Authority = "https://nb.example.com/api";
        options.ClientId = "crm-production";
        options.ClientSecret = configuration["NocoBaseOidc:ClientSecret"];
        options.ResponseType = "code";
        options.UsePkce = true;
        options.SaveTokens = true;
        options.CallbackPath = "/signin-oidc";
        options.SignedOutCallbackPath = "/signout-callback-oidc";
        options.Scope.Add("profile");
        options.Scope.Add("email");
        options.Scope.Add("offline_access");
    });
```

Use the OIDC `sub` claim as the stable external-user identifier. Email and username can change.

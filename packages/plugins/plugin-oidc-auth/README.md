# plugin-oidc-auth

OpenID Connect authentication provider. Based on original NocoBase OIDC plugin with added features:

 - **RP-Initiated Logout** - uses `end_session_endpoint` to logout from issuer when logging out of NocoBase
 - **Updates user record on login** - updates mapped user fields from validated ID-token and UserInfo claims
 - **Ability to configure any mapped field in users collection**

## Client authentication

Use **Public client (none, PKCE)** for clients registered by `plugin-idp-oidc-client-manager`. A secret is not sent in this mode, even if an older configuration retained one. Authorization Code flow always uses PKCE S256, state, and nonce.

Confidential clients can continue using `client_secret_basic` or `client_secret_post`, both of which require a secret. Existing configurations without an explicit authentication method retain `client_secret_basic`.

Select **Standard OpenID Connect** for normal providers. The plugin validates the ID token and obtains additional claims from UserInfo; failures are not silently ignored. Existing configurations retain this behavior.

Select **NocoBase IdP** when the issuer uses the stock `@nocobase/plugin-idp-oauth`. Use `openid profile email`. This profile explicitly requests the issuer's API resource at authorization and code exchange, validates the ID-token signature using JWKS, and derives identity from `iss` + `sub`. It skips UserInfo because resource-bound access tokens cannot call that endpoint. The `api` scope is unnecessary for sign-in. No core plugin changes are required.

Users are linked by issuer and subject. Automatic linking of a new identity to an existing account by email requires `email_verified: true`. An existing issuer/subject link does not require re-verifying email on each login.

The **NocoBase IdP** profile ignores `email_verified` because the stock provider infers it from email presence. Consequently, it never uses that claim to automatically link an existing local account. Existing issuer/subject links still work, and auto-signup can provision a new account when there is no email collision. The upstream provider's claims remain unchanged for other applications.

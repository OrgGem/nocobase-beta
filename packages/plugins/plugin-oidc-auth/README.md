# plugin-oidc-auth

OpenID Connect authentication provider. Based on original NocoBase OIDC plugin with added features:

 - **RP-Initiated Logout** - uses `end_session_endpoint` to logout from issuer when logging out of NocoBase
 - **Updates user record on login** - updates mapped user fields from validated ID-token and UserInfo claims
 - **Ability to configure any mapped field in users collection**

## Client authentication

Use **Public client (none, PKCE)** for clients registered by `plugin-idp-oidc-client-manager`. A secret is not sent in this mode, even if an older configuration retained one. Authorization Code flow always uses PKCE S256, state, and nonce.

Confidential clients can continue using `client_secret_basic` or `client_secret_post`, both of which require a secret. Existing configurations without an explicit authentication method retain `client_secret_basic`.

Use `openid profile email` for sign-in. The plugin validates the ID token and obtains additional claims from UserInfo; failures are not silently ignored. API access tokens bound to a separate resource are not UserInfo tokens.

Users are linked by issuer and subject. Automatic linking of a new identity to an existing account by email requires `email_verified: true`. An existing issuer/subject link does not require re-verifying email on each login.

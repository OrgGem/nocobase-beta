# plugin-api-manager

API proxy gateway with a centralized payload-encryption layer (a WSO2-style register/forward gateway, reduced to the essentials).

- **Outbound**: internal caller → `POST /api/apim/outbound/<routeName>` → payload encrypted → partner URL.
- **Inbound**: partner → `POST /api/apim/inbound/<inboundPath>` → payload decrypted → internal backend URL.

## Authentication

Every gateway request requires an `X-API-Key` header. Keys are created in the admin UI (`Settings → API Manager → API Keys`); the plaintext key is shown **once** and only its SHA-256 hash is stored. Scopes are `inbound`, `outbound`, or route-scoped `inbound:<routeName>` / `outbound:<routeName>` (a bare scope allows every route of that direction). Keys support expiry and revocation.

## Encryption per route

`encryptionMode` is one of `none | aes-256-gcm | pgp`; `wireFormat` is `binary` (raw container bytes) or `json` (`{"encoding":"base64","ciphertext":"..."}` envelope). Decryption accepts both wire formats regardless of the route setting.

### AES-256-GCM

Uses the Crypto Toolkit `NCB1` container (AES-256-GCM). The shared secret is resolved in this order:

1. `aesSecretEnvVar` — name of an environment variable holding the secret.
2. `aesSecret` — stored encrypted at rest (via the application AES encryptor) and masked in all admin API responses.

If the secret base64-decodes to exactly 32 bytes it is used as the raw key; otherwise it is treated as a passphrase (scrypt-derived key).

### PGP

Key names reference `cryptoKeys` records from plugin-crypto-toolkit (public material in the DB, private material only in environment variables).

| Route field | Outbound request | Outbound response | Inbound request | Inbound response |
| --- | --- | --- | --- | --- |
| `pgpEncryptKeyName` | encrypt to partner public key | — | — | encrypt to partner public key |
| `pgpDecryptKeyName` | — | decrypt with own private key | decrypt with own private key | — |
| `pgpSignKeyName` | sign with own private key | — | — | sign with own private key |
| `pgpVerifyKeyName` | — | verify partner signature | verify partner signature | — |

**Private key convention**: the own key's `privateEnvVar` must be a Crypto Toolkit-managed variable (`CRYPTO_TOOLKIT_<NAME>_PRIVATE`). If the private key is passphrase-protected, provide the passphrase in a companion variable named `<privateEnvVar>_PASSPHRASE`.

When `pgpVerifyKeyName` is configured and the incoming signature does not verify, the request is rejected with `400 APIM_SIGNATURE_INVALID`.

## Forwarding behavior

- Synchronous forwarding with per-route `timeoutMs` (504 `APIM_TIMEOUT` when exceeded) and `retryCount`/`retryDelayMs` (retries on network errors and HTTP 5xx only).
- `maxBodyMb` caps the request body (413 `APIM_BODY_TOO_LARGE`), clamped to 1–100 MB.
- `forwardHeaders` allow-lists incoming headers to pass through; `staticHeaders` injects fixed headers. Hop-by-hop headers, `Authorization`, `X-API-Key`, and cookies are always stripped.
- Streaming is not supported: request and response bodies are buffered.

## Audit log

Every gateway request writes an `apiRequestLogs` row (timing, sizes, SHA-256 of both bodies, status). Full payloads are stored only when the route has `logPayloads` enabled (stored base64-encoded). Logs older than the retention window (default 30 days) are pruned on startup and every 24 h.

## SSRF / outbound whitelist

Outbound forwarding uses the shared `serverRequest` helper. When `SERVER_REQUEST_WHITELIST` is unset, all hosts are allowed (with SSRF warnings for private/loopback targets). When you configure `SERVER_REQUEST_WHITELIST`, remember to include the internal backend hosts used by inbound routes as well as any partner hosts.

## ACL

Admin access to routes/partners/keys/logs is guarded by the `pm.plugin-api-manager` ACL snippet. Gateway paths bypass the resourcer and are protected solely by API-key authentication.

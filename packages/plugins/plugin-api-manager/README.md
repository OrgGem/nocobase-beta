# plugin-api-manager

API proxy gateway with a centralized payload-encryption layer (a WSO2-style register/forward gateway, reduced to the essentials).

- **Outbound**: internal caller → `POST /api/apim/outbound/<routeName>` → payload encrypted → partner URL.
- **Inbound**: partner → `POST /api/apim/inbound/<inboundPath>` → payload decrypted → internal backend URL.

## Authentication

Every gateway request requires an `X-API-Key` header. Keys are created in the admin UI (`Settings → API Manager → API Keys`); the plaintext key is shown **once** and only its SHA-256 hash is stored. Scopes are `inbound`, `outbound`, or route-scoped `inbound:<routeName>` / `outbound:<routeName>` (a bare scope allows every route of that direction). Keys support expiry and revocation.

## Encryption per route

`encryptionMode` is one of `none | aes-256-gcm | pgp | rsa-oaep`; `wireFormat` is `binary` (raw container bytes) or `json` (`{"container":"...","encoding":"base64","ciphertext":"...","contentType":"..."}` envelope). The JSON envelope carries the plaintext content type so the decrypting side can restore it; the binary format has no place to store it, so decrypted payloads without a content type are sniffed from the first bytes (`{`/`[` → JSON, `<` → XML, anything else → octet-stream). Decryption accepts both wire formats regardless of the route setting.

`responseEncrypted` defaults to `true`; set it to `false` when the other side sends plaintext responses (outbound then skips response decryption, inbound skips response encryption).

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

When `pgpVerifyKeyName` is configured and the incoming signature does not verify, the request is rejected with `400 APIM_SIGNATURE_INVALID`. A PGP message that is **not signed at all** is also rejected in that case — configure `pgpVerifyKeyName` only when the partner always signs.

### RSA-OAEP hybrid

Uses the Crypto Toolkit `NCR1` container (RSA-OAEP wraps a random AES-256-GCM session key). Key names reference `cryptoKeys` records of kind `rsa-*`:

- Outbound: `rsaEncryptKeyName` (partner RSA public key) encrypts the request; `rsaDecryptKeyName` (own key with private material) decrypts encrypted responses.
- Inbound: `rsaDecryptKeyName` decrypts partner requests; `rsaEncryptKeyName` encrypts responses back to the partner.

## Request signing (HMAC) and JWT

Per-route, independent of the encryption mode:

- **HMAC** (`hmacVerifyEnabled` inbound / `hmacSignEnabled` outbound): the signature covers the canonical string `timestamp\nnonce\nMETHOD\npath\nsha256hex(body)`. The `path` component **includes the query string**, so callers must sign the full request path and any forwarded query parameters are tamper-protected. Headers are `X-APIM-Timestamp`, `X-APIM-Nonce`, `X-APIM-Signature` (hex HMAC-SHA256). Timestamps outside `hmacToleranceSec` (clamped 1–3600 s) and replayed nonces are rejected with `401 APIM_HMAC_INVALID`.
- **JWT** (`jwtVerifyEnabled` inbound / `jwtSignEnabled` outbound): `Authorization: Bearer <token>`; the scheme is case-insensitive. HS256 uses the shared `jwtSecret`/`jwtSecretEnvVar`; RS256 uses a Crypto Toolkit key (`jwtVerifyKeyName` / `jwtSignKeyName`). The `exp` claim is **mandatory** — tokens without a numeric `exp` are rejected. `jwtIssuer`/`jwtAudience` are validated when configured.

## Forwarding behavior

- The caller's query string is forwarded to the target URL (appended with `?`, or `&` when the target already has one).
- Synchronous forwarding with per-route `timeoutMs` (504 `APIM_TIMEOUT` when exceeded) and `retryCount`/`retryDelayMs` (retries on network errors and HTTP 5xx only).
- `maxBodyMb` caps the request body (413 `APIM_BODY_TOO_LARGE`), clamped to 1–100 MB.
- `forwardHeaders` allow-lists incoming headers to pass through; `staticHeaders` injects fixed headers. Hop-by-hop headers, `Authorization`, `X-API-Key`, and cookies are always stripped.
- Streaming is not supported: request and response bodies are buffered.
- Upstream failures return a generic `502 APIM_UPSTREAM_ERROR` ("Upstream request failed"); connection details are written to the server log and the request log only, never to the caller.

## Audit log

Every gateway request writes an `apiRequestLogs` row (timing, sizes, SHA-256 of both bodies, status). Full payloads are stored only when the route has `logPayloads` enabled (stored base64-encoded). Note what "full payload" means per direction: for **outbound** routes the logged request payload is the caller's **plaintext** (captured before encryption); for **inbound** routes it is the raw ciphertext exactly as the partner sent it. Enable `logPayloads` only when storing that data is acceptable. Logs older than the retention window (default 30 days) are pruned on startup and every 24 h.

## IP allowlist

`ipAllowlist` accepts exact IPv4/IPv6 addresses and IPv4 CIDR ranges (e.g. `10.0.0.0/8`). An empty list allows all clients. Limitations: CIDR matching is IPv4-only — IPv6 entries match by exact address only (zone ids are stripped and `::ffff:a.b.c.d` is normalized to `a.b.c.d` before comparison).

## SSRF / outbound whitelist

Outbound forwarding uses the shared `serverRequest` helper. When `SERVER_REQUEST_WHITELIST` is unset, all hosts are allowed (with SSRF warnings for private/loopback targets). When you configure `SERVER_REQUEST_WHITELIST`, remember to include the internal backend hosts used by inbound routes as well as any partner hosts.

## ACL

Admin access to routes/partners/keys/logs is guarded by the `pm.plugin-api-manager` ACL snippet. Gateway paths bypass the resourcer and are protected solely by API-key authentication.

# plugin-hashicorp-vault-integration

Integrates HashiCorp Vault with NocoBase. Maps Vault KV secrets to NocoBase variables usable as `{{$vault.KEY}}` in the variable picker (v1 and v2 clients), with optional push into `app.environment` so secrets are also available as `{{$env.KEY}}` in workflows, custom requests, and data sources.

## Features

- **Connections**: manage multiple Vault servers (address, namespace, KV mount, KV v1/v2).
- **Auth methods**: Token and AppRole (`role_id` + `secret_id`). Credentials are AES-encrypted at rest and masked (`••••••••`) in API responses.
- **Secret mappings**: map `mount/path#key` to a variable key. Secrets are **never stored in the database** — they live in an in-memory cache populated by a periodic sync.
- **`{{$vault.KEY}}`**: registered on both the legacy v1 variable picker and the v2 flow-engine context. Only mappings with `exposeToClient` enabled resolve for clients (default: off).
- **`$env` sync**: mappings with `syncToEnv` enabled are pushed to `app.environment.setVariable(key, value)` on each sync tick.
- **Cron sync**: every 5 minutes by default; override with `VAULT_SYNC_CRON` (6-field cron). Manual "Sync now" available in settings.
- **Path browser**: browse KV paths and subpaths from the mapping form, select a secret, then choose one of its available keys. KV v2 listing uses the metadata API; secret values are never returned to the browser.

## Settings

Admin settings live under **Settings → HashiCorp Vault** with two tabs:

- **Connections** — CRUD + "Test connection" (`/v1/sys/health`).
- **Secret Mappings** — CRUD + "Sync now", last sync time and last error per mapping.

## ACL

- `vault:resolve`, `vault:listKeys` — any logged-in user (only `exposeToClient` mappings are visible/resolvable).
- `vaultConnections:*`, `vaultSecretMappings:*`, `vault:syncNow` — admin snippet `pm.plugin-hashicorp-vault-integration`.

## Vault policy for path browsing

KV v2 tokens need `list` permission on metadata paths and `read` permission on data paths. For a mount named `secret`:

```hcl
path "secret/metadata/*" {
  capabilities = ["list", "read"]
}

path "secret/data/*" {
  capabilities = ["read"]
}
```

## Operational constraints

- AppRole: the plugin re-logins when the client token expires. It does not renew `secret_id`; single-use or short-TTL `secret_id`s will eventually fail — use a long-lived `secret_id` or Token auth.
- Multi-node: each node runs its own sync cron (Vault reads are idempotent). Mapping changes broadcast a cache-invalidation message to other nodes; secret values are never sent over the sync bus.

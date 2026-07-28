# Skill Registry

`plugin-skill-registry` is the immutable public catalog for portable Agent skills. It imports candidates from Skill Hub and Git Manager, publishes a versioned ZIP artifact, then lets Agent Orchestrator install that exact version as a local skill projection.

The public surface needs no login, but it is available anonymously only after
you explicitly opt in with `SKILL_REGISTRY_PUBLIC_ENABLED=true`:

- `skillRegistryPublic:list`
- `skillRegistryPublic:get`
- `skillRegistryPublic:versions`
- `skillRegistryPublic:download`
- `skillRegistryPublic:metadata`

For example, after that opt-in, an external client can discover and fetch an
exact package version without an Authorization header:

```bash
curl 'https://registry.example.com/api/skillRegistryPublic:list?runtime=python&channel=stable'
curl -L -o pdf-report.zip \
  'https://registry.example.com/api/skillRegistryPublic:download?package=acme/pdf-report&version=1.0.0'
```

The download response includes `X-Skill-Version`, `X-Artifact-Sha256`, and a
standard `Digest` header. Clients should hash the ZIP before installing it and
compare the result with those headers.

`list` and `versions` accept `limit` from `1` through `100` (default `20`).
Malformed, zero, negative, fractional, and over-limit values return
`400 INVALID_LIMIT`; they are not silently rounded or capped. Continue with the
opaque `nextCursor` exactly as returned and keep the original filters unchanged.
The signed cursor is bound to those filters and to a `(publishedAt, id)` keyset,
so inserts or deletes before the current position do not duplicate or skip the
remaining records. A cursor copied to another query returns `400 INVALID_CURSOR`.

Anonymous string inputs are bounded before any catalog query: `q` is at most 200
characters, `tag` 80, `channel` 20, package identity is `namespace/slug` with
80/120-character components, and an exact SemVer is at most 64 characters.
`runtime` accepts only `python` or `node`. Malformed filters return `400`; a
malformed package or explicit version uses the same public `404` as an absent or
non-public record, so private catalog state cannot be enumerated. `If-None-Match`
accepts standard comma-separated entity tags, weak tags, and `*` on all cached
catalog and download responses.

Artifact downloads are GET-only. A matching `If-None-Match` returns `304`
without opening the ZIP or changing download statistics. A download audit row
and the package aggregate count are recorded only after the GET response has
finished flushing; HEAD requests, revalidation hits, and interrupted streams do
not increase the count.

All source configuration, sync, publish, yank, and installation actions remain behind NocoBase ACL snippets. A yanked version is no longer downloadable; download responses require cache revalidation so a shared cache cannot continue serving it after the yank.

External clients are strictly read-only. They can search metadata and download an
artifact, but there is no public upload, publish, update, yank, or delete action.
Skill changes must originate in the NocoBase administration UI or in an explicitly
export-enabled Git Manager / Skill Hub source, then pass the registry sync and
publish workflow.

Registry signing is optional. Unsigned artifacts are valid, and clients do not need
to verify a registry signature. SHA-256 verification is mandatory: the artifact
digest, generated manifest digest, package identity, version, runtime, and
entrypoint are bound together and rechecked before local installation.

## Source export grants

Creating a Registry source does not grant the Registry access to the source data. The plugin that owns the data must opt in first:

- For Git Manager, set `gitRepositories.registryExportEnabled=true` on the repository that may be exported.
- For Skill Hub, set `skillDefinitions.registryExportEnabled=true` on each definition that may be exported.

Both fields default to `false`, including for existing records after schema sync. For example, this sequence is denied:

1. An administrator creates a Registry source with `providerConfig.repositoryId=12`.
2. Repository 12 still has `registryExportEnabled=false`.
3. Git Manager rejects `resolveCommit` with its provider-owned
   `REGISTRY_EXPORT_NOT_GRANTED` error, before the Registry can read a tree or file.
4. The Registry maps that provider error to `403 SOURCE_EXPORT_NOT_GRANTED` and
   does not create or refresh candidates. Skill Hub uses the same provider error
   and Registry-facing mapping.

Adding `registryExportEnabled` to the Registry's `providerConfig` has no effect because a consumer cannot grant itself access. Grant or revoke export on the provider-owned record through an ACL-protected NocoBase resource update, for example:

```http
POST /api/gitRepositories:update
Authorization: Bearer <admin-token>
Content-Type: application/json

{"filterByTk":12,"values":{"registryExportEnabled":true}}
```

The same update shape applies to `skillDefinitions`. Revoking the field immediately blocks future discovery, sync, and publish reads; already-published immutable artifacts remain available according to their Registry visibility and yank state.

Registry source CRUD accepts only `name`, `providerType`, `namespace`,
`providerConfig`, `enabled`, `syncPolicy`, and `syncIntervalMinutes`. Git Manager
configuration accepts only `repositoryId`, `ref`, and `rootPath`; Skill Hub
accepts only `skillDefinitionIds`. Operational/audit fields, credentials, nested
credential variants, and self-grant fields are rejected. Updates are merged with
the stored configuration and the complete result is validated. Direct update and
delete hold the same non-blocking per-source lock as sync/publish; if one of those
operations is active, CRUD returns `409 REGISTRY_OPERATION_BUSY` without waiting.

## Default public rate limits

Limits apply to a trusted client IP, not to the unauthenticated client identity:

| Endpoint class | Burst limit | Sustained limit |
| --- | --- | --- |
| Catalog (`list`) | 20 requests / 5 seconds | 60 requests / minute |
| Detail (`get`, `versions`, `metadata`) | 30 requests / 5 seconds | 120 requests / minute |
| Download | 10 requests / minute | 30 requests / 10 minutes |

Filesystem downloads also hold an active-response lease: at most 3 responses per
IP and 20 responses globally by default. A fully flushed response records the
download; a conditional `304`, timeout, or disconnected client does not. Rate-limit
responses include `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`;
`429` also includes `Retry-After` for the window that actually blocked the request.
Set `SKILL_REGISTRY_TRUST_PROXY_CIDRS` only to proxy/CDN networks you operate:
otherwise forwarded headers are ignored and the direct peer IP is limited. In a
multi-replica deployment, a shared rate-limit cache alone is insufficient. Every
replica must mount the same artifact volume and set
`SKILL_REGISTRY_STORAGE_SHARED=true`, and `LOCK_ADAPTER_DEFAULT` must name a
shared lock adapter such as Redis. Otherwise replica A can publish a ZIP that
replica B cannot read, or two replicas can sync/publish the same source at once;
distributed readiness therefore fails closed.

## Dependencies and boundaries

- `plugin-agent-orchestrator` is optional until a Skill Hub source is added or a version is installed into an Agent. It exposes narrow snapshot and installation services; the Agent never calls this public registry while executing a skill.
- `plugin-git-manager` is optional until a Git Manager source is added. Git credentials and checkout paths stay inside Git Manager.
- Artifacts use the local filesystem by default. Set `SKILL_REGISTRY_STORAGE_PATH` to a persistent volume when deploying. An object-storage/CDN adapter is the remaining scale-out extension described in [ADR-0002](../../../../docs/adr/0002-plugin-skill-registry.md).

## Production environment

| Variable | Purpose |
| --- | --- |
| `SKILL_REGISTRY_PUBLIC_ENABLED` | Set exactly to `true` to enable anonymous public actions. Unset, `false`, typos, `0`, and every other value keep them disabled with `503 PUBLIC_REGISTRY_DISABLED`. |
| `SKILL_REGISTRY_TRUST_PROXY_CIDRS` | Comma-separated trusted proxy/CDN CIDRs. Forwarded IP headers are ignored unless the direct peer is trusted. |
| `SKILL_REGISTRY_RATE_LIMIT_STORE` | Shared cache store name for rate limiting across replicas. |
| `SKILL_REGISTRY_REQUIRE_DISTRIBUTED_BACKENDS` | Set to `true` for Kubernetes or another multi-replica deployment that cannot be inferred from `CLUSTER_MODE`; public traffic and maintenance fail closed until rate limiting, artifact storage, and operation locks are shared. Production `CLUSTER_MODE` values other than `0`/`1` enable this policy automatically. |
| `SKILL_REGISTRY_RATE_LIMIT_SECRET` | HMAC secret for pseudonymized download audit IPs. |
| `SKILL_REGISTRY_CURSOR_SECRET` | HMAC secret for public pagination cursors. |
| `SKILL_REGISTRY_STORAGE_PATH` | Persistent filesystem directory for SHA-256-addressed ZIPs. |
| `SKILL_REGISTRY_STORAGE_SHARED` | Set to `true` only when every replica mounts the same artifact volume. Required when distributed backends are required. |
| `LOCK_ADAPTER_DEFAULT` | Shared NocoBase lock adapter name (for example `redis`). A non-local adapter is required for multi-replica sync, publish, and garbage collection. |
| `SKILL_REGISTRY_DOWNLOAD_CONCURRENCY_PER_IP` | Maximum active filesystem responses per trusted client IP; default `3`, maximum `20`. |
| `SKILL_REGISTRY_DOWNLOAD_CONCURRENCY_GLOBAL` | Maximum active filesystem responses across the registry backend; default `20`, maximum `200`. |
| `SKILL_REGISTRY_DOWNLOAD_RESPONSE_TIMEOUT_MS` | Inactive response timeout; default 5 minutes. |
| `SKILL_REGISTRY_DOWNLOAD_LEASE_TTL_MS` | Safety TTL for active download counters; default 10 minutes and always longer than the response timeout. |
| `SKILL_REGISTRY_MAX_SOURCE_ITEMS` | Maximum candidates discovered from one source; default `1000`, maximum `10000`. |
| `SKILL_REGISTRY_MAX_SOURCE_FILE_BYTES` | Maximum bytes read for one provider file; default 10 MiB. |
| `SKILL_REGISTRY_MAX_SOURCE_TREE_ENTRIES` | Git Manager tree-entry ceiling before Registry ingestion; default `5000`. |
| `SKILL_REGISTRY_MAX_SOURCE_TREE_OUTPUT_BYTES` | Git Manager `ls-tree` output ceiling; default 4 MiB. |
| `SKILL_REGISTRY_SIGNING_PRIVATE_KEY` | Active Ed25519 private key in PEM format. Publishing remains unsigned when omitted. |
| `SKILL_REGISTRY_SIGNING_PUBLIC_KEY` | Active Ed25519 public key in PEM format. |
| `SKILL_REGISTRY_SIGNING_KEY_ID` | Identifier stored with newly published signatures. |
| `SKILL_REGISTRY_SIGNING_PUBLIC_KEYS` | JSON key ring, for example `{"key-2026-07":"-----BEGIN PUBLIC KEY-----..."}`. Keep prior keys here while artifacts signed by them remain installable. |
| `SKILL_REGISTRY_SYNC_LOCK_TTL_MS` | Distributed sync-lock TTL; default is 10 minutes. Configure NocoBase `lockManager` with a shared adapter for multi-replica deployments. |
| `SKILL_REGISTRY_PUBLISH_LOCK_TTL_MS` | Distributed publish/storage-lock TTL; default is 10 minutes. It serializes publish with sync for the same source and with GC for the same SHA-256 digest. |
| `SKILL_REGISTRY_MAINTENANCE_LOCK_TTL_MS` | Distributed maintenance/GC-lock TTL; default is 10 minutes. |
| `SKILL_REGISTRY_STUCK_RUN_MINUTES` | Age at which a running sync is recovered as failed; default is 60 minutes. |
| `SKILL_REGISTRY_DOWNLOAD_RETENTION_DAYS` | Retention period for pseudonymized download audit rows; default is 90 days. |
| `SKILL_REGISTRY_ORPHAN_ARTIFACT_GRACE_MINUTES` | Grace period before deleting an unreferenced filesystem artifact; default is 60 minutes. |
| `SKILL_REGISTRY_MAINTENANCE_BATCH_SIZE` | Maximum download rows or artifact candidates processed per maintenance tick; default `500`. |
| `SKILL_REGISTRY_GC_RECHECK_MINUTES` | Interval before rechecking an artifact still referenced by a version; default one day. |

Set `syncPolicy=interval` and `syncIntervalMinutes` on a source to opt it into the one-minute maintenance tick. The tick recovers stale runs before syncing due sources. Source locks serialize sync and publish, while a unique nullable `activeKey` in `skillRegistrySyncRuns` is the database backstop if a distributed-lock lease expires. Each active run also owns a fencing token and refreshes `heartbeatAt`; recovery clears that token, so a slow worker that resumes later cannot mutate source items or overwrite terminal run/source state. Publish and garbage collection use the same digest lock, and GC re-checks references inside a transaction before tombstoning and removing an artifact.

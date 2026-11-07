# Startup Guardian validation receipt

Date: 2026-11-07 (Windows / PowerShell, repository core baseline 2.2.40)

## Scope and isolated services

- No core, upstream, root, lockfile, Kubernetes manifest, or live deployment was changed. The source-level `docker/production-ha` entrypoint and app-only Compose overlay were added; no production image was built or exercised here.
- Tests used two disposable local containers only: `startup-guardian-ha-pg16-proof` (PostgreSQL 16, `127.0.0.1:55462`, database `guardian_ha_test`) and `startup-guardian-ha-redis-proof` (Redis 8, `127.0.0.1:56389`). Guardian test-specific `STARTUP_GUARDIAN_TEST_DB_*` variables selected that PostgreSQL service explicitly; Redis used `STARTUP_GUARDIAN_TEST_REDIS_URL`. No configured application DB or Redis environment was used as a fallback.
- Both exact test containers were stopped and removed after validation; a final container-name check found neither one.
- Test commands used the repository's local Node/Yarn tooling and the temporary `NODE_PATH` workaround `Join-Path $env:TEMP 'nocobase-custom-fix-deps/node_modules'` because this checkout's `@nocobase/server` workspace package is not compiled to `lib/`. Child resolution preload (`tsx` and `tsconfig-paths/register`) is test-only.

## Sequential test results

All 13 files below were run serially with `yarn test <file> --run --reporter=verbose`; server tests were not run concurrently. Result: **37 tests passed in 13 files**.

| Test file | Result | Coverage |
| --- | ---: | --- |
| `plugin-startup-guardian/src/server/__tests__/bootstrap.test.ts` | 1/1 | CLI-v1 initializer order and direct `start` argv contract using stubs. |
| `plugin-startup-guardian/src/server/__tests__/cli.test.ts` | 4/4 | Local observe/approval, explicit HA enrollment acknowledgements, and fail-closed local/shared retry commands. |
| `plugin-startup-guardian/src/server/__tests__/compatibility.test.ts` | 1/1 | Exact server-version compatibility gate. |
| `plugin-startup-guardian/src/server/__tests__/core-lifecycle-probes.test.ts` | 8/8 | Core lifecycle and disabled-plugin CLI behavior probes; constructor/static-import limits remain. |
| `plugin-startup-guardian/src/server/__tests__/journal-policy.test.ts` | 4/4 | Versioned journal, exact fingerprints, protected coordination packages, redaction, corrupt journal rejection. |
| `plugin-startup-guardian/src/server/__tests__/local-lock.test.ts` | 1/1 | Two separate local OS processes contend for one state-directory owner lock. |
| `plugin-startup-guardian/src/server/__tests__/api-acl.test.ts` | 1/1 | Real HTTP resource: anonymous denial, reader/admin controls, denied mutations leave policy/audit unchanged. |
| `plugin-startup-guardian/src/server/__tests__/runner-postgres.test.ts` | 4/4 | Real single-node child failure/quarantine/restart and core `pm:listEnabled`/`pm:listEnabledV2`; retry CAS rejects stale and +1µs admin edits; direct mandatory-dependent refusal. |
| `plugin-startup-guardian/src/server/__tests__/cluster-protocol-postgres.test.ts` | 4/4 | Shared enrollment, policy CAS/protected approvals, stale authority/fence rejection, transaction rollback, shared CLI approval/auto and HA retry refusal. |
| `plugin-startup-guardian/src/server/__tests__/cluster-runner-postgres.test.ts` | 2/2 | Two real runner/app processes: unapproved backup fault preserves healthy main; approved cohort drain/quarantine/fresh boots; exact final boot/revision HTTP readiness proof, sequential/concurrent enrollment, revision replacement and bounded boot count. |
| `plugin-cluster-manager/src/server/__tests__/recovery-api.test.ts` | 4/4 | Public core-free API path, same Redis key namespace as `RedisLockAdapter`, token verify/renew/release and stale-owner protection. |
| `plugin-cluster-manager/src/server/__tests__/recovery-api-live-redis.test.ts` | 1/1 | Isolated live Redis interoperability; Redis `GET` confirmed standalone owner token and adapter-generated owner token while each held the same namespaced key. |
| `plugin-cluster-manager/src/server/__tests__/redis-lock-adapter.test.ts` | 2/2 | Existing Redis lock adapter contention and stale-lease behavior. |

The live two-runner process test used the actual core application/plugin loader and HTTP resources. PostgreSQL test tables used unique per-test prefixes. The isolated container names and test-only DB/Redis values are recorded above; no other service container was started or stopped by these checks.

## HA implementation boundary

- HA requires an explicit, one-time `cluster init` while all app nodes are stopped, a fixed app/deployment identity and full app-node roster, and operator acknowledgement that the topology is app-only with no workers/sandboxes sharing the database. `STARTUP_GUARDIAN_CLUSTER_NO_WORKERS=true` is an operator assertion; Cluster Manager registry checks reject known non-app roles but cannot discover an unregistered external worker.
- Cluster Manager's public recovery lock API is optional at install time and API-version checked at runtime. Startup Guardian requires Cluster Manager `>=1.3.5` for this public API. Cluster Manager and HA Scheduler remain protected from quarantine.
- The coordinator drains every live/already-running enrolled boot before globally changing the core `applicationPlugins` row. A never-started enrolled peer does not block first startup. An unresponsive previously-active peer is not inferred stopped; the shared decision remains held. A committed PostgreSQL fence transition is the mutation authority boundary; Redis lease expiry alone does not prove the old app process stopped. Redis and PostgreSQL are not one atomic distributed transaction.
- Shared CLI/API supports status, inspect, exact approval and auto-recovery policy with revision CAS. HA retry is refused. App-only runner/readiness behavior is proven in the isolated two-process test. Docker source integration passed shell/Compose stub checks below; production load balancer, container image/runtime, Kubernetes, worker topology and rolling upgrades remain unverified.

## Source checks

- `yarn eslint --fix` on all touched Startup Guardian source/bin files and Cluster Manager lock API/adapter/tests — exit 0, no warnings. Log: `%TEMP%\startup-guardian-cluster-manager-eslint-final.log`.
- `yarn tsc --noEmit --pretty false -p packages/plugins/plugin-startup-guardian/tsconfig.ha-focus.json` — exit 0. The temporary config covered the Guardian runner, PG protocol, CLI/API, client v1/v2, Cluster Manager Redis adapter/API tests, and repository aliases. It used a temporary `sanitize-html` declaration to avoid the installed TypeScript 5.1 parser incompatibility in `@types/sanitize-html`; both the config and shim were removed after the check. This was a focused diagnostic, not a full-repository typecheck or declaration build. Log: `%TEMP%\startup-guardian-focused-tsc-final.log`.
- `yarn nocobase build plugin-cluster-manager --no-dts` — exit 0. Log: `%TEMP%\plugin-cluster-manager-build-final.log`.
- `yarn nocobase build plugin-startup-guardian --no-dts` — exit 0 after the shared UI move. Log: `%TEMP%\plugin-startup-guardian-build-final.log`.
- `bash -n docker/production-ha/scripts/app-runtime-entrypoint.sh` — exit 0. The entrypoint stub matrix passed default-mode install/upgrade/`yarn start`, enabled direct-runner argv and ordering, unknown-mode and worker-role refusal, missing registry configuration refusal, and exact-core-version refusal. Log: `%TEMP%\startup-guardian-docker-entrypoint-smoke-final.log`.
- `docker compose --profile node1 --profile node2 -f docker-compose.app-ha.yml -f docker-compose.startup-guardian.yml config` — passed with dummy, isolated interpolation values in both default-off and `redis-postgres` mode. It confirmed the operator-supplied image, two app-only roles, Guardian/Cluster Manager presets, entrypoint bind mount and command. No container was created. Log: `%TEMP%\startup-guardian-docker-compose-smoke.log`.
- `npm pack` succeeded for `plugin-cluster-manager@1.3.5` at `packages/plugins/plugin-cluster-manager/plugin-cluster-manager-1.3.5.tgz` (2.1 MB) and `plugin-startup-guardian@0.1.0` at `packages/plugins/plugin-startup-guardian/plugin-startup-guardian-0.1.0.tgz` (124.6 kB). SHA-256 hashes are kept in the final task receipt, not inside the packed documentation; these are local pre-release validation snapshots.
- Cluster Manager's patch version moved from `1.3.4` to `1.3.5` for the new public recovery API. The repository workflow creates plugin tags/releases and publishes npm packages after a package-path push; that external CI result is tracked separately from these local checks. Startup Guardian declares `plugin-cluster-manager >=1.3.5` as an optional peer and checks the API protocol version at runtime.
- Both package manifests and tar listings were checked. The Guardian archive contains `README.md`, `IMPLEMENTATION_PLAN.md`, `VALIDATION.md`, the bin scripts, locale bundles, client v1/v2 and server output; Cluster Manager includes the public `recovery.js`/`.d.ts` and shared `redis-lock-core.js`/`.d.ts`. The generated `externalVersion.js` files record the workspace's NocoBase server/database baseline as `2.2.40`.
- Extracted Guardian `status` and `inspect` commands returned valid JSON with `NODE_PATH` empty and no NocoBase app. Extracted Cluster Manager `recovery.js` loaded API version 1 and the declared `redis` dependency without importing NocoBase core; Redis resolution for this import smoke used the workspace `node_modules`, so this is not a clean install proof. Smoke outputs: `%TEMP%\startup-guardian-extracted-status-final.json`, `%TEMP%\startup-guardian-extracted-inspect-final.json`, and `%TEMP%\cluster-manager-extracted-recovery-final.json`. The temporary extraction directories were removed after the checks.
- The v2 client now imports the neutral `src/shared/StartupGuardianPage.tsx`; no `src/client` component or `@nocobase/client` import is used by the v2 source tree. The build log lists only `@nocobase/client-v2` and `@nocobase/flow-engine` as NocoBase v2 client externals.

## Remaining limits

- Single-node automatic recovery is gated to PostgreSQL and exact `@nocobase/server` `2.2.40`; PostgreSQL 16 is the only exercised DB baseline.
- App-only HA is an opt-in, source/test-validated slice, not production HA approval. The new Docker overlay requires an operator-supplied image and exact installed core gate; that image and its runtime have not been verified.
- Browser interaction, visual behavior, accessibility, and full v1/v2 UI flow were not verified.
- Only direct mandatory dependencies are checked; transitive dependency closure and the complete transaction/journal/IPC/child failure matrix remain incomplete.
- Core static imports still execute before database enabled state is read. Constructor, `afterAdd`, `afterStart`, and early import failures are not auto-attributed or sandboxed.
- No release, publication, deployment, commit, or push occurred.

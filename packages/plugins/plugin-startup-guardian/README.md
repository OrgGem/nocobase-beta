# Startup Guardian

Startup Guardian records failures from a bounded set of plugin lifecycle methods and can supervise a NocoBase app process. It does not sandbox plugins or prevent static imports.

## Supported modes and limits

- Default mode is observe-only. Single-node automatic recovery is enabled only for `DB_DIALECT=postgres` and exact `@nocobase/server` `2.2.40`; the adapter was exercised against PostgreSQL 16, schema `public`, and a non-empty table prefix. Other versions and dialects refuse automatic recovery.
- An opt-in `redis-postgres` mode coordinates a declared set of app-serving nodes through PostgreSQL control tables and Cluster Manager's public Redis lock API. It is a bounded app-only candidate, not a general NocoBase HA integration: PostgreSQL 16, Redis 8, two app processes, and the two-node fault paths described in [VALIDATION.md](./VALIDATION.md) were exercised. `docker/production-ha` now has a default-off app-only overlay and direct-runner entrypoint path with shell/Compose stub checks; the operator image and production runtime remain untested. See the [Docker HA setup](../../../docker/production-ha/README.md#optional-startup-guardian-app-only-overlay).
- HA mode requires Cluster Manager `>=1.3.5` and its recovery lock API version 1. The peer is optional for single-node installs; HA startup refuses a missing or incompatible API.
- In either mode, the Guardian runner must be the direct parent of the NocoBase app process. Do not put Yarn, PM2, Docker restart loops, or another app supervisor between them. A local filesystem owner lock excludes a second Guardian using the same state directory. Use a distinct local state directory per node; never put the local owner lock on shared storage. An existing or uncertain lock fails closed. After a crash, inspect the recorded PID and command before manually removing `runner-owner.lock`.
- The runner's state directory must be persistent local storage with restricted permissions. Set `NODE_MODULES_PATH` so dependency metadata for enabled plugins can be read; uncertain dependency information blocks quarantine.
- Run install and upgrade commands before starting Guardian. The Guardian control collections must already exist; normal HA startup does not create schema. A failed install, upgrade, or migration is not treated as a plugin failure.

Observe mode records an incident and leaves plugin state unchanged. The runner stops the failed child and remains alive but unready in `recovery-required`, so an external restart loop does not consume attempts. Automatic quarantine requires explicit opt-in and an exact approved rule for plugin name, package, version, phase, and failure fingerprint.

## Single-node bootstrap

Build and install this package in the app, run the normal install/upgrade gate, then use a direct runner invocation in place of the normal `yarn start` process:

```sh
node --preserve-symlinks ./node_modules/plugin-startup-guardian/bin/startup-guardian.cjs start \
  --app-id main --deployment-id single-node -- \
  node --preserve-symlinks ./node_modules/plugin-startup-guardian/bin/nocobase-child.cjs
```

The child command uses argument arrays without a shell. `nocobase-child.cjs` calls the CLI-v1 `initEnv()` and `generateAppDir()` initializers, sets app argv to `start`, then loads `@nocobase/app` in that process. The child inherits the app's database and NocoBase environment. The default journal path is under `${STORAGE_PATH:-storage}/.startup-guardian/<app-id>/<deployment-id>`. Keep `STARTUP_GUARDIAN_APP_ID`, `STARTUP_GUARDIAN_DEPLOYMENT_ID`, and the local state directory consistent for every operator CLI call.

This package-owned bootstrap argv contract was checked with a stub fixture. The command has not been exercised inside the production image.

## Opt-in app-only HA mode

Use this mode only when every process that can load the same `applicationPlugins` state is an app-serving node included in the roster. Guardian does not support queue workers, background workers, sandboxes, or other shared-database processes in this mode. The operator acknowledgement below is not service discovery: Cluster Manager's runtime registry rejects reported non-app/worker/sandbox roles, but cannot prove that an unregistered external worker does not exist.

1. Install/upgrade Startup Guardian and Cluster Manager on every app node, then run the host upgrade so `startupGuardianClusterState` and `startupGuardianClusterMembers` exist. Do not start HA mode before this schema gate.
2. Stop every app-serving node. From the installed app environment, initialize exactly one deployment and its complete app-node roster. The flags are explicit operator declarations; Guardian does not infer that every node is stopped or that workers are absent:

   ```sh
   node ./node_modules/plugin-startup-guardian/bin/startup-guardian.cjs cluster init \
     --app-id main --deployment-id production --members main,backup \
     --all-app-nodes-stopped --app-only
   ```

   Initialization is one-time. An existing enrollment is refused; roster changes require a separately planned all-nodes-stopped maintenance procedure.
3. Configure the same values on every app runner and its child. Use a unique stable `STARTUP_GUARDIAN_NODE_ID` for each roster member. `LOCK_ADAPTER_REDIS_URL` supplies the shared recovery lock; `NODE_REGISTRY_REDIS_URL` must reach the Cluster Manager registry used by those nodes. `STARTUP_GUARDIAN_CLUSTER_NO_WORKERS=true` is an operator assertion made only after checking every process with access to the shared application database.

   ```text
   STARTUP_GUARDIAN_CLUSTER_MODE=redis-postgres
   STARTUP_GUARDIAN_APP_ID=main
   STARTUP_GUARDIAN_DEPLOYMENT_ID=production
   STARTUP_GUARDIAN_CLUSTER_MEMBERS=main,backup
   STARTUP_GUARDIAN_NODE_ID=main       # use backup on the backup node
   STARTUP_GUARDIAN_CLUSTER_NO_WORKERS=true
   LOCK_ADAPTER_REDIS_URL=redis://<shared-lock-redis>:6379
   NODE_REGISTRY_REDIS_URL=redis://<cluster-manager-registry-redis>:6379
   DB_DIALECT=postgres
   ```

   The application must still be `@nocobase/server` `2.2.40`; Redis URL configuration, PostgreSQL settings, and `NODE_MODULES_PATH` must be available to both runner and child. Start each app with the same direct-child pattern as single-node mode. Do not wrap the app in PM2 or another restart owner.
4. Leave auto-recovery off initially. Shared `cluster status` and `cluster inspect` show the database-backed decision and per-node boots. To approve an observed incident and separately opt in, use its event ID and the current policy revision from `cluster inspect`:

   ```sh
   node ./node_modules/plugin-startup-guardian/bin/startup-guardian.cjs cluster approve <event-id> \
     --expected-policy-revision <revision>
   node ./node_modules/plugin-startup-guardian/bin/startup-guardian.cjs cluster auto on \
     --expected-policy-revision <new-revision>
   ```

   Stale policy revisions are refused. Automatic recovery remains limited to exact approvals; `plugin-cluster-manager`, `plugin-ha-scheduler`, Guardian, and core packages cannot be approved. HA `retry` is intentionally unsupported; restoring a quarantined package requires a whole-cohort maintenance procedure.

Before a shared `applicationPlugins` change, the coordinator publishes a drain revision and requires every live/already-running enrolled app boot to acknowledge that it stopped. An enrolled node that has never started does not block the other node's first boot. A previously active or unresponsive node that cannot be proven stopped holds the decision; do not infer process death from a Redis lease timeout. A successful PostgreSQL fence transition is the authoritative boundary that rejects a stale coordinator's later writes. Redis locking and PostgreSQL transactions are not one distributed atomic transaction, and this is not transparent failover.

An unapproved or observe-only failure on one node leaves a healthy peer serving. A committed quarantine changes the shared plugin row and requires each enrolled app node to start a fresh child at the decision revision before its readiness endpoint returns HTTP 200. This protects the tested app-only cohort; no production load balancer, Docker image/runtime, Kubernetes controller, worker topology, or rolling-upgrade integration has been validated.

## Operator CLI

The compiled CLI can inspect local state while the app UI is unavailable. `status`, `inspect`, `approve`, `auto`, and `retry` do not initialize CLI-v1 or import the NocoBase app; `start` loads the supervisor lazily.

```sh
node ./node_modules/plugin-startup-guardian/bin/startup-guardian.cjs status
node ./node_modules/plugin-startup-guardian/bin/startup-guardian.cjs inspect
node ./node_modules/plugin-startup-guardian/bin/startup-guardian.cjs approve <event-id>
node ./node_modules/plugin-startup-guardian/bin/startup-guardian.cjs auto on
node ./node_modules/plugin-startup-guardian/bin/startup-guardian.cjs auto off
node ./node_modules/plugin-startup-guardian/bin/startup-guardian.cjs retry <package-name> --expected-revision <revision>

node ./node_modules/plugin-startup-guardian/bin/startup-guardian.cjs cluster status
node ./node_modules/plugin-startup-guardian/bin/startup-guardian.cjs cluster inspect
```

Local CLI policy and retry commands are rejected when HA mode is selected; use `cluster approve` and `cluster auto` for shared policy. HA `cluster retry` returns a clear unsupported message. Local commands default to `main` / `single-node`, matching the bootstrap example. Set `STARTUP_GUARDIAN_APP_ID`, `STARTUP_GUARDIAN_DEPLOYMENT_ID`, and, for HA, the roster/node/Redis variables on every invocation so the CLI addresses the intended database identity.

The attempt counter is durable across runner restarts. Single-node retry uses the exact original row identity and `updatedAt::text` token; an administrator edit of `+1µs`, even within the same millisecond, causes retry to fail closed.

## Administration UI and permissions

The server plugin registers `pm.plugin-startup-guardian.read` for status/incidents and `pm.plugin-startup-guardian.manage` for approval, auto-recovery changes, and retry. HA mode exposes shared status/inspect and revision-checked approval/auto controls; retry is hidden and refused. The v1 and v2 screens use the same resource contract and have English and Simplified Chinese strings. The resource API accepts no shell command or filesystem path.

## Lifecycle and recovery limits

The plugin wraps `beforeLoad`, `loadCollections`, `loadAI`, and `load` after plugin instances have been initialized. It rethrows the original plugin error so the partially initialized app is not reused. Constructor, `afterAdd`, application-level listeners before Guardian registration, `afterStart`, and package static-import errors are not auto-attributed. A disabled DB row prevents instance initialization and removes the package from the core v1/v2 enabled-plugin APIs, but static imports can still execute before DB state is read.

Quarantine changes only the matching installed, non-built-in `applicationPlugins.enabled` value. It preserves version, installation state, and options, and stores the prior row identity and exact timestamp for guarded retry. If another enabled plugin declares the target as a mandatory direct dependency, if the DB row changes, if the journal is invalid, or if an exact rule does not match, recovery stops safely. Transitive dependency closure and plugin import sandboxing are not implemented.

See [VALIDATION.md](./VALIDATION.md) for exact source/test/artifact evidence and limits. The extracted package smoke is not a clean host install or production runtime test. Docker entrypoint checks are source-level stub tests, not a container image or production failover test.

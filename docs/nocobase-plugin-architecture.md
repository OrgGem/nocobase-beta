# NocoBase App & Plugin Architecture (custom-plugin development reference)

A working survey of how this monorepo is wired, focused on what a custom plugin must
follow. Sampled: core plugins `@nocobase/plugin-file-manager`, `@nocobase/plugin-acl`;
custom plugins `plugin-ai-api`, `plugin-user-memory`. Read-only packages are treated as
contracts to inspect, never to patch.

## 1. Repo layout

```
packages/
  core/                    # @nocobase/* framework — READ ONLY
    server/                # Plugin base class (server), app lifecycle
    client-v2/             # @nocobase/client-v2 — Plugin base class (modern client), FlowEngine/FlowModel
    client/                # @nocobase/client — legacy v1, SchemaComponent/Formily
    database/              # defineCollection, Repository, DataTypes
    resourcer/             # ResourceOptions, REST routing
  plugins/
    @nocobase/             # upstream open-source plugins — READ ONLY
    plugin-<name>/         # custom plugins (this project's work) — writable
    pro-plugins/           # pro plugins cloned as standalone git repos
```

`plugin-sub-agent` referenced by AGENTS.md as the package.json template **does not exist**
on disk. Use `plugin-user-memory` as the live minimal reference and `plugin-ai-api` as the
full-featured reference. (Flagged so the rule can be updated or the plugin re-added.)

## 2. Plugin directory contract (v2)

A custom plugin at `packages/plugins/<plugin-name>/` has this shape:

```
<plugin-name>/
  package.json
  src/
    index.ts                 # re-export (often just server/client barrels)
    constants.ts             # shared: ACL snippets, prefixes, defaults
    server/
      index.ts               # export { default } from './plugin'
      plugin.ts              # class PluginXxxServer extends Plugin  (@nocobase/server)
      collections/*.ts       # defineCollection({ name, fields, ... })
      resource/*.ts          # ResourceOptions with custom actions
      services/*.ts          # business logic, framework-agnostic
      routes/*.ts            # raw HTTP routers (non-CRUD endpoints, e.g. the LLM proxy)
      actions/*.ts           # resource action handlers
      middleware/*.ts
      migrations/*.ts        # ONLY for column/index/table changes (see §6)
      __tests__/*.test.ts
    client-v2/               # modern client runtime (default for new UI)
      index.ts / index.tsx
      plugin.tsx             # class PluginXxxClient extends Plugin (@nocobase/client-v2)
      pages/*.tsx
      components/*.tsx
      models/*.ts            # FlowModel definitions when needed
      locale.ts
    client/                  # legacy v1 runtime (only if v1 parity required)
      index.tsx
      plugin.tsx             # SchemaComponent-based
    locale/
      en-US.json  zh-CN.json  vi-VN.json
```

Both clients register a class extending their own `Plugin` base and implement
`async load()`. The class name is conventionally `Plugin<PascalName>Server` /
`Plugin<PascalName>Client`. `server/index.ts` re-exports the server plugin; the client
entry barrels the client plugin. The app auto-loads the right entry per runtime.

## 3. Server plugin lifecycle (`@nocobase/server`)

```
afterAdd()   -> beforeLoad() -> load() -> start() -> installed()/afterInstall()
```

- `beforeLoad()`: register DB hooks before sync. Standard pattern in `plugin-ai-api`:
  `this.app.db.on('<collection>.beforeSave', handler)` for validation, uniqueness, cache
  invalidation.
- `load()`: register collections are auto-synced; wire custom resources, middleware, ACL
  snippets, cron/GC intervals here.
- `this.db` / `this.app.db`: database handle. `this.app.im` (or `this.db.getRepository(name)`)
  for repositories.
- Teardown intervals in the plugin's unload/uninstall overrides (`this.gcInterval` etc.).

### Collections

`collections/<name>.ts` uses `defineCollection` from `@nocobase/database`:

```ts
import { defineCollection } from '@nocobase/database';
export default defineCollection({
  name: 'aiApiConfig',        // camelCase collection name == repository name
  autoGenId: true,
  fields: [
    { name: 'mode', type: 'string', defaultValue: 'llm' },
    { name: 'options', type: 'jsonb', defaultValue: {} },
  ],
});
```

New collections/columns/indexes are auto-synced by `yarn nocobase upgrade` (and at docker
start) — **no migration file needed for pure additions**. Column types from `DataTypes`.

### Resources (REST actions)

`resource/<name>.ts` exports a `ResourceOptions` object. Use when you need custom action
names or singleton-shaped config resources (the built-in `update` demands
`filter`/`filterByTk`, so singletons register a custom `save`/`get`):

```ts
import { ResourceOptions } from '@nocobase/resourcer';
const xxxResource: ResourceOptions = {
  name: 'aiApiConfig',
  actions: {
    async get(ctx, next) { /* read-or-create singleton */ ctx.body = config; await next(); },
    async save(ctx, next) { /* validate + upsert */ },
  },
};
export default xxxResource;
```

Register in `plugin.ts` `load()` via `this.app.resourcer.define(...)` (or the plugin's
resource registration helper). Non-CRUD HTTP endpoints (LLM proxy, webhooks) go through
`routes/*.ts` with a koa router instead.

## 4. Client-v2 plugin (`@nocobase/client-v2`)

```ts
import { Plugin, Application } from '@nocobase/client-v2';

export class PluginAiApiClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({ key, title: this.t('...'), icon, aclSnippet });
    this.pluginSettingsManager.addPageTabItem({ menuKey, key, title, aclSnippet, sort,
      componentLoader: () => import('./pages/SomePage') });
  }
}
export default PluginAiApiClient;
```

Key points:
- Settings UI uses `pluginSettingsManager.addMenuItem` + `addPageTabItem` with lazy
  `componentLoader` (code-split page import).
- Every menu/tab carries an `aclSnippet` for permission gating.
- To add a role-permission tab: `this.app.pm.get('@nocobase/plugin-acl')` then
  `.settingsUI.addPermissionsTab({ ... })` (guard the cast with a narrow interface — no `as any`).
- Pages are plain React + antd v5; FlowModel/`models/` only when a model-driven surface is needed.

### Dual-runtime rule

Two client runtimes exist (legacy v1 at `/`, modern v2 at `/v/`; see `CONTEXT.md`).
- **v2 must NEVER import from v1 (`@nocobase/client`). v1 MAY import from v2.**
- New custom plugins default to `client-v2` only. Build `client/` (v1) only when explicit
  v1 parity is required — do not sync v1 reflexively.

## 5. ACL & naming

- ACL snippets are centralized in `src/constants.ts` (e.g. `AI_API_ACL_SNIPPET`,
  `pm.<feature>.admin`) and reused by both server resources and client menus.
- Collection/repository names are camelCase (`aiApiConfig`); route/resource `name` matches.
- i18n: every user-facing string through `this.t(...)` / `useTranslation`, with keys added
  for `en-US` **and** `zh-CN` (and `vi-VN` in this repo) locale JSON.

## 6. Migrations & DB changes

- Pure new collections / new columns / new indexes: **no migration** — auto-synced on upgrade.
- **Changes to existing** tables/columns/indexes (rename, type change, drop, backfill):
  ship a migration under `src/server/migrations/`, import column types from `DataTypes`.

## 7. package.json (custom plugin)

Follow `plugin-user-memory`/`plugin-ai-api`: top-level `name`, `displayName*`,
`description`, `version`, `license`, `main`, `keywords`, `files`,
`nocobase.supportedVersions`, `nocobase.editionLevel`, runtime `peerDependencies`.
Do **not** add top-level `types`/`devDependencies` unless proven required.

## 8. Tooling (Windows — this machine)

- `yarn test` / `yarn eslint` wrappers are broken here. Run vitest / eslint directly.
  - Server tests MUST set `TEST_ENV=server-side`, one file per invocation,
    `--no-file-parallelism`. Client tests: same without `TEST_ENV`.
  - Lint only touched files (untouched files are CRLF and flood `Delete ␍` noise).
  - `--fix` invalidates `dist/` — rebuild after fixing.
- Build/pack prefer PowerShell: `yarn nocobase build <plugin> --no-dts` then `npm pack`
  from the plugin dir. Verify `dist/server/index.js`, `dist/client-v2/...`, locales,
  `dist/externalVersion.js` before reporting success. Never pack after a failed build.

## 9. Build order / dependency direction

`packages/core/*` → `packages/plugins/@nocobase/*` → custom plugins. Custom plugins import
the `@nocobase/*` runtime packages (peer deps) and may read other plugins' public contracts
(`this.app.pm.get(name)` guarded), but never patch them.

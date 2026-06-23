# How To Use `plugin-setup-architecture.md`

This file is the short entrypoint for agents that need to understand or build
NocoBase plugins in this repository.

The repository is now on NocoBase 2.1.x. The old notes were written against the
2.0.x shape, where most client work meant `src/client` plus
`SchemaComponent`/schema initializers. In 2.1.x that is still valid for the
legacy v1 client, but new client work must first decide whether it belongs to
legacy v1 or to client-v2.

## First Decision: Which Runtime?

1. If the file path is `src/client/`, use the legacy v1 client APIs from
   `@nocobase/client`.
2. If the file path is `src/client-v2/`, use `@nocobase/client-v2` and
   `@nocobase/flow-engine`.
3. v1 client code may import from client-v2 because `@nocobase/client` now wraps
   the client-v2 base plugin/application skeleton.
4. client-v2 code must never import from `@nocobase/client`.
5. A plugin with only `client.js` is legacy-client only. It will not be loaded by
   the v2 remote plugin lane unless it also has `client-v2.js` and
   `dist/client-v2/index.js`.

## Reading Order

1. Read **2.1.x Delta From 2.0.x** in `plugin-setup-architecture.md`.
2. Read **Runtime And Bundle Map** to identify the correct entrypoint.
3. Read **Plugin Lifecycle** for server/client hook order.
4. Pick the cookbook section that matches the task:
   - v2 settings/admin page: cookbook 2
   - v2 block: cookbook 3
   - v2 action: cookbook 4
   - v2 field: cookbook 5
   - server collections/migrations/resources/ACL: cookbook 6-8
   - cross-plugin extension: cookbook 9
   - workflow/notification/file/AI: cookbook 10
   - mobile/public/embed or localization: cookbook 11-12
   - legacy v1 schema initializer/settings work: cookbook 13
5. For action, field, and custom table block work, also read
   `plugin-setup-actionfield-architecture.md`.

## Quick Rules For 2.1.x

- Prefer client-v2 for new UI unless the target plugin/file is already legacy
  v1-only.
- client-v2 plugin entrypoints live in `src/client-v2/index.ts(x)` and usually
  export `default` from `./plugin`.
- client-v2 packages need the root runtime marker `client-v2.js`; keep
  `client-v2.d.ts` as the matching package type wrapper. The server exposes the
  v2 lane only when `client-v2.js` or an app-dev v2 URL exists.
- client-v2 remote modules are loaded as `<packageName>/client-v2` from
  `dist/client-v2/index.js`.
- In client-v2, schema initializer/settings menus are not the main extension
  path. Use `FlowModel.define(...)`, `registerFlow(...)`, model bindings, and
  action/block/field model registries.
- Use `flowEngine.registerModelLoaders(...)` for heavier v2 models and
  `flowEngine.registerModels(...)` for small/eager models.
- Settings pages in client-v2 use `pluginSettingsManager.addMenuItem(...)`
  followed by `addPageTabItem(...)`; `pluginSettingsManager.add(...)` is a v1
  pattern.
- Field interfaces in client-v2 are classes extending
  `CollectionFieldInterface` from `@nocobase/client-v2`; register them with
  `app.addFieldInterfaces(...)`.
- Field renderers are `FlowModel` classes bound with
  `EditableItemModel.bindModelToInterface`,
  `DisplayItemModel.bindModelToInterface`, `FilterableItemModel...`, or
  block-specific item models.
- Action buttons are `ActionModel` classes with `static scene`,
  `defaultProps`, `getAclActionName()`, `define(...)`, and `registerFlow(...)`.
- Blocks are `BlockModel`/`CollectionBlockModel` subclasses with
  `renderComponent()`, `define(...)`, optional `static scene`, and optional
  `customModelClasses`.
- Server plugin lifecycle is mostly unchanged, but the base plugin now
  auto-loads `server/collections`, `server/migrations`, and AI assets under
  `ai/` through standard loaders. Use explicit `db.addMigrations(...)` only for
  non-standard locations or special context.

## Server Rules That Still Matter

- Put model/repository/operator registration and early DB/data-source hooks in
  `beforeLoad()`.
- Put resources, action handlers, ACL snippets/allows, middleware, runtime
  service wiring, and plugin-to-plugin integration in `load()`.
- Put default seed data in `install()` and keep it idempotent.
- Use `app.resourceManager`, not deprecated `app.resourcer`, for new resource
  code.
- Use `dataSourceManager.beforeAddDataSource(...)` or
  `afterAddDataSource(...)` when every data source must receive a field type,
  action handler, ACL action, or middleware.
- Runtime caches/state shared across nodes need an explicit sync path:
  `sendSyncMessage/handleSyncMessage`, PubSub, Redis keys with TTL, or a lock.

## Common Pitfalls

- Do not copy v1 `schemaInitializerManager.addItem(...)` code into
  `src/client-v2`; it will not be the natural v2 insertion path.
- Do not use `@nocobase/client` imports from `src/client-v2`.
- Do not assume a plugin with `src/client-v2` is exposed remotely unless the
  root `client-v2.js` marker exists and the build produced
  `dist/client-v2/index.js`.
- If a v2 settings menu has tabs, register the parent menu first. The menu key
  cannot contain `.`; page names are derived as `<menuKey>.<pageKey>`.
- If an action/field/block model should be discoverable lazily, register a
  model loader and make sure the loaded module exports the model class.
- Keep server and client `type`, provider ID, field interface name, action name,
  or workflow instruction name identical when both sides participate.
- For legacy v1 custom block initializer items, if an item does not render in
  the old "Add block" dropdown, test whether removing `type: 'item'` fixes it.
  This is a v1 compatibility pitfall, not a client-v2 rule.

---

## Plugin Review — Architecture Compliance Audit (2.1.x)

This section documents the review of all 45 custom plugins under
`packages/plugins/` (excluding `@nocobase/` scoped plugins). Each plugin is
assessed against the 2.1.x architecture requirements.

### Reference Plugin (Gold Standard)

**`plugin-user-memory`** — the only plugin with full client-v2 compliance:

```
files: [dist, src, client.js, client-v2.js, server.js, client.d.ts, client-v2.d.ts, server.d.ts]
peerDependencies:
  @nocobase/client: 2.x
  @nocobase/client-v2: 2.x
  @nocobase/flow-engine: 2.x
  @nocobase/server: 2.x
  @nocobase/plugin-ai: 2.x
nocobase:
  supportedVersions: [2.x]
  editionLevel: 0
src/: client/, client-v2/, server/, locale/
```

**`plugin-document-understanding`** — also has client-v2:
```
files: [dist, client.js, client.d.ts, client-v2.js, client-v2.d.ts, server.js, server.d.ts, ...]
peerDependencies includes @nocobase/client-v2 and @nocobase/flow-engine
src/: client/, client-v2/, server/, locale/
```

---

### Compliance Categories

#### Category A: COMPLIANT (has client-v2 markers)

Only 2 out of 45 plugins:

| Plugin | Status |
|--------|--------|
| plugin-user-memory | Full v2 (client.js + client-v2.js + client-v2.d.ts) |
| plugin-document-understanding | Full v2 (client.js + client-v2.js + client-v2.d.ts) |

#### Category B: PARTIALLY COMPLIANT (package.json correct, missing client-v2)

These plugins have correct `nocobase.supportedVersions: [2.x]`, proper `files`
array, and no `devDependencies` bloat, but only ship legacy v1 client:

| Plugin | Issue |
|--------|-------|
| plugin-agent-orchestrator | No client-v2; has UI (settings tabs) |
| plugin-ai-browser | No client-v2; has block + initializer |
| plugin-ai-drawio | No client-v2; has block + initializer |
| plugin-block-embed-settings | No client-v2; has block UI |
| plugin-block-proxy | No client-v2; has block UI |
| plugin-build-guide-block | No client-v2; has block UI |
| plugin-build-ui-template | No client-v2; has client UI |
| plugin-build-visualization-block | No client-v2; has client UI |
| plugin-cluster-manager | No client-v2; has settings UI |
| plugin-comm-core | No client-v2; has client UI |
| plugin-custom-llm | No client-v2; has client settings |
| plugin-data-cloner | No client-v2; has client UI |
| plugin-data-source-elasticsearch | No client-v2; has client config |
| plugin-data-source-mssql | No client-v2; has client config |
| plugin-git-manager | No client-v2; has client UI |
| plugin-markitdown-parser | No client-v2; minimal client |
| plugin-n8n | No client-v2; has settings UI |
| plugin-ocr-verify-block | No client-v2; has block UI |
| plugin-package-registry | No client-v2; has client UI |
| plugin-skill-creator | No client-v2; has client UI |
| plugin-skill-pptx-advanced | No client-v2; has client UI |
| plugin-sub-agent | No client-v2; has client UI |
| plugin-team-chat | No client-v2; has client UI |
| plugin-user-presence | No client-v2; has client UI |
| plugin-visualization-templates | No client-v2; has client UI |

#### Category C: NON-COMPLIANT (package.json issues + missing client-v2)

These plugins have structural issues in `package.json` beyond missing client-v2:

| Plugin | Issues |
|--------|--------|
| plugin-ai-api | Missing `files`, missing `nocobase` field |
| plugin-ai-chat-file-preview | Missing `files`, missing `editionLevel` |
| plugin-antd-style-theme | Missing `files`, missing `nocobase`, heavy `devDependencies` |
| plugin-block-cross-join | Missing `nocobase` field, `devDependencies` in manifest |
| plugin-carbone-template-manager | Missing `editionLevel`, `devDependencies` in manifest |
| plugin-docpixie | Uses `./dist/server/index.js` (inconsistent main path) |
| plugin-document-parser | Missing `editionLevel` |
| plugin-dummy | Missing `files`, missing `nocobase` |
| plugin-embed-web-client | Missing `nocobase` field |
| plugin-external-storage-manager | Missing `nocobase` field, `devDependencies` in manifest |
| plugin-field-selection-filter | Missing `files`, missing `nocobase` |
| plugin-file-preview-auth | Missing `nocobase` field |
| plugin-knowledge-base | Missing `nocobase` field |
| plugin-next-app-client | Missing `nocobase` field |
| plugin-s3-private-storage | Missing `nocobase` field, `devDependencies` in manifest |
| plugin-sftp-private-storage | Missing `nocobase` field, `devDependencies` in manifest |
| plugin-shared-forms | Missing `files`, missing `nocobase` |
| plugin-uipath-orchestrator | `devDependencies` in manifest, uses deprecated `@nocobase/resourcer` peer |

---

### Issue Breakdown

#### Issue 1: Missing `nocobase` field in package.json

**Required structure:**
```json
{
  "nocobase": {
    "supportedVersions": ["2.x"],
    "editionLevel": 0
  }
}
```

**Affected (14 plugins):**
plugin-ai-api, plugin-antd-style-theme, plugin-block-cross-join,
plugin-dummy, plugin-embed-web-client, plugin-external-storage-manager,
plugin-field-selection-filter, plugin-file-preview-auth,
plugin-knowledge-base, plugin-next-app-client, plugin-s3-private-storage,
plugin-sftp-private-storage, plugin-shared-forms, plugin-uipath-orchestrator

**Fix:** Add the `nocobase` field to each plugin's `package.json`.

#### Issue 2: Missing `files` array in package.json

**Required structure:**
```json
{
  "files": [
    "dist",
    "src",
    "client.js",
    "server.js",
    "client.d.ts",
    "server.d.ts"
  ]
}
```

**Affected (7 plugins):**
plugin-ai-api, plugin-ai-chat-file-preview, plugin-antd-style-theme,
plugin-dummy, plugin-field-selection-filter, plugin-shared-forms,
plugin-block-cross-join (implicit — no files field)

**Fix:** Add explicit `files` array. Include `client-v2.js` and
`client-v2.d.ts` if adding client-v2 support.

#### Issue 3: `devDependencies` in plugin package.json

Plugin manifests should use `peerDependencies` for framework deps. Runtime
dependencies that are not NocoBase core go in `dependencies`. Build-only deps
like `@formily/*`, `antd`, `react` should NOT be in `devDependencies` of the
plugin manifest — they are provided by the host application at runtime.

**Affected (7 plugins):**
plugin-antd-style-theme, plugin-block-cross-join, plugin-visualization-templates,
plugin-uipath-orchestrator, plugin-s3-private-storage,
plugin-sftp-private-storage, plugin-external-storage-manager

**Fix:** Remove `devDependencies` from plugin `package.json`. These packages are
provided by the NocoBase host application. If a package is genuinely needed at
runtime and not provided by the host, move it to `dependencies`.

#### Issue 4: Deprecated peer dependency `@nocobase/resourcer`

**Affected:** plugin-uipath-orchestrator, plugin-n8n

**Fix:** Replace `@nocobase/resourcer` with `@nocobase/server` (which now
includes resource management via `app.resourceManager`).

#### Issue 5: Inconsistent `main` field format

Some use `./dist/server/index.js`, others use `dist/server/index.js`.

**Affected:** plugin-docpixie, plugin-data-source-elasticsearch,
plugin-data-source-mssql, plugin-embed-web-client, plugin-external-storage-manager,
plugin-knowledge-base, plugin-n8n, plugin-s3-private-storage,
plugin-sftp-private-storage, plugin-uipath-orchestrator, plugin-cluster-manager,
plugin-block-cross-join

**Fix:** Standardize to `dist/server/index.js` (no leading `./`).

#### Issue 6: Missing client-v2 runtime (43 out of 45 plugins)

Only `plugin-user-memory` and `plugin-document-understanding` have client-v2.
All other plugins with UI components need migration planning.

**Priority tiers for client-v2 migration:**

**Tier 1 — High priority (has complex UI blocks/settings):**
- plugin-agent-orchestrator (multi-tab settings page)
- plugin-ai-browser (custom block + initializer)
- plugin-ai-drawio (custom block + initializer)
- plugin-cluster-manager (settings + monitoring UI)
- plugin-team-chat (full chat UI)
- plugin-ocr-verify-block (custom block)
- plugin-visualization-templates (chart templates)
- plugin-antd-style-theme (theme editor UI)

**Tier 2 — Medium priority (settings pages):**
- plugin-custom-llm (LLM config page)
- plugin-n8n (integration settings)
- plugin-uipath-orchestrator (orchestrator config)
- plugin-data-source-elasticsearch (connection config)
- plugin-data-source-mssql (connection config)
- plugin-knowledge-base (KB management)
- plugin-package-registry (registry UI)
- plugin-git-manager (git operations UI)

**Tier 3 — Low priority (minimal/no UI):**
- plugin-sub-agent (thin client, mostly server)
- plugin-comm-core (infrastructure, minimal UI)
- plugin-user-presence (status indicator only)
- plugin-markitdown-parser (server-only with thin config)
- plugin-document-parser (server-heavy)
- plugin-skill-creator (simple form)
- plugin-skill-pptx-advanced (server-only with config)
- plugin-data-cloner (simple action UI)
- plugin-dummy (placeholder)

---

### Migration Checklist: Adding client-v2 to an Existing Plugin

For each plugin that needs client-v2 support, follow this sequence:

```
1. Create src/client-v2/index.ts(x)
   └── export { default } from './plugin';

2. Create src/client-v2/plugin.ts(x)
   └── import { Plugin } from '@nocobase/client-v2';
   └── export class MyPluginV2 extends Plugin { ... }

3. Create root marker: client-v2.js
   └── module.exports = require('./dist/client-v2/index.js');

4. Create root type wrapper: client-v2.d.ts
   └── export * from './dist/client-v2';
   └── export { default } from './dist/client-v2';

5. Update package.json:
   └── Add to "files": "client-v2.js", "client-v2.d.ts"
   └── Add peerDependencies:
       "@nocobase/client-v2": "2.x",
       "@nocobase/flow-engine": "2.x"

6. Migrate UI components:
   └── Replace SchemaComponent → FlowModel
   └── Replace schemaInitializerManager.addItem → model registries
   └── Replace pluginSettingsManager.add → pluginSettingsManager.addMenuItem

7. Build & verify:
   └── yarn nocobase build <plugin-name> --no-dts
   └── Confirm dist/client-v2/index.js exists
```

---

### package.json Template (2.1.x Compliant)

```json
{
  "name": "plugin-example",
  "displayName": "Example Plugin",
  "displayName.zh-CN": "示例插件",
  "description": "Brief description of the plugin purpose.",
  "version": "1.0.0",
  "license": "Apache-2.0",
  "main": "dist/server/index.js",
  "keywords": ["keyword1", "keyword2"],
  "files": [
    "dist",
    "src",
    "client.js",
    "client-v2.js",
    "server.js",
    "client.d.ts",
    "client-v2.d.ts",
    "server.d.ts"
  ],
  "nocobase": {
    "supportedVersions": ["2.x"],
    "editionLevel": 0
  },
  "peerDependencies": {
    "@nocobase/client": "2.x",
    "@nocobase/client-v2": "2.x",
    "@nocobase/flow-engine": "2.x",
    "@nocobase/server": "2.x"
  }
}
```

**Notes:**
- No `devDependencies` — build deps come from monorepo root
- No `types` at top level — use `client.d.ts` / `client-v2.d.ts` / `server.d.ts`
- `dependencies` only for runtime packages NOT provided by NocoBase host
  (e.g., `@langchain/core`, `zod`, `ssh2-sftp-client`)
- peerDependency versions use `2.x` range, not pinned versions
- `editionLevel: 0` = community, `1` = pro

---

### Quick Fix Scripts

**Add missing `nocobase` field to all non-compliant plugins:**

```bash
# Run from repo root — adds nocobase field to plugins missing it
for dir in plugin-ai-api plugin-antd-style-theme plugin-block-cross-join \
  plugin-dummy plugin-embed-web-client plugin-external-storage-manager \
  plugin-field-selection-filter plugin-file-preview-auth \
  plugin-knowledge-base plugin-next-app-client plugin-s3-private-storage \
  plugin-sftp-private-storage plugin-shared-forms plugin-uipath-orchestrator; do
  pkg="packages/plugins/$dir/package.json"
  if [ -f "$pkg" ]; then
    node -e "
      const fs = require('fs');
      const p = JSON.parse(fs.readFileSync('$pkg','utf8'));
      if (!p.nocobase) {
        p.nocobase = { supportedVersions: ['2.x'], editionLevel: 0 };
        fs.writeFileSync('$pkg', JSON.stringify(p, null, 2) + '\n');
        console.log('Fixed: $pkg');
      }
    "
  fi
done
```

**Normalize `main` field (remove leading `./`):**

```bash
for dir in packages/plugins/plugin-*/; do
  pkg="$dir/package.json"
  if [ -f "$pkg" ]; then
    node -e "
      const fs = require('fs');
      const p = JSON.parse(fs.readFileSync('$pkg','utf8'));
      if (p.main && p.main.startsWith('./')) {
        p.main = p.main.slice(2);
        fs.writeFileSync('$pkg', JSON.stringify(p, null, 2) + '\n');
        console.log('Normalized main in: $pkg');
      }
    "
  fi
done
```

**Remove devDependencies from plugin manifests:**

```bash
for dir in plugin-antd-style-theme plugin-block-cross-join \
  plugin-visualization-templates plugin-uipath-orchestrator \
  plugin-s3-private-storage plugin-sftp-private-storage \
  plugin-external-storage-manager; do
  pkg="packages/plugins/$dir/package.json"
  if [ -f "$pkg" ]; then
    node -e "
      const fs = require('fs');
      const p = JSON.parse(fs.readFileSync('$pkg','utf8'));
      if (p.devDependencies) {
        delete p.devDependencies;
        fs.writeFileSync('$pkg', JSON.stringify(p, null, 2) + '\n');
        console.log('Removed devDependencies: $pkg');
      }
    "
  fi
done
```

---

### Summary Table

| Metric | Count |
|--------|-------|
| Total custom plugins reviewed | 45 |
| Full v2 compliant (Category A) | 2 |
| Partially compliant (Category B) | 25 |
| Non-compliant (Category C) | 18 |
| Missing `nocobase` field | 14 |
| Missing `files` array | 7 |
| Has `devDependencies` (should not) | 7 |
| Uses deprecated `@nocobase/resourcer` | 2 |
| Inconsistent `main` path (`./dist/...`) | 12 |
| Missing client-v2 runtime | 43 |

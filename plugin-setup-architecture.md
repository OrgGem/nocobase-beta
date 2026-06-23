# NocoBase Plugin Setup Architecture

This document summarizes plugin architecture for this repository after the
NocoBase 2.1.x update. It supersedes the older 2.0.x mental model, where most
client extension work was described only through `src/client`,
`@nocobase/client`, `SchemaComponent`, schema initializers, and schema settings.

## Scope And Sources

- Local core version checked: `@nocobase/server`, `@nocobase/client`,
  `@nocobase/client-v2`, and `@nocobase/flow-engine` are `2.1.2`.
- Plugin inventory checked: 109 directories under `packages/plugins/@nocobase`;
  59 currently include `src/client-v2`.
- Core files cross-checked:
  - `packages/core/client-v2/src/Plugin.ts`
  - `packages/core/client-v2/src/PluginManager.ts`
  - `packages/core/client-v2/src/BaseApplication.tsx`
  - `packages/core/client-v2/src/Application.tsx`
  - `packages/core/client-v2/src/flow/index.ts`
  - `packages/core/client-v2/src/PluginSettingsManager.ts`
  - `packages/core/client/src/application/Plugin.ts`
  - `packages/core/client/src/application/PluginManager.ts`
  - `packages/core/server/src/plugin.ts`
  - `packages/core/server/src/plugin-manager/plugin-manager.ts`
  - `packages/core/server/src/plugin-manager/options/resource.ts`
- Representative plugins checked:
  - `plugin-action-bulk-update`, `plugin-action-export`,
    `plugin-action-duplicate`
  - `plugin-field-code`
  - `plugin-calendar`
  - `plugin-client`
  - `@nocobase-example/plugin-simple-action`
  - `@nocobase-example/plugin-simple-block`
  - `@nocobase-example/plugin-field-simple`
  - `@nocobase-example/plugin-settings-page`

## 2.1.x Delta From 2.0.x

NocoBase 2.1.x has two client runtimes:

| Runtime | Path | Imports | Main extension style |
| --- | --- | --- | --- |
| Legacy v1 client | `src/client` | `@nocobase/client` | `SchemaComponent`, schema initializers/settings, old plugin settings manager |
| client-v2 | `src/client-v2` | `@nocobase/client-v2`, `@nocobase/flow-engine` | `FlowEngine`, `FlowModel`, model loaders, flow settings, v2 plugin settings manager |

Important compatibility rules:

- `@nocobase/client` now wraps the base plugin/application skeleton from
  `@nocobase/client-v2`.
- v1 client code may import client-v2 APIs when the existing codebase does so.
- client-v2 code must not import from `@nocobase/client`.
- Server code is shared by both clients and usually stays in `src/server` plus
  `src/index.ts`.
- client-v2 is not just a new bundle name. It changes how UI blocks, actions,
  fields, settings pages, layout, routes, and designer settings are registered.

## Runtime And Bundle Map

Common plugin files:

```text
src/index.ts                  server package entry, usually exports ./server
src/server/index.ts           server export wrapper
src/server/plugin.ts          server Plugin class
src/client/index.ts(x)        legacy v1 client plugin
src/client-v2/index.ts(x)     client-v2 plugin entry
src/client-v2/plugin.tsx      client-v2 Plugin class
client.js                     root marker/wrapper for dist/client/index.js
client.d.ts                   root type wrapper for v1 client
client-v2.js                  root runtime marker/wrapper for dist/client-v2/index.js
client-v2.d.ts                root type wrapper for v2 client
server.js                     root wrapper for dist/server/index.js
server.d.ts                   root type wrapper for server
```

The server exposes client bundles by lane:

- v1 remote list: `pm:listEnabled`
- v2 remote list: `pm:listEnabledV2`
- v1 static entry: `dist/client/index.js`, marker `client.js`
- v2 static entry: `dist/client-v2/index.js`, marker `client-v2.js`
- v1 module id: package name and `<packageName>/client`
- v2 module id: `<packageName>/client-v2`

`pm:listEnabledV2` filters out plugins that do not have the `client-v2.js`
runtime marker or an app-dev v2 URL. A plugin can be enabled on the server and
still not load in client-v2 if it only ships `client.js`.

## Plugin Lifecycle

### Client v1 And client-v2

Both client plugin classes use constructor order `(options, app)` and support:

- `afterAdd()`
- `beforeLoad()`
- `load()`

The client plugin manager:

1. creates plugin instances;
2. registers aliases by `options.name` and `options.packageName`;
3. calls `afterAdd()` when a plugin is added;
4. calls `beforeLoad()` for all plugins;
5. calls `load()` for each plugin;
6. dispatches `plugin:<name>:loaded`.

### Server

Server plugins use constructor order `(app, options)` and support:

- `afterAdd()`
- `beforeLoad()`
- `load()`
- `install()`
- `upgrade()`
- `beforeEnable()` / `afterEnable()`
- `beforeDisable()` / `afterDisable()`
- `beforeRemove()` / `afterRemove()`
- `handleSyncMessage(message)`

During server plugin load, only enabled plugins run. The manager calls:

1. `beforeLoad()` for every enabled plugin;
2. then for each enabled plugin, `loadCollections()`;
3. `loadAI()`;
4. `load()`;
5. marks `plugin.state.loaded = true`.

`install()` runs after `db.sync()` during install/enable flows. Migration
loading is handled by the plugin manager through `server/migrations`.

## Client-v2 Architecture

client-v2 is centered on `FlowEngine`:

- `Application` creates one root `FlowEngine`.
- `PluginFlowEngine` sets `FlowModelRepository`, registers core model classes,
  registers global flow actions, and registers flow settings components.
- `Application.load()` runs `pm.load()` and then `flowEngine.flowSettings.load()`.
- `dataSourceManager` is taken from `flowEngine.context.dataSourceManager`.
- auth and data-source metadata are bootstrapped before admin runtime routes
  render.
- the admin shell is a layout registered through `layoutManager.registerLayout`.

The main client-v2 extension surfaces are:

- `flowEngine.registerModels(...)`
- `flowEngine.registerModelLoaders(...)`
- `flowEngine.registerActions(...)`
- `flowEngine.flowSettings.registerComponents(...)`
- `flowEngine.flowSettings.registerScopes(...)`
- `pluginSettingsManager.addMenuItem(...)`
- `pluginSettingsManager.addPageTabItem(...)`
- `layoutManager.registerLayout(...)`
- `app.addFieldInterfaces(...)`
- `dataSourceManager` and collection template managers exposed by related
  plugins

Use `registerModelLoaders(...)` for models with heavier UI or many dependencies.
The template and example plugins use this pattern for blocks, fields, and
actions.

## Client v1 Architecture

Legacy v1 client still exists and still powers plugins that only have
`src/client`.

Main v1 extension surfaces remain:

- `app.addComponents(...)`
- `app.addScopes(...)`
- `app.use(...)`
- `router.add(...)`
- `pluginSettingsManager.add(...)`
- `schemaInitializerManager.add(...)`
- `schemaInitializerManager.addItem(...)`
- `schemaSettingsManager.add(...)`
- `schemaSettingsManager.addItem(...)`
- `dataSourceManager.addFieldInterfaces(...)`

Do not copy v1 schema initializer/settings code into `src/client-v2` unless the
target app explicitly provides those managers. client-v2's built-in plugin
intentionally skips the old schema initializer layer.

## Server Architecture

Server plugin patterns are mostly stable from 2.0.x:

- Database: `db.registerModels`, `db.registerRepositories`,
  `db.registerOperators`, early DB hooks, data-source hooks.
- Collections: standard files under `src/server/collections` are auto-imported
  through `loadCollections()`.
- Migrations: standard files under `src/server/migrations` are auto-loaded by
  the plugin migration path. Use `db.addMigrations(...)` for non-standard dirs
  or special context only.
- Resources/actions: `app.resourceManager.define(...)`,
  `app.resourceManager.registerActionHandlers(...)`,
  `dataSource.resourceManager.registerActionHandler(...)`.
- ACL: `acl.registerSnippet`, `acl.allow`, `acl.use`, available actions, fixed
  params, permission middleware.
- Middleware: `resourceManager.use`, `dataSource.resourceManager.use`, Koa
  middleware, data-source ACL middleware.
- AI: `loadAI()` now scans the plugin `ai/` directory for tools, MCP entries,
  skills, and AI employees.
- Sync/cache/runtime state: `sendSyncMessage`, `handleSyncMessage`, PubSub,
  Redis keys, events, and explicit invalidation.

Use `app.resourceManager`, not deprecated `app.resourcer`, for new code.

## Cookbook Code Samples

### 1. Minimal 2.1.x Plugin

```ts
// src/index.ts
export * from './server';
export { default } from './server';
```

```ts
// src/server/plugin.ts
import type { Transactionable } from '@nocobase/database';
import { Plugin } from '@nocobase/server';

export default class PluginExampleServer extends Plugin {
  async beforeLoad() {
    // Register models, repositories, operators, early hooks.
  }

  async load() {
    // Register resources, actions, ACL, middleware, runtime wiring.
  }

  async install() {
    // Seed default records after db.sync(); keep it idempotent.
  }
}
```

```tsx
// src/client-v2/plugin.tsx
import { Plugin } from '@nocobase/client-v2';

export default class PluginExampleClientV2 extends Plugin {
  async load() {
    // Register FlowModels, settings pages, field interfaces, providers.
  }
}
```

```tsx
// src/client/plugin.tsx, only if the legacy v1 client is needed
import { Plugin } from '@nocobase/client';

export default class PluginExampleClient extends Plugin {
  async load() {
    // Register legacy SchemaComponent UI, initializers, settings.
  }
}
```

### 2. client-v2 Settings/Admin Page

```tsx
import { Plugin } from '@nocobase/client-v2';

export default class PluginExampleClientV2 extends Plugin {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'example',
      title: this.t('Example'),
      icon: 'SettingOutlined',
      aclSnippet: 'pm.example.configuration',
      sort: 500,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'example',
      key: 'index',
      title: this.t('Overview'),
      componentLoader: () => import('./pages/OverviewPage'),
      aclSnippet: 'pm.example.configuration',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'example',
      key: 'advanced',
      title: this.t('Advanced'),
      componentLoader: () => import('./pages/AdvancedPage'),
    });
  }
}
```

Notes:

- Register the menu before page tabs.
- `menuKey` cannot contain `.`.
- `key: 'index'` maps to `/admin/settings/<menuKey>`.
- Register matching server ACL snippets if the page should be protected.

### 3. client-v2 Block Plugin

```tsx
// src/client-v2/plugin.tsx
import { Plugin } from '@nocobase/client-v2';

export default class PluginExampleBlockClientV2 extends Plugin {
  async load() {
    this.flowEngine.registerModelLoaders({
      ExampleBlockModel: {
        loader: () => import('./models/ExampleBlockModel'),
      },
    });
  }
}
```

```tsx
// src/client-v2/models/ExampleBlockModel.tsx
import React from 'react';
import { BlockModel } from '@nocobase/client-v2';
import { tExpr } from '../locale';

export class ExampleBlockModel extends BlockModel {
  renderComponent() {
    return <div>{this.props.text}</div>;
  }
}

ExampleBlockModel.define({
  label: tExpr('Example block'),
  group: tExpr('Content'),
  createModelOptions: {
    use: 'ExampleBlockModel',
    props: {
      text: 'Example',
    },
  },
});

ExampleBlockModel.registerFlow({
  key: 'exampleSettings',
  title: tExpr('Example settings'),
  steps: {
    editText: {
      title: tExpr('Text'),
      uiSchema: {
        text: {
          type: 'string',
          title: tExpr('Text'),
          'x-decorator': 'FormItem',
          'x-component': 'Input',
        },
      },
      handler(ctx, params) {
        ctx.model.setProps({ text: params.text });
      },
    },
  },
});
```

For collection-backed blocks, extend `CollectionBlockModel`, set `static scene`
when needed, implement `static filterCollection(collection)` if only some
collections should show the block, and put default sub-models in
`define({ createModelOptions })`.

### 4. client-v2 Action Plugin

```tsx
import { ActionModel, ActionSceneEnum } from '@nocobase/client-v2';
import { tExpr } from '@nocobase/flow-engine';
import type { ButtonProps } from 'antd/es/button';

export class ExampleActionModel extends ActionModel {
  static scene = ActionSceneEnum.record;

  defaultProps: ButtonProps = {
    title: tExpr('Example action'),
    type: 'link',
  };

  getAclActionName() {
    return 'update';
  }
}

ExampleActionModel.define({
  label: tExpr('Example action'),
  sort: 100,
});

ExampleActionModel.registerFlow({
  key: 'clickFlow',
  title: tExpr('Example action'),
  on: 'click',
  steps: {
    run: {
      async handler(ctx) {
        await ctx.api.resource(ctx.collection.name).update({
          filterByTk: ctx.inputArgs.filterByTk,
          values: { updatedByAction: true },
        });
        ctx.blockModel?.resource?.refresh?.();
        ctx.message.success(ctx.t('Saved successfully'));
      },
    },
  },
});
```

```tsx
// src/client-v2/plugin.tsx
import { Plugin } from '@nocobase/client-v2';
import { ExampleActionModel } from './models/ExampleActionModel';

export default class PluginExampleActionClientV2 extends Plugin {
  async load() {
    this.flowEngine.registerModels({ ExampleActionModel });
  }
}
```

Notes:

- `static scene` decides whether the action belongs to collection, record, or
  both scenes.
- `getAclActionName()` feeds the v2 ACL flow.
- `registerFlow({ on: 'click' })` is the click behavior.
- Another `registerFlow(...)` without `on` or with `manual: true` is commonly
  used for settings.
- For custom action groups or popup/sub-form contexts, register the model with
  the relevant group, for example
  `RecordActionGroupModel.registerActionModels({ ExampleActionModel })`.

### 5. client-v2 Field Plugin

```tsx
// src/client-v2/interface.tsx
import { CollectionFieldInterface } from '@nocobase/client-v2';

export class ExampleFieldInterface extends CollectionFieldInterface {
  name = 'example';
  type = 'object';
  group = 'advanced';
  title = '{{t("Example")}}';
  default = {
    interface: 'example',
    type: 'text',
    uiSchema: {
      type: 'string',
      'x-component': 'Input.TextArea',
    },
  };
  availableTypes = ['text', 'string'];
  filterable = {
    operators: 'bigField',
  };
}
```

```tsx
// src/client-v2/models/ExampleFieldModel.tsx
import React from 'react';
import { FieldModel } from '@nocobase/client-v2';
import { DisplayItemModel, EditableItemModel, FilterableItemModel } from '@nocobase/flow-engine';

export class ExampleFieldModel extends FieldModel {
  render() {
    return <textarea value={this.props.value || ''} readOnly={this.props.readOnly} />;
  }
}

EditableItemModel.bindModelToInterface('ExampleFieldModel', ['example'], { isDefault: true });
DisplayItemModel.bindModelToInterface('ExampleFieldModel', ['example'], { isDefault: true });
FilterableItemModel.bindModelToInterface('InputFieldModel', ['example'], { isDefault: true });
```

```tsx
// src/client-v2/plugin.tsx
import { Plugin } from '@nocobase/client-v2';
import { ExampleFieldInterface } from './interface';

export default class PluginExampleFieldClientV2 extends Plugin {
  async load() {
    this.app.addFieldInterfaces([ExampleFieldInterface]);
    this.flowEngine.registerModelLoaders({
      ExampleFieldModel: {
        loader: () => import('./models/ExampleFieldModel'),
      },
    });
  }
}
```

If the field needs database behavior, add a server `Field` subclass and
register it in `beforeLoad()` or through `beforeAddDataSource()` for each
Sequelize data source.

### 6. Collections And Migrations

```ts
// src/server/collections/examples.ts
export default {
  name: 'examples',
  fields: [
    {
      type: 'uid',
      name: 'id',
      primaryKey: true,
    },
    {
      type: 'string',
      name: 'title',
      uiSchema: {
        type: 'string',
        title: '{{t("Title")}}',
        'x-component': 'Input',
      },
    },
  ],
};
```

```ts
// src/server/plugin.ts
import { Plugin } from '@nocobase/server';
import { ExampleModel } from './models/ExampleModel';

export default class PluginExampleServer extends Plugin {
  async beforeLoad() {
    this.db.registerModels({ ExampleModel });
  }
}
```

Standard collection files in `server/collections` are auto-imported during
plugin load. Standard migrations in `server/migrations` are loaded through the
plugin migration path.

### 7. Server Resource, Action, ACL, Middleware

```ts
import { Plugin } from '@nocobase/server';

async function runExample(ctx, next) {
  const repo = ctx.db.getRepository('examples');
  ctx.body = await repo.findOne({
    filterByTk: ctx.action.params.filterByTk,
  });
  await next();
}

export default class PluginExampleServer extends Plugin {
  async load() {
    this.app.resourceManager.define({
      name: 'examples',
      actions: {
        runExample,
      },
    });

    this.app.acl.registerSnippet({
      name: 'pm.example.configuration',
      actions: ['examples:runExample'],
    });
  }
}
```

For per-data-source actions:

```ts
this.app.dataSourceManager.afterAddDataSource((dataSource) => {
  dataSource.resourceManager.registerActionHandler('exampleAction', handler);
  dataSource.acl.setAvailableAction('exampleAction', {
    displayName: '{{t("Example action")}}',
  });
});
```

### 8. Runtime Cache And Sync

```ts
import { Plugin } from '@nocobase/server';

export default class PluginExampleServer extends Plugin {
  private cache = new Map<string, unknown>();

  async handleSyncMessage(message) {
    if (message.type === 'example:reload') {
      this.cache.clear();
      await this.reloadRuntimeData();
    }
  }

  async load() {
    this.db.on('examples.afterSaveWithAssociations', async (_model, { transaction }) => {
      await this.reloadRuntimeData({ transaction });
      await this.sendSyncMessage({ type: 'example:reload' }, { transaction });
    });
  }

  async reloadRuntimeData(options: Transactionable = {}) {
    const rows = await this.db.getRepository('examples').find({
      transaction: options.transaction,
    });
    this.cache = new Map(rows.map((row) => [row.get('id'), row]));
  }
}
```

### 9. Cross-Plugin Extension

```ts
const workflow = this.pm.get('workflow');
workflow?.registerInstruction?.('example', ExampleInstruction);
```

```tsx
const calendar = this.pm.get('calendar');
calendar?.registerDateTimeFieldInterface?.('exampleDate');
```

Rules:

- For mandatory peers, declare the peer dependency and fail clearly when missing.
- For optional peers, guard the integration.
- Keep stable IDs and `type` values identical across client/server.

### 10. Workflow, Notification, File, AI

These extension families still use a base-manager plugin plus small extension
plugins:

- workflow: register instruction/trigger/function on both sides when needed.
- notification: register channel forms on the client and execution class on the
  server.
- file manager: register storage/preview behavior through file-manager APIs.
- AI: register LLM providers/tools through `aiManager`; server `loadAI()` also
  discovers standard plugin AI assets under `ai/`.

### 11. Mobile/Public/Embed

For v2 routes and layouts, prefer `router.add(...)` and
`layoutManager.registerLayout(...)` patterns in client-v2. Public routes still
need explicit server token/ACL handling and must not rely on hidden UI alone.

### 12. Localization

- `this.t(...)` uses the plugin package namespace.
- For persisted configuration/schema strings, use template strings such as
  `{{t("Text", { ns: "..." })}}` or `tExpr(...)`.
- For client-v2 model labels and flow setting labels, prefer `tExpr` from
  `@nocobase/flow-engine`.
- Add locale keys for user-facing strings when introducing new UI.

### 13. Legacy v1 Schema Initializers

Use this only inside `src/client`.

```tsx
this.app.schemaInitializerManager.addItem('page:addBlock', 'otherBlocks.example', {
  name: 'example',
  title: '{{t("Example block")}}',
  Component: 'ExampleBlockInitializer',
});
```

If a legacy v1 initializer item does not appear in the menu, test whether
removing `type: 'item'` fixes it. This is an old compatibility issue and is not
a client-v2 rule.

## Pattern Selection Checklist

| Plugin type | client-v2 responsibilities | Server responsibilities |
| --- | --- | --- |
| Settings/admin page | `addMenuItem`, `addPageTabItem`, lazy page loaders | ACL snippet and config resources if needed |
| Block | `BlockModel`/`CollectionBlockModel`, `define`, `registerFlow`, model loader | only when block owns data/actions |
| Action | `ActionModel`, scene, ACL action, flows, action group registration if needed | custom resource action or per-data-source action if needed |
| Field | `CollectionFieldInterface`, renderer models, interface bindings | field type, hooks, import/export interface if needed |
| Collection/data source | collection templates/interfaces in relevant manager | collections, models, repositories, operators, hooks |
| Workflow extension | register instruction/trigger UI | register executor |
| Notification channel | register channel forms | register channel sender |
| File/storage | storage config and upload UX | storage type implementation and cache sync |
| AI extension | provider/tool UX/context | provider/tool execution, resources, ACL |
| Infrastructure | little or no UI | middleware, events, cache, sync, locks |

## Plugins To Inspect Carefully

- `plugin-acl`, `plugin-data-source-main`, `plugin-users`, `plugin-workflow`,
  `plugin-ai`, and `plugin-file-manager`: many other plugins depend on their
  registries, hooks, ACL, or cache behavior.
- `plugin-block-template`, `plugin-ui-schema-storage`,
  `plugin-public-forms`, and multi-app/data-source plugins: they have special
  runtime flows and cross-plugin interventions.
- Any plugin with both `src/client` and `src/client-v2`: update the correct
  runtime and keep shared constants/types in neutral files.
- Any plugin with only `src/client`: it is legacy-only from a v2 perspective
  until a v2 lane is added.

## Guidance For Adding Or Editing Plugins

1. Choose the runtime first: server, legacy v1 client, or client-v2.
2. In client-v2, model the UI as `FlowModel` classes and settings flows, not as
   persisted v1 schema initializer/settings code.
3. Use model loaders for heavy client-v2 model modules.
4. Keep field interface names, action model names, provider IDs, workflow types,
   and server resource action names stable.
5. Put database and data-source registration early in server `beforeLoad()`.
6. Put resources/actions/ACL/middleware and runtime service wiring in server
   `load()`.
7. Provide sync or invalidation for runtime state that can change in another
   process.
8. After client-v2 changes, verify the plugin build produces
   `dist/client-v2/index.js` and the root `client-v2.js` marker exists.

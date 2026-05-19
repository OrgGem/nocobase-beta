# NocoBase plugin setup architecture

This document summarizes how plugins under `packages/plugins/@nocobase` register themselves, configure client/server behavior, and extend each other through `src/client/index.ts(x)`, `src/server/server.ts`, and `src/server/plugin.ts`, with additional notes on related files that directly affect these entrypoints.

## Scope And How To Read

- Scope covered: all 106 plugin directories under `packages/plugins/@nocobase`.
- Primary files: `src/client/index.ts`, `src/client/index.tsx`, `src/server/server.ts`, `src/server/plugin.ts`, `src/index.ts`.
- Core files cross-checked: `packages/core/client/src/application/Plugin.ts`, `packages/core/client/src/application/PluginManager.ts`, `packages/core/server/src/plugin.ts`, `packages/core/server/src/plugin-manager/plugin-manager.ts`.
- Representative files reviewed in depth: `plugin-action-bulk-edit/src/client/index.tsx`, `plugin-acl/src/server/server.ts`, `plugin-ai/src/client/index.tsx`, `plugin-ai/src/server/plugin.ts`, `plugin-data-source-main/src/server/server.ts`, `plugin-workflow/src/client/index.tsx`, `plugin-workflow/src/server/plugin.ts`, `plugin-file-manager/src/server/server.ts`, `plugin-block-template/src/client/index.tsx`, `plugin-users/src/server/server.ts`, `plugin-public-forms/src/server/plugin.ts`, `plugin-workflow-mailer/src/client/index.ts`.
- The inventory notes below are based on static scans of lifecycle hooks, `extends Plugin`, common registration calls, and peer dependencies. For runtime behavior changes, inspect the imported modules involved in that plugin.

## Plugin Lifecycle

Client plugins extend `Plugin` from `@nocobase/client`. The constructor receives `options` and `app`. The base lifecycle hooks are `afterAdd()`, `beforeLoad()`, and `load()`. `PluginManager.add()` creates an instance, registers aliases by `name` and `packageName`, then calls `afterAdd()`. During client application startup, the manager calls `beforeLoad()` for all plugins first, then calls `load()` for each plugin and dispatches `plugin:<name>:loaded`.

Server plugins extend `Plugin` from `@nocobase/server`. In addition to `afterAdd()`, `beforeLoad()`, and `load()`, server plugins also support `install()`, `upgrade()`, `beforeEnable()`, `afterEnable()`, `beforeDisable()`, `afterDisable()`, `beforeRemove()`, `afterRemove()`, and `handleSyncMessage()`. Server `PluginManager.load()` only runs enabled plugins: it calls `beforeLoad()`, then `loadCollections()`, `loadAI()`, and `load()`. `install()` runs after `db.sync()` during install/enable flows. Therefore, DB schema, model, migration, and event-hook registration typically belongs in `beforeLoad()`, while resource/action/ACL/middleware registration and service wiring typically belongs in `load()`.

`src/index.ts` is the server-package entrypoint for most plugins. It usually exports from `./server` with `export * from './server'` and `export { default } from './server'`, or points to `./server/plugin`. The client package is exposed through the `@nocobase/plugin-xxx/client` alias into `src/client`.

## Client Architecture Pattern

Client plugins commonly use the following registration surfaces:

- UI component/scope/provider: `app.addComponents`, `app.addScopes`, `app.addProvider(s)`.
- Router/settings: `router.add`, `pluginSettingsManager.add`.
- Schema extension: `schemaInitializerManager.add/addItem`, `schemaSettingsManager.add/addItem`.
- Flow engine: `flowEngine.registerModels`, `flowEngine.registerActions`, workflow client `registerTrigger`, `registerInstruction`, `registerInstructionGroup`, `registerSystemVariable`.
- Data source UI: `dataSourceManager.addFieldInterfaces`, `addCollectionFieldInterface`, or hidden collection registration into the flow/data-source layer.
- Cross-plugin wiring: `pm.get(...)` to extend another plugin and `pm.add(...)` to load a supporting plugin.

UI-only plugins usually have no server logic, or their server class only contains lifecycle placeholders. Block/action/field plugins primarily register schema initializers, schema settings, and components. `workflow-*` plugins usually extend the workflow plugin with instructions, triggers, or task types instead of owning a large standalone UI.

## Server Architecture Pattern

Server plugins commonly use the following registration surfaces:

- Database: `db.registerModels`, `db.registerRepositories`, `db.registerOperators`, `db.addMigrations`, `db.on(...)`, automatic collection import through `loadCollections()`.
- Resource/action: `app.resourceManager.define`, `app.resourcer.define`, `registerActionHandler(s)`.
- ACL: `acl.registerSnippet`, `acl.allow`, `acl.use`, fixed params, and permission-checking middleware.
- Middleware: `resourceManager.use`, `dataSource.resourceManager.use`, Koa/application middleware, or data-source ACL middleware.
- Events/sync: `app.on`, `db.on`, `sendSyncMessage`, `handleSyncMessage`, cache invalidation events.
- Plugin-to-plugin service: `pm.get('workflow')`, `pm.get('file-manager')`, `pm.get('user-data-sync')`, and similar integrations.

Larger plugins usually split implementation into `actions/`, `resources/` or `resourcers/`, `middlewares/`, `models/`, `collections/`, and `migrations/`. The server entrypoint only composes those modules into the plugin lifecycle.

## Representative Patterns

- `plugin-acl`: server `beforeLoad()` registers migrations, models, ACL snippets, resources, action handlers, database hooks, and association-checking middleware. This is the clearest example of a core permission plugin.
- `plugin-data-source-main`: server `beforeLoad()` registers repositories, models, operators, and hooks for collection/field management, plus sync messages when collections or fields change.
- `plugin-workflow`: client and server both maintain registries for triggers, instructions, and functions. `workflow-*` plugins extend those registries through `pm.get('workflow')`.
- `plugin-ai`: client and server both provide an AI manager, provider/tool registries, and workflow integration. The server defines resources, ACL, cron jobs, dynamic tools, and conversation-abort sync handling.
- `plugin-file-manager`: the server registers the storage-type registry, upload/storage actions, file-deletion hooks, storage cache, and storage reload sync.
- `plugin-block-template`: the client patches schemas at runtime, adds initializers/settings, installs API-client interceptors, and adjusts schema settings after other plugins have loaded.
- `plugin-public-forms`: the server implements a public-token flow with resource/action handlers, token-parsing middleware, and tightly scoped ACL bypass on data sources.

## Cookbook Code Samples

The examples below are skeletons for creating a new plugin or extending an existing one. When adapting them to a real plugin, keep lifecycle responsibilities clear: DB/migration/model declarations should live in `beforeLoad()`, runtime-manager or cross-plugin wiring should live in `load()`, and initial seed data should live in `install()`.

### 1. Minimal Plugin Structure

```ts
// src/index.ts
export * from './server';
export { default } from './server';
```

```ts
// src/server/index.ts or src/server/plugin.ts
import { Plugin } from '@nocobase/server';

export class PluginExampleServer extends Plugin {
  async beforeLoad() {
    // Register models, repositories, migrations, collections, early DB hooks.
  }

  async load() {
    // Register resources, actions, ACL, middleware, cross-plugin integration.
  }

  async install() {
    // Seed default records after db.sync().
  }
}

export default PluginExampleServer;
```

```tsx
// src/client/index.tsx
import { Plugin } from '@nocobase/client';

export class PluginExampleClient extends Plugin {
  async load() {
    // Register settings, routes, schema initializers, components, scopes.
  }
}

export default PluginExampleClient;
```

Important notes:

- The server constructor is `new Plugin(app, options)`, while the client constructor is `new Plugin(options, app)`. Do not override the constructor unless necessary.
- `options.name` and `options.packageName` are used by the plugin manager as aliases for `pm.get(...)`.
- If another plugin needs to extend your plugin, expose public methods or registries on the plugin class, following patterns such as `workflow.registerInstruction(...)`, `fileManager.registerStorageType(...)`, or `notification.registerChannelType(...)`.

### 2. Register Client Plugin Settings, Routes, And Components

Use this pattern for `plugin-api-doc`, `plugin-auth`, `plugin-ai`, `plugin-localization`, `plugin-system-settings`, `plugin-theme-editor`, and `plugin-graph-collection-manager`.

```tsx
import { Plugin, lazy } from '@nocobase/client';
import { tval } from '@nocobase/utils/client';

const { ExampleSettingsPage } = lazy(() => import('./ExampleSettingsPage'), 'ExampleSettingsPage');
const NAMESPACE = '@nocobase/plugin-example';

export default class PluginExampleClient extends Plugin {
  async load() {
    this.app.addComponents({
      ExampleInlineWidget: lazy(() => import('./ExampleInlineWidget'), 'ExampleInlineWidget').ExampleInlineWidget,
    });

    this.app.pluginSettingsManager.add('example', {
      icon: 'SettingOutlined',
      title: tval('Example', { ns: NAMESPACE }),
      Component: ExampleSettingsPage,
      aclSnippet: 'pm.example.configuration',
      isPinned: true,
      sort: 500,
    });

    this.router.add('admin.example.detail', {
      path: '/admin/settings/example/:id',
      Component: ExampleSettingsPage,
    });
  }
}
```

Important notes:

- `aclSnippet` must match the snippet registered on the server; otherwise the menu may render but remain inaccessible.
- Name routes according to the existing route tree (`admin.*`, `mobile.*`) to avoid collisions.
- Use `lazy(...)` for large pages so they do not inflate the main bundle.

### 3. Register A Block Plugin

Use this pattern for `plugin-block-*`, `plugin-calendar`, `plugin-kanban`, `plugin-gantt`, and `plugin-map`.

```tsx
import { Plugin } from '@nocobase/client';
import { ExampleBlockProvider } from './ExampleBlockProvider';
import { exampleBlockSettings } from './schemaSettings';
import { ExampleBlockModel } from './models/ExampleBlockModel';

export default class PluginExampleBlockClient extends Plugin {
  async load() {
    this.app.use(ExampleBlockProvider);
    this.app.schemaSettingsManager.add(exampleBlockSettings);

    this.app.schemaInitializerManager.addItem('page:addBlock', 'otherBlocks.example', {
      title: '{{t("Example block")}}',
      Component: 'ExampleBlockInitializer',
    });

    this.app.schemaInitializerManager.addItem('mobile:addBlock', 'otherBlocks.example', {
      title: '{{t("Example block")}}',
      Component: 'ExampleBlockInitializer',
    });

    this.flowEngine.registerModels({
      ExampleBlockModel,
    });
  }
}
```

Important notes:

- If the block must be available in multiple insertion points, register it for `page:addBlock`, `popup:addNew:addBlock`, `popup:common:addBlock`, and `mobile:addBlock`.
- Blocks should define their own `schemaSettings` instead of mutating another block's settings directly, except for global-intervention cases such as `plugin-block-template`.
- If the block generates dynamic schema, place that logic in a dedicated initializer/provider and keep the client entrypoint as composition code.

### 4. Register An Action Plugin

Use this pattern for `plugin-action-*`: bulk edit/update, duplicate, import/export, print, and custom request.

```tsx
import { Plugin, useActionAvailable } from '@nocobase/client';
import { ExampleActionDecorator } from './ExampleActionDecorator';
import { ExampleActionInitializer } from './ExampleActionInitializer';
import { exampleActionSettings } from './ExampleAction.Settings';
import { useExampleActionProps } from './hooks';

export default class PluginExampleActionClient extends Plugin {
  async load() {
    this.app.addComponents({ ExampleActionDecorator });
    this.app.addScopes({ useExampleActionProps });
    this.app.schemaSettingsManager.add(exampleActionSettings);

    const initializer = {
      type: 'item',
      name: 'exampleAction',
      title: '{{t("Example action")}}',
      Component: ExampleActionInitializer,
      schema: {
        'x-align': 'right',
        'x-decorator': 'ExampleActionDecorator',
        'x-action': 'customize:example',
        'x-toolbar': 'ActionSchemaToolbar',
        'x-settings': 'actionSettings:example',
        'x-acl-action': 'update',
        'x-acl-action-props': { skipScopeCheck: true },
      },
      useVisible: () => useActionAvailable('update'),
    };

    this.app.schemaInitializerManager.addItem('table:configureActions', 'customize.example', initializer);
  }
}
```

If the action needs a custom backend endpoint:

```ts
import { Plugin } from '@nocobase/server';

async function runExample(ctx, next) {
  const { filterByTk } = ctx.action.params;
  ctx.body = await ctx.db.getRepository('examples').findOne({ filterByTk });
  await next();
}

export default class PluginExampleActionServer extends Plugin {
  async load() {
    this.app.resourceManager.registerActionHandlers({
      'examples:runExample': runExample,
    });

    this.app.acl.registerSnippet({
      name: `pm.${this.name}.actions`,
      actions: ['examples:runExample'],
    });
  }
}
```

Important notes:

- Client schema should set `x-acl-action` to the corresponding backend action (`view`, `update`, `destroy`, or a custom action).
- For batch actions, consider `skipScopeCheck`, as bulk edit does, when per-record scope checks do not apply directly.
- Backend action handlers should read `ctx.action.params` instead of manually parsing URLs.

### 5. Register Field Interfaces And Collection Templates

Use this pattern for `plugin-field-*` and parts of `plugin-file-manager`.

```tsx
import { Plugin } from '@nocobase/client';
import { ExampleField } from './ExampleField';
import { exampleFieldInterface } from './interfaces/example';
import { exampleFieldSettings } from './settings';
import { useExampleFieldProps } from './hooks';

export default class PluginExampleFieldClient extends Plugin {
  async load() {
    this.app.dataSourceManager.addFieldInterfaces([exampleFieldInterface]);
    this.app.schemaSettingsManager.add(exampleFieldSettings);
    this.app.addComponents({ ExampleField });
    this.app.addScopes({ useExampleFieldProps });
  }
}
```

```ts
// src/client/interfaces/example.ts
export const exampleFieldInterface = {
  name: 'example',
  type: 'object',
  group: 'basic',
  title: '{{t("Example")}}',
  default: {
    type: 'string',
    uiSchema: {
      type: 'string',
      'x-component': 'ExampleField',
    },
  },
  properties: {
    required: {
      type: 'boolean',
      title: '{{t("Required")}}',
      'x-component': 'Checkbox',
    },
  },
};
```

Important notes:

- The interface name is a long-lived contract; changing it affects fields that have already been created.
- If the field needs database behavior, add the corresponding server migration or hook; do not only register a client component.
- If the field depends on file upload/storage, retrieve `PluginFileManagerClient` through `pm.get(...)` instead of calling upload APIs directly.

### 6. Create A Standard Collection

Use this pattern for any plugin with its own data model: `plugin-ai`, `plugin-api-keys`, `plugin-public-forms`, `plugin-file-manager`, `plugin-notification-manager`, `plugin-ui-schema-storage`, and `plugin-workflow`.

```ts
// src/server/collections/examples.ts
export default {
  name: 'examples',
  title: '{{t("Examples")}}',
  sortable: 'sort',
  model: 'ExampleModel',
  fields: [
    {
      type: 'uid',
      name: 'id',
      primaryKey: true,
    },
    {
      type: 'string',
      name: 'title',
      allowNull: false,
      uiSchema: {
        type: 'string',
        title: '{{t("Title")}}',
        'x-component': 'Input',
      },
    },
    {
      type: 'belongsTo',
      name: 'createdBy',
      target: 'users',
      foreignKey: 'createdById',
      targetKey: 'id',
    },
    {
      type: 'datetime',
      name: 'createdAt',
    },
    {
      type: 'datetime',
      name: 'updatedAt',
    },
  ],
};
```

```ts
// src/server/plugin.ts
import path from 'path';
import { Plugin } from '@nocobase/server';
import { ExampleModel } from './models/ExampleModel';

export default class PluginExampleServer extends Plugin {
  async beforeLoad() {
    this.db.registerModels({ ExampleModel });

    this.db.addMigrations({
      namespace: this.name,
      directory: path.resolve(__dirname, './migrations'),
      context: { plugin: this },
    });

    // If you do not rely on automatic loadCollections(), import manually:
    this.db.import({
      directory: path.resolve(__dirname, './collections'),
      from: this.options.packageName,
    });
  }
}
```

Important notes:

- If collections are placed under `server/collections`, the server base plugin can load them automatically through `loadCollections()` during plugin-manager load.
- Use `from: this.options.packageName` to keep collection provenance explicit.
- If the collection is UI-managed, do not remove/drop it from destroy hooks; follow the guard pattern in `plugin-data-source-main`.

### 7. Migrations And Install Seeds

```ts
// src/server/migrations/20260101000000-seed-examples.ts
import { Migration } from '@nocobase/server';

export default class extends Migration {
  async up() {
    const repo = this.context.plugin.db.getRepository('examples');
    await repo.updateOrCreate({
      filterKeys: ['key'],
      values: {
        key: 'default',
        title: 'Default example',
      },
    });
  }

  async down() {}
}
```

```ts
// src/server/plugin.ts
export default class PluginExampleServer extends Plugin {
  async install() {
    const repo = this.db.getRepository('examples');
    const existed = await repo.findOne({ filter: { key: 'default' } });
    if (!existed) {
      await repo.create({ values: { key: 'default', title: 'Default example' } });
    }
  }
}
```

Important notes:

- Use migrations for schema/data changes that must run during upgrades.
- Use `install()` for default seed data after collections have been synced.
- Seeds should be idempotent: use `findOne`, `updateOrCreate`, or `filterKeys`.

### 8. Register Resources, Actions, ACL, And Middleware

Use this pattern for `plugin-api-keys`, `plugin-ai`, `plugin-public-forms`, `plugin-backup-restore`, `plugin-user-data-sync`, and `plugin-theme-editor`.

```ts
import { Plugin } from '@nocobase/server';

async function createExample(ctx, next) {
  const repo = ctx.db.getRepository('examples');
  ctx.body = await repo.create({
    values: {
      ...ctx.action.params.values,
      createdById: ctx.auth?.user?.id,
    },
  });
  await next();
}

export default class PluginExampleServer extends Plugin {
  async beforeLoad() {
    this.app.resourcer.define({
      name: 'examples',
      only: ['list', 'get', 'create', 'update', 'destroy'],
      actions: {
        create: createExample,
      },
    });

    this.app.acl.registerSnippet({
      name: `pm.${this.name}.configuration`,
      actions: ['examples:*'],
    });
  }

  async load() {
    this.app.acl.allow('examples', 'publicGet', 'public');
    this.app.acl.allow('examples', 'listMine', 'loggedIn');

    this.app.resourcer.use(
      async (ctx, next) => {
        if (ctx.action.resourceName === 'examples' && ctx.action.actionName === 'listMine') {
          ctx.action.mergeParams({
            filter: { createdById: ctx.auth.user.id },
          });
        }
        await next();
      },
      { group: 'examples', after: 'auth', before: 'acl' },
    );
  }
}
```

Important notes:

- `registerSnippet` serves UI permissions/settings; `acl.allow` grants runtime access for public/loggedIn/system actors.
- Data-filtering middleware should run after `auth` and before `acl`, following the `plugin-api-keys` pattern.
- Action names should follow `resource:action`; audit and workflow integrations often depend on that naming.

### 9. Connect To Other Plugins With `pm.get`

Use this pattern for extension plugins: `plugin-ai-gigachat`, `plugin-workflow-*`, `plugin-notification-email`, `plugin-file-previewer-office`, and `plugin-departments`.

```ts
import { Plugin } from '@nocobase/server';
import PluginWorkflowServer from '@nocobase/plugin-workflow';
import { ExampleInstruction } from './ExampleInstruction';

export default class PluginExampleServer extends Plugin {
  async load() {
    const workflow = this.pm.get(PluginWorkflowServer) as PluginWorkflowServer;
    if (!workflow) {
      this.log.warn('workflow plugin is not loaded');
      return;
    }

    workflow.registerInstruction('example', ExampleInstruction);
  }
}
```

```tsx
import { Plugin } from '@nocobase/client';
import PluginWorkflowClient from '@nocobase/plugin-workflow/client';
import { ExampleInstruction } from './ExampleInstruction';

export default class PluginExampleClient extends Plugin {
  async load() {
    const workflow = this.pm.get(PluginWorkflowClient) as PluginWorkflowClient;
    workflow?.registerInstruction('example', ExampleInstruction);
  }
}
```

Important notes:

- For mandatory peer dependencies, declare them in `package.json` and fail explicitly when `pm.get` cannot resolve the plugin.
- For optional integrations, use guards so the plugin can still load when the dependency is not enabled.
- The client can resolve plugins by class or string alias; the server usually uses an imported class or alias name.

### 10. Workflow instruction/trigger plugin

Use this pattern for almost all `plugin-workflow-*` plugins.

```ts
// src/server/plugin.ts
import { Plugin } from '@nocobase/server';
import WorkflowPlugin from '@nocobase/plugin-workflow';
import ExampleInstruction from './ExampleInstruction';

export default class extends Plugin {
  async load() {
    const workflow = this.app.pm.get(WorkflowPlugin) as WorkflowPlugin;
    workflow.registerInstruction('example', ExampleInstruction);
  }
}
```

```ts
// src/client/index.ts
import { Plugin } from '@nocobase/client';
import WorkflowPlugin from '@nocobase/plugin-workflow/client';
import ExampleInstruction from './ExampleInstruction';

export default class extends Plugin {
  async load() {
    const workflow = this.app.pm.get('workflow') as WorkflowPlugin;
    workflow.registerInstructionGroup('extended', {
      key: 'extended',
      label: '{{t("Extended types", { ns: "workflow" })}}',
    });
    workflow.registerInstruction('example', ExampleInstruction);
  }
}
```

If it is a trigger:

```ts
workflow.registerTrigger('example-trigger', ExampleTrigger);
```

Important notes:

- Server and client must register the same `type`; otherwise the UI may render without server execution, or the server may support a type that the UI cannot configure.
- Instructions should live in dedicated files, with only the plugin entrypoint calling `registerInstruction`.
- If the instruction needs dedicated permissions/resources, register additional ACL/actions in the server plugin.

### 11. Notification channel plugin

Use this pattern for `plugin-notification-email` and `plugin-notification-in-app-message`.

```tsx
// src/client/index.tsx
import { Plugin } from '@nocobase/client';
import PluginNotificationManagerClient from '@nocobase/plugin-notification-manager/client';
import { tval } from '@nocobase/utils/client';
import { ChannelConfigForm } from './ChannelConfigForm';
import { MessageConfigForm } from './MessageConfigForm';

export default class PluginExampleNotificationClient extends Plugin {
  async load() {
    const notification = this.pm.get(PluginNotificationManagerClient);
    notification.registerChannelType({
      type: 'example',
      title: tval('Example channel', { ns: '@nocobase/plugin-example-notification' }),
      components: {
        ChannelConfigForm,
        MessageConfigForm,
      },
    });
  }
}
```

```ts
// src/server/plugin.ts
import { Plugin } from '@nocobase/server';
import PluginNotificationManagerServer from '@nocobase/plugin-notification-manager';
import { ExampleNotificationChannel } from './ExampleNotificationChannel';

export default class PluginExampleNotificationServer extends Plugin {
  async load() {
    const notification = this.pm.get(PluginNotificationManagerServer) as PluginNotificationManagerServer;
    notification.registerChannelType({
      type: 'example',
      Channel: ExampleNotificationChannel,
    });
  }
}
```

Important notes:

- Client and server `type` values must match.
- The client registers configuration forms; the server registers the execution class that sends notifications.
- If the channel is invoked by workflow, add a peer dependency on `plugin-workflow` or `plugin-notification-manager`, depending on the integration layer.

### 12. File manager storage extension

Use this pattern when adding storage similar to S3/COS/OSS, a previewer, or a file field.

```ts
// src/server/plugin.ts
import { Plugin } from '@nocobase/server';
import PluginFileManagerServer from '@nocobase/plugin-file-manager';
import { ExampleStorageType } from './storages/example';

export default class PluginExampleStorageServer extends Plugin {
  async load() {
    const fileManager = this.pm.get(PluginFileManagerServer) as PluginFileManagerServer;
    fileManager.registerStorageType('example', ExampleStorageType);
  }
}
```

```tsx
// src/client/index.tsx
import { Plugin } from '@nocobase/client';
import PluginFileManagerClient from '@nocobase/plugin-file-manager/client';
import { exampleStorageType } from './storageType';

export default class PluginExampleStorageClient extends Plugin {
  async load() {
    const fileManager = this.pm.get(PluginFileManagerClient) as PluginFileManagerClient;
    fileManager.registerStorageType('example', exampleStorageType);
  }
}
```

Important notes:

- Server storage types handle upload/delete/presigned URL behavior; client storage types handle configuration forms and upload customization.
- If storage cache changes, send a sync message or emit an event so file-manager can reload its storage cache.
- Do not delete files from a separate plugin when file-manager already owns the deletion lifecycle.

### 13. AI provider/tool plugin

Use this pattern for `plugin-ai-gigachat` and AI extension plugins.

```ts
// src/server/plugin.ts
import { Plugin } from '@nocobase/server';
import PluginAIServer from '@nocobase/plugin-ai';
import { exampleProviderOptions } from './llm-provider';
import { exampleTool } from './tools/exampleTool';

export default class PluginExampleAIServer extends Plugin {
  async load() {
    const ai = this.pm.get(PluginAIServer) as PluginAIServer;
    ai.aiManager.registerLLMProvider('example', exampleProviderOptions);
    this.ai.toolsManager.registerTools([exampleTool]);
  }
}
```

```tsx
// src/client/index.tsx
import { Plugin } from '@nocobase/client';
import PluginAIClient from '@nocobase/plugin-ai/client';
import { exampleProviderOptions } from './llm-provider';

export default class PluginExampleAIClient extends Plugin {
  async load() {
    const ai = this.pm.get(PluginAIClient) as PluginAIClient;
    ai.aiManager.registerLLMProvider('example', exampleProviderOptions);
  }
}
```

Important notes:

- Provider IDs must be stable because LLM configuration records store this ID.
- Server tools perform real execution; client tools should only support UX/context when needed.
- If a tool requires admin privileges, enforce ACL in server resources/actions; do not only hide the UI.

### 14. Mobile extension

Use this pattern for `plugin-mobile`, `plugin-mobile-client`, `plugin-block-template`, and `plugin-workflow`.

```tsx
import { Plugin } from '@nocobase/client';
import PluginMobileClient from '@nocobase/plugin-mobile/client';
import { MobileExamplePage } from './MobileExamplePage';

export default class PluginExampleMobileClient extends Plugin {
  async load() {
    const mobile = this.pm.get(PluginMobileClient);

    this.app.schemaInitializerManager.addItem('mobile:tab-bar', 'example', {
      type: 'item',
      name: 'example',
      title: '{{t("Example")}}',
      Component: 'MobileTabBarExampleItem',
    });

    mobile?.mobileRouter?.add('mobile.page.example', {
      path: '/page/example',
      Component: MobileExamplePage,
    });
  }
}
```

Important notes:

- Check `mobile?.mobileRouter` because the mobile plugin may not be enabled.
- Register an initializer as well if users need to add the item to a mobile tab/page.
- Mobile routes should live under `/page/...`, following the workflow tasks pattern.

### 15. Public route/form plugin

Use this pattern for `plugin-public-forms`, `plugin-embed`, and `plugin-custom-subpath`.

```ts
import { Plugin } from '@nocobase/server';

export default class PluginExamplePublicServer extends Plugin {
  parseToken = async (ctx, next) => {
    const token = ctx.get('X-Example-Token');
    if (token) {
      const payload = await this.app.authManager.jwt.decode(token);
      ctx.ExamplePublic = payload;
      ctx.skipAuthCheck = true;
    }
    await next();
  };

  parseACL = async (ctx, next) => {
    if (ctx.ExamplePublic && ctx.action.resourceName === 'examples' && ctx.action.actionName === 'create') {
      ctx.permission = { skip: true };
    }
    await next();
  };

  async load() {
    this.app.acl.allow('examples', 'getPublicMeta', 'public');
    this.app.resourceManager.registerActionHandlers({
      'examples:getPublicMeta': async (ctx, next) => {
        ctx.body = { token: this.app.authManager.jwt.sign({ scope: 'example' }, { expiresIn: '1h' }) };
        await next();
      },
    });

    this.app.dataSourceManager.afterAddDataSource((dataSource) => {
      dataSource.resourceManager.use(this.parseToken, { before: 'auth' });
      dataSource.acl.use(this.parseACL, { before: 'core' });
    });
  }
}
```

Important notes:

- Public APIs must use explicit tokens/scopes when they write data.
- Only set `ctx.permission = { skip: true }` for specific resources/actions.
- If workflow should capture create/update events, remap `ctx.action.actionName` to the core action, as public forms does with `publicSubmit`.

### 16. Sync Messages, Cache, And Runtime State

Use this pattern for `plugin-acl`, `plugin-data-source-main`, `plugin-file-manager`, `plugin-localization`, `plugin-workflow`, and `plugin-environment-variables`.

```ts
import { Plugin } from '@nocobase/server';

export default class PluginExampleServer extends Plugin {
  private cache = new Map<string, any>();

  async handleSyncMessage(message) {
    if (message.type === 'example:reload') {
      this.cache.clear();
      await this.reloadRuntimeData();
    }
  }

  async load() {
    this.db.on('examples.afterSaveWithAssociations', async (model, { transaction }) => {
      await this.reloadRuntimeData({ transaction });
      await this.sendSyncMessage(
        {
          type: 'example:reload',
          key: model.get('key'),
        },
        { transaction },
      );
    });
  }

  async reloadRuntimeData(options: any = {}) {
    const rows = await this.db.getRepository('examples').find({ transaction: options.transaction });
    this.cache = new Map(rows.map((row) => [row.get('key'), row]));
  }
}
```

Important notes:

- Use `sendSyncMessage` when multiple server instances need to reload runtime state.
- If a message is emitted inside a transaction, pass `{ transaction }` to preserve commit/sync ordering.
- `handleSyncMessage` should be idempotent and tolerate records that may already have been deleted.

### 17. Localization/i18n trong plugin

```tsx
import { Plugin } from '@nocobase/client';
import { tval } from '@nocobase/utils/client';

const NAMESPACE = '@nocobase/plugin-example';

export default class PluginExampleClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add('example', {
      title: tval('Example', { ns: NAMESPACE }),
      Component: ExampleSettingsPage,
    });
  }
// inside a server/client Plugin class
```

```ts
// inside a server/client Plugin class
this.t('Example message');
```

Important notes:

- `this.t(...)` automatically uses the namespace from `options.packageName`.
- For configuration objects stored in schemas, use the `{{t("Text", { ns: "..." })}}` template or `tval(...)`.
- If a plugin provides settings or menus, keep the locale namespace consistent with the package name.

### 18. Pattern Selection Checklist By Plugin Type

| Plugin type | Client responsibilities | Server responsibilities |
| --- | --- | --- |
| Settings/admin page | `pluginSettingsManager.add`, `router.add`, lazy page | `acl.registerSnippet`, resource settings when needed |
| Block | component/provider, block initializer, schema settings, flow models | only needs server code when the block has its own data/actions |
| Action | action initializer, action schema settings, decorator, scopes | custom resource action, ACL action, audit/workflow metadata when needed |
| Field | field interface, field component, schema settings, scopes | model/hook/migration when the field needs DB behavior |
| Collection/data source | collection template/interface UI | collections, migrations, model/repository/operator/hook |
| Workflow extension | register instruction/trigger UI | register instruction/trigger executor |
| Notification channel | register channel forms | register the channel execution class |
| File/storage | storage config UI, upload override | register storage type, upload/delete implementation |
| AI extension | provider/tool UI/context | provider/tool executor, resource/ACL when the tool calls backend APIs |
| Public/embed | public route/page | token, public ACL allow, scoped ACL bypass middleware |
| Mobile | mobile initializer, mobile route | only needs server code when it owns data/actions |
| Infrastructure | little or no UI | middleware, events, cache, sync messages |

## Condensed Inventory By Pattern

Instead of repeating the same description for 106 plugins, this table groups plugins that share the same setup pattern. The `Cookbook` column points to the relevant sample code above.

| Pattern | Plugins | Cookbook | Distinguishing notes |
| --- | --- | --- | --- |
| Core ACL/auth/user | `plugin-acl`, `plugin-auth`, `plugin-auth-sms`, `plugin-users`, `plugin-departments`, `plugin-user-data-sync`, `plugin-verification`, `plugin-api-keys` | 2, 6, 8, 9, 16 | Server-heavy: models/repositories/actions/ACL/events/cache; the client mainly provides settings, routes, forms, or integration glue. |
| Core app/settings/system | `plugin-client`, `plugin-system-settings`, `plugin-localization`, `plugin-logger`, `plugin-environment-variables`, `plugin-license`, `plugin-disable-pm-add`, `plugin-locale-tester`, `plugin-hello` | 1, 2, 8, 16, 17 | These plugins provide administration surfaces, localization/logger/configuration support, or sample plugin behavior. |
| Admin tool/resource | `plugin-api-doc`, `plugin-backup-restore`, `plugin-async-task-manager`, `plugin-audit-logs`, `plugin-theme-editor`, `plugin-graph-collection-manager`, `plugin-mock-collections`, `plugin-error-handler` | 2, 8, 16 | Resource/ACL/middleware registration is the main concern; some plugins only add UI or infrastructure middleware. |
| Action UI extension | `plugin-action-bulk-edit`, `plugin-action-bulk-update`, `plugin-action-custom-request`, `plugin-action-duplicate`, `plugin-action-export`, `plugin-action-import`, `plugin-action-print` | 4, 8 | The client registers action initializers/settings/decorators/scopes; the server is only required for custom endpoints or ACL. |
| Block UI extension | `plugin-block-grid-card`, `plugin-block-iframe`, `plugin-block-list`, `plugin-block-markdown`, `plugin-block-multi-step-form`, `plugin-block-template`, `plugin-block-tree`, `plugin-block-workbench`, `plugin-calendar`, `plugin-gantt`, `plugin-kanban`, `plugin-map`, `plugin-comments`, `plugin-form-drafts` | 3, 4, 14 | Primarily schema initializers/settings/components/providers; `block-template` deeply patches schemas and global settings. |
| Field/data type extension | `plugin-field-attachment-url`, `plugin-field-china-region`, `plugin-field-code`, `plugin-field-formula`, `plugin-field-m2m-array`, `plugin-field-markdown-vditor`, `plugin-field-sequence`, `plugin-field-sort`, `plugin-snapshot-field`, `plugin-text-copy`, `plugin-multi-keyword-filter` | 5, 6, 7, 8 | The client registers field interfaces/components/settings; the server adds migrations/hooks/resources when the field has DB behavior. |
| Data source/collection | `plugin-data-source-main`, `plugin-data-source-manager`, `plugin-collection-fdw`, `plugin-collection-sql`, `plugin-collection-tree`, `plugin-multi-app-manager`, `plugin-multi-app-share-collection` | 6, 7, 8, 9, 16 | Focused on collection/field managers, data-source resources, ACL bridging, sync messages, and multi-app wiring. |
| Visualization/chart | `plugin-charts`, `plugin-data-visualization`, `plugin-data-visualization-echarts` | 2, 3, 8, 9, 13 | Combines UI builders, renderer extensions, resources/ACL, and AI/data-source integration. |
| File/storage | `plugin-file-manager`, `plugin-file-previewer-office` | 5, 8, 12, 16 | `file-manager` is the base registry/storage/cache/upload layer; previewers are extensions based on events or client hooks. |
| Workflow core/extension | `plugin-flow-engine`, `plugin-workflow`, `plugin-workflow-action-trigger`, `plugin-workflow-aggregate`, `plugin-workflow-cc`, `plugin-workflow-custom-action-trigger`, `plugin-workflow-date-calculation`, `plugin-workflow-delay`, `plugin-workflow-dynamic-calculation`, `plugin-workflow-javascript`, `plugin-workflow-json-query`, `plugin-workflow-json-variable-mapping`, `plugin-workflow-loop`, `plugin-workflow-mailer`, `plugin-workflow-manual`, `plugin-workflow-notification`, `plugin-workflow-parallel`, `plugin-workflow-request`, `plugin-workflow-request-interceptor`, `plugin-workflow-response-message`, `plugin-workflow-sql`, `plugin-workflow-test`, `plugin-workflow-variable` | 9, 10, 16 | `plugin-workflow` owns the registries and dispatcher; `workflow-*` plugins usually only call `pm.get('workflow')` and register an instruction or trigger. |
| Notification | `plugin-notification-manager`, `plugin-notification-email`, `plugin-notification-in-app-message`, `plugin-notifications` | 2, 8, 9, 11 | The manager owns the channel registry; channel plugins register client forms and server sender classes. |
| AI | `plugin-ai`, `plugin-ai-gigachat` | 2, 8, 9, 10, 13, 16 | `plugin-ai` is the base layer for providers/tools/employees/workflow integration; `ai-gigachat` is a small provider extension. |
| Mobile/public/embed | `plugin-mobile`, `plugin-mobile-client`, `plugin-public-forms`, `plugin-embed`, `plugin-custom-subpath` | 2, 14, 15 | Mobile plugins add routers/initializers; public/embed plugins need public routes plus tightly scoped token/ACL bypass. |
| UI templates/schema storage | `plugin-ui-schema-storage`, `plugin-ui-templates`, `plugin-block-template`, `plugin-custom-variables` | 2, 3, 6, 8, 16 | UI schema storage is the backend foundation; templates/custom variables mostly extend schemas, settings, and runtime patches. |

## Plugins To Inspect Carefully Before Editing

- `plugin-acl`, `plugin-data-source-main`, `plugin-users`, `plugin-workflow`, `plugin-ai`, and `plugin-file-manager`: these contain many runtime hooks, cache/sync behavior, or registries that other plugins depend on.
- `plugin-block-template`, `plugin-ui-schema-storage`, `plugin-public-forms`, and `plugin-multi-app-share-collection`: these have special flows or cross-plugin interventions, so do not rely on skeleton patterns alone.
- For `plugin-workflow-*`, `plugin-notification-*`, `plugin-ai-*`, and `plugin-file-*`, always check both client and server to ensure registered types/IDs match.

## Guidance For Adding Or Editing Plugins

1. Identify the relevant pattern in the inventory first, then use the matching cookbook section instead of creating a new flow.
2. If the plugin only adds UI/schema behavior, prioritize `src/client/index.ts(x)` and register through existing managers: components, scopes, schema initializers/settings, and plugin settings.
3. If the plugin adds collections/models/resources/ACL, put DB/migration/model registration in server `beforeLoad()`; put resources/actions/ACL/middleware in `load()` when they depend on the initialized database.
4. If extending another plugin, use `this.app.pm.get(...)`; for workflow/notification/file/AI extensions, keep the `type` or provider ID identical on both client and server.
5. If runtime state or cache is involved, provide a sync path through `sendSyncMessage/handleSyncMessage` or cache-invalidation events.

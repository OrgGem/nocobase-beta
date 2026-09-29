# NocoBase v2.2.x Architecture Reference

> **Purpose**: Living reference for custom plugin development against NocoBase v2.2.x.
> Generated from codebase analysis on 2026-08-28. Update this file when upgrading NocoBase or discovering new patterns.

---

## Table of Contents

1. [Dual Client Runtime (v1 + v2)](#1-dual-client-runtime-v1--v2)
2. [FlowEngine — Core of Client v2](#2-flowengine--core-of-client-v2)
3. [Model Hierarchy in Client v2](#3-model-hierarchy-in-client-v2)
4. [Plugin Architecture v2.2.x](#4-plugin-architecture-v22x)
5. [New / Changed Core Modules](#5-new--changed-core-modules)
6. [Migration Guide: v1 → v2 Plugin Development](#6-migration-guide-v1--v2-plugin-development)
7. [Key File References](#7-key-file-references)
8. [Conventions & Gotchas](#8-conventions--gotchas)

---

## 1. Dual Client Runtime (v1 + v2)

NocoBase v2.2.x runs **two client runtimes in parallel**:

| Aspect | Client v1 (`@nocobase/client`) | Client v2 (`@nocobase/client-v2`) |
|--------|-------------------------------|-----------------------------------|
| Core abstraction | `SchemaComponent` + Formily JSON Schema | `FlowEngine` + `FlowModel` |
| UI definition | Declarative JSON Schema (`x-component`, `x-decorator`) | Class-based Model (`renderComponent()`, `registerFlow()`) |
| State management | Formily reactive schema tree | `@formily/reactive` observable on Model instances |
| Routing | React Router + Schema-driven routes | `LayoutManager` + `AdminLayoutRouteCoordinator` + `FlowPage` |
| Plugin base class | `Plugin` from `@nocobase/client` | `Plugin` from `@nocobase/client-v2` (same name, different package) |
| Settings UI | `SchemaSettings` / `SchemaInitializer` | `FlowDefinition` + `flowSettings` registry |
| Import direction | ✅ May import from `@nocobase/client-v2` | ❌ Must NEVER import from `@nocobase/client` |

### Gateway Routing

- Client v2 is served under `/v/` prefix (configurable via `APP_MODERN_CLIENT_PREFIX` env var).
- The gateway rewrites asset paths at runtime and injects a runtime script.
- Fixed dist dir sentinel: `MODERN_CLIENT_DIST_DIR = 'v'` (see `packages/core/server/src/gateway/utils.ts`).
- V1 routes remain at root `/`.

### Which Runtime to Target?

- **New plugins**: Always target Client v2 unless you have a specific reason.
- **Existing v1 plugins**: Continue working; migrate incrementally.
- **Check before coding**: Confirm which runtime the file under edit belongs to by checking its imports (`@nocobase/client` vs `@nocobase/client-v2` / `@nocobase/flow-engine`).

---

## 2. FlowEngine — Core of Client v2

Package: `@nocobase/flow-engine` (independent, no React/NocoBase-specific deps)

### 2.1 Core Classes

#### `FlowEngine`

Singleton managing the entire lifecycle:

```typescript
class FlowEngine {
  // Registry of model classes (key = class name, value = constructor)
  private _modelClasses: Map<string, ModelConstructor>;

  // Cache of model instances (key = UID, value = instance)
  private _modelInstances: Map<string, any>;

  // Global action/event registries
  private _actionRegistry: EngineActionRegistry;
  private _eventRegistry: EngineEventRegistry;

  // Settings management (dialogs, toolbar items, components)
  flowSettings: FlowSettings;

  // Shared context for all models
  context: FlowEngineContext;

  // Key methods
  registerModels(models: Record<string, typeof FlowModel>): void;
  registerActions(actions: Record<string, ActionDefinition>): void;
  createModel(options: CreateModelOptions): FlowModel;
  getModel(uid: string): FlowModel | undefined;
  setModelRepository(repo: IFlowModelRepository): void;
}
```

#### `FlowModel<Structure>`

Base class for every UI entity:

```typescript
class FlowModel<Structure extends DefaultStructure = DefaultStructure> {
  readonly uid: string;
  sortIndex: number;
  hidden: boolean;
  props: IModelComponentProps;
  stepParams: StepParams;
  flowEngine: FlowEngine;
  parent: ParentFlowModel<Structure>;
  subModels: Structure['subModels'];

  // Override in subclass to render
  render(): React.ReactNode;
  renderComponent(): React.ReactNode;

  // Static: register a flow (settings UI) for this model class
  static registerFlow(options: FlowDefinitionOptions): void;

  // Instance: trigger an event flow
  dispatchEvent(eventName: string, options?: DispatchEventOptions): Promise<void>;

  // Instance: get flows attached to this model
  getFlows(): FlowDefinition[];

  // Static: resolve which model class to use (for polymorphism)
  static resolveUse(options: any, engine: FlowEngine, parentModel: FlowModel): string;
}
```

#### `FlowDefinition`

Defines a "flow" (a chain of steps, typically a settings panel or event handler):

```typescript
interface FlowDefinitionOptions<TModel extends FlowModel = FlowModel> {
  key: string;           // e.g. 'buttonSettings', 'tableSettings'
  title?: string;        // Human-readable title
  manual?: boolean;      // true = only run when dispatched manually
  on?: FlowEvent<TModel>; // Event trigger config (auto-executed if present)
  sort?: number;         // Execution order (lower = first)
  steps: Record<string, StepDefinition<TModel>>;
  defaultParams?: Record<string, any> | ((ctx: FlowModelContext) => StepParam);
  enableTitle?: boolean;
  divider?: 'top' | 'bottom';
}
```

Naming convention for flow keys: `xxxSettings` (e.g. `pageSettings`, `tableSettings`, `buttonSettings`).

#### `ActionDefinition`

Defines an action within a flow:

```typescript
const myAction = defineAction({
  name: 'myAction',
  title: tExpr('My Action'),
  scene: [ActionScene.DYNAMIC_EVENT_FLOW],
  sort: 100,
  uiSchema: {
    // Formily schema for settings UI
    param1: {
      type: 'string',
      'x-component': 'Input',
      title: tExpr('Parameter 1'),
    },
  },
  async handler(ctx: FlowModelContext, params: any) {
    // Action logic here
    await ctx.apiClient.request({ url: '/api/my-endpoint', method: 'post', data: params });
  },
});
```

Available `ActionScene` values:
- `BLOCK_LINKAGE_RULES`
- `FIELD_LINKAGE_RULES`
- `SUB_FORM_FIELD_LINKAGE_RULES`
- `DETAILS_FIELD_LINKAGE_RULES`
- `ACTION_LINKAGE_RULES`
- `DYNAMIC_EVENT_FLOW`
- `MENU_LINKAGE_RULES`
- `TAB_LINKAGE_RULES`

### 2.2 Resource Layer

FlowEngine has its own resource abstraction, separate from the API client:

| Resource | Description |
|----------|-------------|
| `MultiRecordResource` | List data with pagination, filter, sort |
| `SingleRecordResource` | Single record CRUD |
| `SQLResource` | Raw SQL queries |
| `APIResource` | Generic HTTP requests |
| `FlowResource` | Internal flow data |

Each resource manages its own `request` config (method, params, headers) and observable `_data`.

Usage in a model:

```typescript
class MyTableBlockModel extends CollectionBlockModel {
  static scene = BlockSceneEnum.many;

  createResource() {
    return this.context.createResource(MultiRecordResource);
  }
}
```

### 2.3 RunJS System

FlowEngine integrates sandboxed JavaScript execution:

- `JSRunner` — Executes user code in a safe context
- `RunJSContextRegistry` — Manages context contributions per model class
- `registerRunJSSnippet` / `listSnippetsForContext` — Code completion snippets
- `compileRunJs` — JSX transform for RunJS code
- Supports versioned contexts (`v1`, `v2`)
- `ctx.runjs(code)` — Execute JS within a flow step handler
- `ctx.previewRunJS(code, version?)` — Lint + sandbox preview

### 2.4 Flow Context (`FlowEngineContext`)

The shared context available to all models and actions:

```typescript
// Accessible as `this.context` in models, or `ctx` in action handlers
ctx.apiClient          // APIClient instance
ctx.dataSourceManager  // DataSourceManager
ctx.router             // React Router
ctx.i18n               // i18next instance
ctx.markdown           // Markdown parser instance
ctx.liquid             // Liquid template engine
ctx.acl                // ACL checker
ctx.runjs(code)        // Execute sandboxed JS
ctx.previewRunJS(code) // Preview/diagnose RunJS
ctx.createResource(type) // Create a resource instance
ctx.dispatchEvent(...) // Trigger events
```

Properties can be added dynamically:

```typescript
this.flowEngine.context.defineProperty('myProp', { get: () => myValue });
this.flowEngine.context.defineMethod('myMethod', async function(...) { ... });
```

---

## 3. Model Hierarchy in Client v2

```
FlowModel (@nocobase/flow-engine)
├── BlockModel                         # Base for all blocks
│   ├── CollectionBlockModel           # Blocks bound to a collection
│   │   ├── TableBlockModel            # Data table
│   │   ├── FormBlockModel             # Create/edit form
│   │   ├── DetailsBlockModel          # Record details view
│   │   ├── FilterFormBlockModel       # Filter form
│   │   └── AssignFormBlockModel       # Assignment form
│   ├── DataBlockModel                 # Data block without collection binding
│   ├── FilterBlockModel               # Standalone filter block
│   ├── GridModel / BlockGridModel     # Layout grid
│   └── JSBlockModel                   # Custom JS-rendered block
├── ActionModel                        # Buttons and actions
│   ├── CollectionActionModel          # Collection-level actions
│   ├── RecordActionModel              # Record-level actions
│   ├── PopupActionModel               # Actions opening popup/drawer
│   └── ActionGroupModel               # Grouped actions dropdown
├── FieldModel                         # Entry point for field rendering
│   ├── DisplayItemModel               # Read-only field display
│   ├── EditableItemModel              # Editable field input
│   ├── FilterableItemModel            # Field in filter form
│   └── [30+ concrete field models]    # InputFieldModel, SelectFieldModel, etc.
├── PageModel                          # Page container
│   ├── RootPageModel                  # Root page
│   ├── ChildPageModel                 # Nested page
│   ├── SubPageModel                   # Sub-page
│   └── MainPageModel                  # Main content page
├── RouteModel                         # Route definition
├── AdminLayoutModel                   # Admin shell layout + menu tree
└── AssociationFieldGroupModel         # Association field grouping
```

### Scene Pattern

Each model class declares `static scene` to specify its usage context:

```typescript
class TableBlockModel extends CollectionBlockModel {
  static scene = BlockSceneEnum.many; // Shows in "many records" block picker
}

class MyActionModel extends ActionModel {
  static scene = ActionSceneEnum.record; // Shows as record-level action
}
```

Available `BlockSceneEnum` values:
- `new` — Create form
- `one` — Single record detail
- `many` — List/table
- `select` — Selection picker
- `filter` — Filter form
- `oam` — One or many (shorthand for `['one', 'many']`)
- `subForm` — Sub-form within a parent form
- `bulkEditForm` — Bulk edit form

### Typed Sub-Model Structures

Models declare their children via TypeScript types:

```typescript
type TableBlockModelStructure = {
  subModels: {
    columns: TableColumnModel[];
    actions: ActionModel[];
  };
};

class TableBlockModel extends CollectionBlockModel<TableBlockModelStructure> {
  // this.subModels.columns → TableColumnModel[]
  // this.subModels.actions → ActionModel[]
}
```

---

## 4. Plugin Architecture v2.2.x

### 4.1 Server Plugin (largely unchanged)

```typescript
// packages/plugins/@nocobase/plugin-my-plugin/src/server/plugin.ts
import { Plugin } from '@nocobase/server';

export class PluginMyPluginServer extends Plugin {
  async afterAdd() {}
  async beforeLoad() {}
  async load() {
    // Register collections, actions, middlewares, migrations
    // this.db.registerCollections({ ... });
    // this.app.resource({ ... });
    // this.app.acl.registerSnippet({ ... });
  }
  async install() {}
  async afterEnable() {}
  async afterDisable() {}
  async remove() {}
}
```

New server-side capabilities in v2.2.x:
- `this.app.aiManager` — AI integration (skills, tools, MCP, employees)
- `this.app.dataSourceManager` — Multi data source access
- `this.app.lockManager` — Distributed locking
- `this.app.eventQueue` — Async event processing
- `ServiceContainer` — DI container
- `AuditManager` — Audit logging

### 4.2 Client v2 Plugin (major changes)

```typescript
// packages/plugins/@nocobase/plugin-my-plugin/src/client/index.tsx
import { Plugin } from '@nocobase/client-v2';
// Or use the re-export: import { Plugin } from '@nocobase/client';
// (only if your plugin targets v1 AND v2 compat layer)

export class PluginMyPluginClient extends Plugin {
  async load() {
    // 1. Register models
    this.flowEngine.registerModels({
      MyBlockModel,
      MyActionModel,
      MyFieldModel,
    });

    // 2. Register actions
    this.flowEngine.registerActions({
      myCustomAction,
    });

    // 3. Register settings components
    this.flowEngine.flowSettings.registerComponents({
      MySettingsComponent,
    });

    // 4. Register layout (if needed)
    this.app.layoutManager.registerLayout({
      routeName: 'my-layout',
      routePath: '/my-section',
      uid: 'my-layout-uid',
      layoutModelClass: 'MyLayoutModel',
    });

    // 5. Register entry actions (if needed)
    this.app.entryActionManager.register('my-entry-action', {
      scope: 'action-panel',
      provider: async (ctx) => [{ /* SubModelItem */ }],
      sort: 100,
    });

    // 6. Register AI tools (if needed)
    this.app.ai.toolsManager.registerTools('my-tool', {
      invoke: async (app, params) => { /* ... */ },
      ui: { card: MyToolCard },
    });
  }
}

export default PluginMyPluginClient;
```

### 4.3 Field Binding Pattern (NEW in v2)

Instead of registering components by string name, v2 binds **model classes** to **field interfaces**:

```typescript
import { DisplayItemModel, EditableItemModel, FilterableItemModel } from '@nocobase/flow-engine';

// Bind your field model to specific interfaces
DisplayItemModel.bindModelToInterface('MyDisplayFieldModel', ['input', 'textarea']);
EditableItemModel.bindModelToInterface('MyEditFieldModel', ['input']);
FilterableItemModel.bindModelToInterface('MyFilterFieldModel', ['input', 'select']);
```

When FlowEngine resolves a field, it finds the appropriate model class based on interface type + scene.

### 4.4 Plugin Package Structure

```
packages/plugins/@nocobase/plugin-my-plugin/
├── package.json          # name, version, main, peerDependencies
├── build.config.ts       # Optional build config
├── client.d.ts           # Type declaration for client entry
├── server.d.ts           # Type declaration for server entry
└── src/
    ├── index.ts          # Re-exports server (main entry)
    ├── client/
    │   └── index.tsx     # Client plugin class (extends Plugin from client-v2)
    └── server/
        ├── index.ts      # Re-exports plugin class
        └── plugin.ts     # Server plugin class (extends Plugin from @nocobase/server)
```

`package.json` should follow the buildable structure:

```json
{
  "name": "@nocobase/plugin-my-plugin",
  "version": "2.2.3",
  "main": "dist/server/index.js",
  "peerDependencies": {
    "@nocobase/client": "2.x",
    "@nocobase/server": "2.x",
    "@nocobase/test": "2.x"
  },
  "license": "Apache-2.0"
}
```

> ⚠️ Avoid adding top-level `types` or `devDependencies` to plugin manifests unless proven necessary.

---

## 5. New / Changed Core Modules

| Module | Status | Notes |
|--------|--------|-------|
| `@nocobase/flow-engine` | **NEW** | Independent core engine (~50 source files) |
| `@nocobase/client-v2` | **NEW** | Full client runtime replacing v1 |
| `@nocobase/ai` | **NEW** | AIManager, SkillsLoader, ToolsLoader, MCPLoader, AIEmployeeLoader |
| `@nocobase/lock-manager` | **NEW** | Distributed locking |
| `@nocobase/snowflake-id` | **NEW** | Snowflake ID generation |
| `@nocobase/data-source-manager` | Refactored | Native multi data source support |
| `@nocobase/server` | Enhanced | ServiceContainer, EventQueue, AuditManager, Environment, gateway v2 routing |
| `@nocobase/cli-v1` | **NEW** | Legacy CLI extracted; original CLI becomes v2 |
| Gateway | Enhanced | Dual runtime routing (`/v/` prefix), IPC socket, WS server |

---

## 6. Migration Guide: v1 → v2 Plugin Development

| Task | v1 Approach | v2.2.x Approach |
|------|-------------|-----------------|
| Create a new block | `SchemaComponent` + JSON schema | Extend `BlockModel` / `CollectionBlockModel`, override `renderComponent()` |
| Create a new action | `useAction()` hook + schema | Extend `ActionModel`, set `static scene`, register flow |
| Create a field renderer | `app.addFieldComponent()` | Extend `FieldModel` / `DisplayItemModel`, use `bindModelToInterface()` |
| Settings UI | `SchemaSettings` | `Model.registerFlow({ key, steps })` |
| Register block initializer | `schemaInitializerManager.add()` | `EntryActionManager` or `AddSubModelButton` in parent model |
| Data fetching | `useRequest()` / `useResource()` | `createResource(MultiRecordResource)` in model |
| Custom page layout | Route config + SchemaComponent | `LayoutManager.registerLayout()` + custom `BaseLayoutModel` |
| i18n strings | `t('key')` | Same `t()` function, but use `tExpr()` in static contexts (flow definitions, model metadata) |

### Example: Minimal v2 Block Plugin

```typescript
// src/client/index.tsx
import { Plugin, CollectionBlockModel, BlockSceneEnum, MultiRecordResource } from '@nocobase/client-v2';
import React from 'react';
import { Card } from 'antd';

class MyCustomBlockModel extends CollectionBlockModel {
  static scene = BlockSceneEnum.many;

  createResource() {
    return this.context.createResource(MultiRecordResource);
  }

  renderComponent() {
    const { data, loading } = this.resource;
    return (
      <Card loading={loading} title="My Custom Block">
        {data?.map((record) => <div key={record.id}>{record.title}</div>)}
      </Card>
    );
  }
}

// Register settings flow
MyCustomBlockModel.registerFlow({
  key: 'myCustomBlockSettings',
  title: 'My Custom Block Settings',
  steps: {
    general: {
      title: 'General',
      uiSchema(ctx) {
        return {
          showHeader: {
            'x-decorator': 'FormItem',
            'x-component': 'Switch',
            title: ctx.t('Show header'),
            default: true,
          },
        };
      },
    },
  },
});

export class PluginMyCustomBlockClient extends Plugin {
  async load() {
    this.flowEngine.registerModels({ MyCustomBlockModel });
  }
}

export default PluginMyCustomBlockClient;
```

---

## 7. Key File References

| Purpose | Path |
|---------|------|
| FlowEngine core | `packages/core/flow-engine/src/flowEngine.ts` |
| FlowModel base | `packages/core/flow-engine/src/models/flowModel.tsx` |
| Flow types | `packages/core/flow-engine/src/types.ts` |
| Flow context | `packages/core/flow-engine/src/flowContext.ts` |
| Resources | `packages/core/flow-engine/src/resources/` |
| Client v2 Application | `packages/core/client-v2/src/Application.tsx` |
| Client v2 Plugin base | `packages/core/client-v2/src/Plugin.ts` |
| Client v2 PluginManager | `packages/core/client-v2/src/PluginManager.ts` |
| Built-in models (blocks) | `packages/core/client-v2/src/flow/models/blocks/` |
| Built-in models (fields) | `packages/core/client-v2/src/flow/models/fields/` |
| Built-in models (base) | `packages/core/client-v2/src/flow/models/base/` |
| Built-in actions | `packages/core/client-v2/src/flow/actions/` |
| PluginFlowEngine (registers all built-ins) | `packages/core/client-v2/src/flow/index.ts` |
| Layout manager | `packages/core/client-v2/src/layout-manager/` |
| Admin layout model | `packages/core/client-v2/src/flow/admin-shell/admin-layout/AdminLayoutModel.tsx` |
| Flow-compat (v1↔v2 bridge) | `packages/core/client-v2/src/flow-compat/` |
| Server Plugin base | `packages/core/server/src/plugin.ts` |
| Server Application | `packages/core/server/src/application.ts` |
| Gateway (dual runtime) | `packages/core/server/src/gateway/` |
| AI module | `packages/core/ai/src/` |
| Hello plugin (reference example) | `packages/plugins/@nocobase/plugin-hello/` |
| Flow engine plugin (server persistence) | `packages/plugins/@nocobase/plugin-flow-engine/` |

---

## 8. Conventions & Gotchas

### Build & Pack

- On Windows, prefer **PowerShell** for build/pack commands.
- Build: `yarn nocobase build <plugin-package-name> --no-dts`
- Pack: `Set-Location "packages/plugins/<plugin-dir>"; npm pack`
- Verify output: `dist/client/index.js`, `dist/server/index.js`, locale files, `dist/externalVersion.js`
- Do NOT pack after a failed build.

### Code Style

- No `void someAsyncCall()` fire-and-forget. Use direct invocation.
- Avoid `any`. Use specific types, generics, or `unknown` with narrowing.
- No async IIFE in event handlers. Extract to named async functions.
- Prefer Ant Design v5 components. Follow a11y best practices.
- Comment lines run to `printWidth` (120). Don't hard-wrap prose comments.
- Three similar lines > premature abstraction.

### Database & Migrations

- Schema changes (tables, columns, indexes) ship with migrations under `src/server/migrations/`.
- New collections/columns/indexes auto-sync on `yarn nocobase upgrade` — no migration needed for these.

### Testing

- Single test: `yarn test <path-to-test-file>`
- Server tests: run sequentially (never parallel).
- Co-locate tests in `__tests__/` directories, name `*.test.ts` or `*.spec.ts`.

### i18n

- User-facing strings go through `t()` / `useTranslation()`.
- In static contexts (flow definitions, model metadata), use `tExpr('key')` instead of `t('key')`.
- Add keys for both `en-US` and `zh-CN`.

### Commit Conventions

- Conventional Commits with scope: `fix(plugin-workflow): ...`, `feat(client): ...`, `chore: ...`

### Pre-Commit

- Run `yarn eslint --fix` on touched files before reporting work done.
- Resolve type errors and lint warnings rather than disabling them.

---

---

## 9. V2 Runtime Compatibility Assessment (2026-08-28)

### Key Findings

1. **Gateway serves dual runtime**: `/v/*` → v2 client, `/*` → v1 client. Both runtimes coexist.
2. **Build system auto-generates v2 bundles** for ALL plugins (including v1-only source code). Every plugin has both `dist/client/index.js` and `dist/client-v2/index.js`.
3. **V2 PluginManager calls `pm:listEnabledV2`** which returns all plugins with `dist/client-v2/index.js` entry.
4. **Core plugins are still v1**: `plugin-auth`, `plugin-data-source-manager`, `plugin-data-visualization`, `plugin-workflow`, `plugin-ai` all use `@nocobase/client` exclusively.
5. **V2 runtime has NO SchemaComponent provider**: v1 schema-based UI (`SchemaInitializer`, `SchemaSettings`, `useDesignable`) does NOT render on v2.
6. **V2 runtime DOES support**: `pluginSettingsManager`, `flowEngine`, `router`, `addComponents`, `dataSourceManager`, `aiManager`.

### What Works on V2 Without Changes

| Feature | V2 Status | Notes |
|---------|-----------|-------|
| `pluginSettingsManager.add()` | ✅ Works | Settings pages render correctly |
| `app.router.add()` | ✅ Works | Routes function normally |
| `flowEngine.registerModels()` | ✅ Works | Native v2 pattern |
| `app.ai.toolsManager` | ✅ Works | AI integration |
| React component pages | ✅ Works | Pure React components in settings |
| Server-side APIs | ✅ Works | No client runtime dependency |

### What Does NOT Work on V2

| Feature | V2 Status | Fix Required |
|---------|-----------|-------------|
| `schemaInitializerManager.addItem()` | ❌ No effect | Add FlowModel + `registerModels()` |
| `schemaSettingsManager.add()` | ❌ No effect | Add `Model.registerFlow()` |
| `SchemaComponent` rendering | ❌ No provider | Wrap in FlowModel.renderComponent() |
| `useDesignable` / `useSchemaInitializer` | ❌ No context | Use FlowEngine APIs |
| `DataBlockInitializer` | ❌ No context | Create FlowModel with scene |

### Custom Plugin V2 Compatibility Status

| Category | Count | Action |
|----------|-------|--------|
| ✅ Already native v2 (FlowModel) | 4 | None |
| ✅ Works on v2 (settings pages / routing only) | ~48 | None needed |
| ⚠️ Needs FlowModel added | 2 | Add FlowModel alongside v1 code |
| 🚫 Blocked by core v1 deps | ~6 | Wait for core plugin migration |

### Plugins Fixed for V2

| Plugin | Fix Applied | Date |
|--------|------------|------|
| `plugin-block-cross-join` | Created `CrossJoinBlockModel`, rewrote plugin.tsx to v2 | 2026-08-28 |
| `plugin-ai-browser` | Cleaned v1 registration, fixed model import to v2 | 2026-08-28 |
| `plugin-ocr-verify-block` | Created `OcrVerifyBlockModel`, added registerModels | 2026-08-28 |

### Plugins Blocked by Core V1 Dependencies

| Plugin | Blocking Core Plugin |
|--------|---------------------|
| `plugin-visualization-templates` | `plugin-data-visualization` |
| `plugin-build-visualization-block` | `plugin-data-visualization` |
| `plugin-custom-llm` | `plugin-ai` |
| `plugin-data-source-elasticsearch` | `plugin-data-source-manager` |
| `plugin-data-source-mssql` | `plugin-data-source-manager` |
| `plugin-oidc-auth` | `plugin-auth` |

### Recommended Migration Strategy

1. **Do NOT mass-migrate** — v1 plugins work on v1 runtime, v2 bundles auto-generated
2. **Fix on-demand** — add FlowModel when a plugin needs v2-specific features
3. **Track upstream** — when core plugins migrate to v2, dependent custom plugins unblock
4. **Keep v1 code** — dual-runtime support requires both v1 and v2 registrations
5. **Test both runtimes** — verify on `/admin` (v1) AND `/v/admin` (v2)

*Last updated: 2026-08-28 | NocoBase version: 2.2.3*

# NocoBase v1 → v2 API Mapping Reference

> Quick reference for migrating custom plugins from Client v1 to Client v2 (v2.2.x).
> See also: `docs/architecture-v2.2.md` for full architecture details.

---

## 1. Import Path Changes

| v1 Import | v2 Equivalent | Notes |
|-----------|---------------|-------|
| `import { Plugin } from '@nocobase/client'` | `import { Plugin } from '@nocobase/client-v2'` | Same class name, different package |
| `import { SchemaComponent } from '@nocobase/client'` | ❌ Removed — use `FlowModel.renderComponent()` | |
| `import { useSchemaInitializer } from '@nocobase/client'` | ❌ Removed — use `flowEngine.registerModels()` | |
| `import { SchemaSettings } from '@nocobase/client'` | ❌ Removed — use `Model.registerFlow()` | |
| `import { useDesignable } from '@nocobase/client'` | ❌ Removed — settings via FlowDefinition steps | |
| `import { useApp } from '@nocobase/client'` | `import { useApp } from '@nocobase/client-v2'` | Also available via `flow-compat` |
| `import { usePlugin } from '@nocobase/client'` | `import { usePlugin } from '@nocobase/client-v2'` | Also available via `flow-compat` |
| `import { IconPicker } from '@nocobase/client'` | `import { IconPicker } from '@nocobase/client-v2'` | Re-exported from `flow-compat` |
| `import { FlowModel, ... } from '@nocobase/flow-engine'` | Same | Independent package, no change |

### Compat Bridge (`@nocobase/client-v2/src/flow-compat`)

Some v1 utilities are re-exported for gradual migration:
```typescript
import { IconPicker, Icon, ColorPicker, operators, lazy } from '@nocobase/client-v2';
// These come from flow-compat and work in v2 context
```

---

## 2. Plugin Class Migration

### v1 Pattern
```typescript
import { Plugin } from '@nocobase/client';

export class MyPlugin extends Plugin {
  async load() {
    // Register schema initializers
    this.schemaInitializerManager.add('myInitializer', { ... });
    
    // Register schema settings
    this.schemaSettingsManager.add('mySettings', { ... });
    
    // Add components
    this.app.addComponents({ MyComponent });
    
    // Add routes
    this.router.add('myRoute', { ... });
  }
}
```

### v2 Pattern
```typescript
import { Plugin } from '@nocobase/client-v2';

export class MyPlugin extends Plugin {
  async load() {
    // Register models (replaces initializers + components)
    this.flowEngine.registerModels({
      MyBlockModel,
      MyActionModel,
      MyFieldModel,
    });
    
    // Register actions (replaces action hooks)
    this.flowEngine.registerActions({
      myCustomAction,
    });
    
    // Register settings components
    this.flowEngine.flowSettings.registerComponents({
      MySettingsWidget,
    });
    
    // Register layout (if custom layout needed)
    this.app.layoutManager.registerLayout({ ... });
    
    // Register entry actions (if needed)
    this.app.entryActionManager.register('my-action', { ... });
    
    // Routes still work similarly
    this.router.add('myRoute', { ... });
  }
}
```

---

## 3. Block Creation

### v1: SchemaComponent + JSON Schema
```typescript
// Declarative JSON schema
const myBlockSchema = {
  type: 'void',
  'x-component': 'MyBlock',
  'x-decorator': 'CardItem',
  'x-component-props': { title: 'Hello' },
};

// Register via initializer
this.schemaInitializerManager.add('myBlockInitializer', {
  items: [{ name: 'myBlock', Component: MyBlockInitializer }],
});
```

### v2: FlowModel Subclass
```typescript
import { CollectionBlockModel, BlockSceneEnum, MultiRecordResource } from '@nocobase/client-v2';

class MyBlockModel extends CollectionBlockModel {
  static scene = BlockSceneEnum.many;

  createResource() {
    return this.context.createResource(MultiRecordResource);
  }

  renderComponent() {
    const { data, loading } = this.resource;
    return <Card loading={loading}>{/* render */}</Card>;
  }
}

// Register in plugin
this.flowEngine.registerModels({ MyBlockModel });
```

### Block Base Classes Available

| Base Class | Use When |
|------------|----------|
| `BlockModel` | Generic block, no data binding |
| `DataBlockModel` | Block with data but no collection |
| `CollectionBlockModel` | Block bound to a collection (table, form, details) |
| `FilterBlockModel` | Standalone filter block |
| `GridModel` / `BlockGridModel` | Layout grid container |

---

## 4. Settings UI

### v1: SchemaSettings
```typescript
const mySettings = new SchemaSettings({
  name: 'myBlockSettings',
  items: [
    {
      name: 'title',
      Component: () => <Input />,
    },
  ],
});
this.schemaSettingsManager.add(mySettings);
```

### v2: Model.registerFlow()
```typescript
MyBlockModel.registerFlow({
  key: 'myBlockSettings',
  title: tExpr('My Block Settings'),
  steps: {
    general: {
      title: tExpr('General'),
      uiSchema(ctx) {
        return {
          showTitle: {
            'x-decorator': 'FormItem',
            'x-component': 'Switch',
            title: tExpr('Show title'),
            default: true,
          },
          maxRows: {
            'x-decorator': 'FormItem',
            'x-component': 'InputNumber',
            title: tExpr('Max rows'),
          },
        };
      },
    },
  },
});
```

### Key Differences
- `tExpr()` for static string expressions (not `t()`)
- `uiSchema` is a function receiving `ctx` (FlowModelContext)
- Steps are named keys (`general`, `dataScope`, etc.)
- No more `items` array — use Formily uiSchema object

---

## 5. Actions

### v1: useAction Hook
```typescript
function MyActionButton() {
  const { run } = useAction({ url: '/api/do-something', method: 'post' });
  return <Button onClick={() => run()}>Do It</Button>;
}
```

### v2: ActionModel + defineAction
```typescript
// Define reusable action
export const doSomething = defineAction({
  name: 'doSomething',
  title: tExpr('Do Something'),
  scene: [ActionScene.DYNAMIC_EVENT_FLOW],
  uiSchema: {
    param1: {
      'x-decorator': 'FormItem',
      'x-component': 'Input',
      title: tExpr('Parameter'),
    },
  },
  async handler(ctx, params) {
    await ctx.apiClient.request({
      url: '/api/do-something',
      method: 'post',
      data: params,
    });
  },
});

// Custom action model
class MyActionModel extends ActionModel {
  static scene = ActionSceneEnum.record;
  defaultProps = { title: 'My Action' };
}

// Register
this.flowEngine.registerModels({ MyActionModel });
this.flowEngine.registerActions({ doSomething });
```

---

## 6. Field Renderers

### v1: addFieldComponent
```typescript
this.app.addFieldComponent('myField', MyFieldComponent);
```

### v2: FieldModel + bindModelToInterface
```typescript
import { DisplayItemModel, EditableItemModel, FilterableItemModel } from '@nocobase/flow-engine';

class MyDisplayFieldModel extends DisplayItemModel {
  render() {
    return <span>{this.props.value}</span>;
  }
}

class MyEditFieldModel extends EditableItemModel {
  render() {
    return <Input {...this.props} />;
  }
}

// Bind to field interfaces
DisplayItemModel.bindModelToInterface('MyDisplayFieldModel', ['input', 'textarea']);
EditableItemModel.bindModelToInterface('MyEditFieldModel', ['input']);
FilterableItemModel.bindModelToInterface('MyEditFieldModel', ['input']);

// Register
this.flowEngine.registerModels({ MyDisplayFieldModel, MyEditFieldModel });
```

---

## 7. Data Fetching

### v1: useRequest / useResource
```typescript
const { data, loading } = useRequest({ url: '/api/items' });
```

### v2: Resource in Model
```typescript
class MyBlockModel extends CollectionBlockModel {
  static scene = BlockSceneEnum.many;

  createResource() {
    return this.context.createResource(MultiRecordResource);
  }

  renderComponent() {
    // Access via this.resource (observable)
    const data = this.resource.data;
    const loading = this.resource.loading;
    return <Table dataSource={data} loading={loading} />;
  }
}
```

### Resource Types
| Resource | Use For |
|----------|---------|
| `MultiRecordResource` | List/table with pagination, filter, sort |
| `SingleRecordResource` | Single record CRUD |
| `SQLResource` | Raw SQL queries |
| `APIResource` | Generic HTTP requests |

---

## 8. i18n

### Static Contexts (model metadata, flow definitions)
```typescript
// ❌ Wrong — t() requires React context
title: t('My Title')

// ✅ Correct — tExpr() creates a lazy expression
title: tExpr('My Title')
```

### Runtime Contexts (render methods, handlers)
```typescript
// ✅ Use this.t() or ctx.t()
renderComponent() {
  return <div>{this.t('Hello')}</div>;
}

async handler(ctx, params) {
  ctx.message.success(ctx.t('Saved'));
}
```

---

## 9. Common Gotchas

| Issue | Solution |
|-------|----------|
| `Cannot find module '@nocobase/client-v2'` | Ensure `peerDependencies` includes `"@nocobase/client": "2.x"` |
| Build fails with "entry point cannot be marked as external" | Use PowerShell, not bash, for build commands |
| `tExpr is not defined` | Import from `@nocobase/flow-engine`: `import { tExpr } from '@nocobase/flow-engine'` |
| Settings panel empty after migration | Check that `registerFlow` key matches expected naming (`xxxSettings`) |
| Model not appearing in block picker | Verify `static scene` is set correctly on the model class |
| Circular import between v1 and v2 | Never import `@nocobase/client` from a file that uses `@nocobase/client-v2` |

---

*Last updated: 2026-08-28 | NocoBase version: 2.2.3*

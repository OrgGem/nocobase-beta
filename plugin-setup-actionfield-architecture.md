# Kien truc plugin action, field va custom block trong NocoBase 2.1.x

Tai lieu nay la nguon tham khao nhanh de tao hoac sua plugin action, field va
custom block trong repo NocoBase 2.1.x. Kien truc 2.0.x cu van dung cho
legacy client v1, nhung client-v2 da doi sang FlowEngine/FlowModel.

Nguon doi chieu chinh:

- `packages/core/client-v2/src/flow/models`
- `packages/core/flow-engine/src`
- `packages/plugins/@nocobase/plugin-action-*`
- `packages/plugins/@nocobase/plugin-field-*`
- `packages/plugins/@nocobase-example/plugin-simple-action`
- `packages/plugins/@nocobase-example/plugin-simple-block`
- `packages/plugins/@nocobase-example/plugin-field-simple`
- `packages/plugins/@nocobase-example/plugin-custom-table-block-resource`

## 1. Khung chung cua plugin 2.1.x

Mot plugin co the co 3 lane rieng:

| Lane | Thu muc | Import | Dung khi |
| --- | --- | --- | --- |
| Server | `src/server` | `@nocobase/server` | Collection, model, resource, action, ACL, middleware, hook, migration |
| Client v1 | `src/client` | `@nocobase/client` | Legacy SchemaComponent, schema initializer/settings |
| Client v2 | `src/client-v2` | `@nocobase/client-v2`, `@nocobase/flow-engine` | FlowModel block/action/field/settings moi |

Quy tac quan trong:

- `src/client-v2` khong import tu `@nocobase/client`.
- Plugin co `src/client-v2` can root runtime marker `client-v2.js`; nen giu
  `client-v2.d.ts` lam type wrapper tuong ung. Build phai tao
  `dist/client-v2/index.js`.
- Server load v2 client qua `pm:listEnabledV2` voi module id
  `<packageName>/client-v2`.
- V1 va v2 co the song song trong cung plugin, nhung khong chia se React UI bang
  cach import nguoc v1 vao v2.

Lifecycle:

- Client v1/v2: `afterAdd()`, `beforeLoad()`, `load()`.
- Server: `afterAdd()`, `beforeLoad()`, `load()`, `install()`, `upgrade()`,
  enable/disable/remove hooks, `handleSyncMessage()`.
- Server `beforeLoad()` chay cho tat ca plugin truoc khi `loadCollections()` va
  `loadAI()` cua tung plugin.

## 2. Client-v2 thay gi cho action/field/block

Trong v2, UI designer khong con xoay quanh viec plugin chen schema initializer
va schema settings vao menu v1. Core su dung `FlowModel`:

- Model class mo ta block/action/field.
- `Model.define(...)` mo ta label, group, sort, default `createModelOptions`.
- `Model.registerFlow(...)` mo ta runtime event va settings form.
- `flowEngine.registerModels(...)` dang ky model eager.
- `flowEngine.registerModelLoaders(...)` dang ky model lazy.
- `flowEngine.flowSettings` render form cau hinh flow/settings.
- Model tree duoc luu qua `FlowModelRepository`.

Khi port plugin 2.0.x sang 2.1.x:

- `schemaInitializerManager.addItem(...)` -> thuong thay bang
  `FlowModel.define(...)` va subclass dung group/scene.
- `SchemaSettings` -> thuong thay bang `Model.registerFlow(...)`.
- `x-use-component-props`/schema hook -> thuong thay bang flow context, model
  props, `ctx.runAction(...)`, hoac `ctx.model.setProps(...)`.
- Field UI schema van con trong field interface, nhung renderer v2 la
  `FieldModel`/`CollectionFieldModel` binding.

## 3. Kien truc plugin action

### 3.1. Action client-v2

Action moi trong client-v2 la class `ActionModel`.

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
          values: { touched: true },
        });
        ctx.blockModel?.resource?.refresh?.();
        ctx.message.success(ctx.t('Saved successfully'));
      },
    },
  },
});
```

Dang ky trong plugin:

```tsx
import { Plugin } from '@nocobase/client-v2';
import { ExampleActionModel } from './models/ExampleActionModel';

export default class PluginExampleActionClientV2 extends Plugin {
  async load() {
    this.flowEngine.registerModels({ ExampleActionModel });
  }
}
```

Khi model nang hoac tach file theo lazy chunk:

```tsx
this.flowEngine.registerModelLoaders({
  ExampleActionModel: {
    loader: () => import('./models/ExampleActionModel'),
  },
});
```

### 3.2. Action scene va group

Core action scenes:

- `ActionSceneEnum.collection`: nut o cap block/collection.
- `ActionSceneEnum.record`: nut o cap tung record/row.
- `ActionSceneEnum.both` hoac `all`: dung cho ca hai.

Neu action khong duoc auto discover trong group mong muon, dang ky vao group:

```tsx
import { RecordActionGroupModel } from '@nocobase/client-v2';

RecordActionGroupModel.registerActionModels({
  ExampleActionModel,
});
```

Voi block dac thu, co the tao custom action group va set trong
`customModelClasses` cua block.

### 3.3. Flow cua action

Mot action thuong co 2 nhom flow:

- Runtime flow: `on: 'click'`, `on: { eventName: '...' }`, hoac custom event.
- Settings flow: khong co `on` hoac `manual: true`; dung de luu props/step
  params.

Vi du settings:

```tsx
ExampleActionModel.registerFlow({
  key: 'exampleSettings',
  title: tExpr('Example settings'),
  manual: true,
  steps: {
    confirm: {
      use: 'confirm',
      defaultParams: {
        enable: false,
        title: tExpr('Example action'),
      },
    },
    mode: {
      title: tExpr('Mode'),
      uiSchema: {
        value: {
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'Radio.Group',
          enum: [
            { label: tExpr('Selected'), value: 'selected' },
            { label: tExpr('All'), value: 'all' },
          ],
        },
      },
      handler(ctx, params) {
        ctx.model.setProps({ mode: params.value });
      },
    },
  },
});
```

Context hay dung trong handler:

- `ctx.model`
- `ctx.api`
- `ctx.collection`
- `ctx.blockModel`
- `ctx.record`
- `ctx.resource`
- `ctx.inputArgs`
- `ctx.message`
- `ctx.t`
- `ctx.viewer`
- `ctx.runAction(...)`

### 3.4. Server action modes

| Mode | Khi dung | Pattern |
| --- | --- | --- |
| Client-only | Action goi API core da co | Khong can server moi |
| Per data source action | Moi data source/collection can handler rieng | `afterAddDataSource`, `resourceManager.registerActionHandler`, `acl.setAvailableAction` |
| Global config resource | Action co cau hinh rieng | Collection/resource config, ACL snippet, link bang uid/key |
| Runtime service action | Action cham service rieng | `app.resourceManager.define`, middleware, ACL, cache/sync |

Vi du per data source:

```ts
this.app.dataSourceManager.afterAddDataSource((dataSource) => {
  dataSource.resourceManager.registerActionHandler('export', handler);
  dataSource.acl.setAvailableAction('export', {
    displayName: '{{t("Export")}}',
    allowConfigureFields: true,
  });
});
```

### 3.5. Action v1 legacy

Trong `src/client`, action cu van dung schema initializer/settings:

- Dang ky component/scope/provider.
- Dang ky `SchemaSettings`.
- Tao initializer item.
- Chen vao `table:configureActions`, `table:configureItemActions`,
  `details:configureActions`, `gantt:configureActions`, ...
- Schema dung `x-action`, `x-component`, `x-toolbar`, `x-settings`,
  `x-acl-action`, `x-action-settings`.

Khong copy pattern nay vao `src/client-v2` neu khong co ly do ro rang.

## 4. Kien truc plugin field

### 4.1. Field interface client-v2

Field interface v2 la class ke thua `CollectionFieldInterface`.

```tsx
import { CollectionFieldInterface } from '@nocobase/client-v2';

export class ExampleFieldInterface extends CollectionFieldInterface {
  name = 'example';
  type = 'object';
  group = 'advanced';
  order = 10;
  title = '{{t("Example")}}';
  description = '{{t("Example field")}}';
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
  titleUsable = false;
  configure = {
    items: [
      {
        name: 'uiSchema.x-component-props.mode',
        title: '{{t("Mode")}}',
        component: 'Select',
        options: [
          { label: 'Plain', value: 'plain' },
          { label: 'Rich', value: 'rich' },
        ],
      },
    ],
  };
}
```

Dang ky:

```tsx
this.app.addFieldInterfaces([ExampleFieldInterface]);
```

API bo sung trong v2:

- `addFieldInterfaceGroups(...)`
- `addFieldInterfaceComponentOption(...)`
- `addFieldInterfaceOperator(...)`
- `registerFieldFilterOperator(...)`
- `registerFieldFilterOperatorGroup(...)`
- `registerFieldValidationConfigure(...)`
- `registerFieldInterfaceConfigure(...)` tren manager

### 4.2. Field renderer model

Renderer v2 la `FieldModel` hoac subclass phu hop.

```tsx
import React from 'react';
import { FieldModel } from '@nocobase/client-v2';
import { DisplayItemModel, EditableItemModel, FilterableItemModel } from '@nocobase/flow-engine';

export class ExampleFieldModel extends FieldModel {
  render() {
    return <input value={this.props.value || ''} readOnly={this.props.readOnly} />;
  }
}

ExampleFieldModel.define({
  label: '{{t("Example")}}',
});

EditableItemModel.bindModelToInterface('ExampleFieldModel', ['example'], { isDefault: true });
DisplayItemModel.bindModelToInterface('ExampleFieldModel', ['example'], { isDefault: true });
FilterableItemModel.bindModelToInterface('InputFieldModel', ['example'], { isDefault: true });
```

Dang ky lazy:

```tsx
this.flowEngine.registerModelLoaders({
  ExampleFieldModel: {
    loader: () => import('./models/ExampleFieldModel'),
  },
});
```

Binding hay gap:

- `EditableItemModel.bindModelToInterface(...)`: form/edit mode.
- `DisplayItemModel.bindModelToInterface(...)`: table/detail read mode.
- `FilterableItemModel.bindModelToInterface(...)`: filter form.
- `FormItemModel.bindModelToInterface(...)`: form item/block-specific fields.
- `DetailsItemModel.bindModelToInterface(...)`: details block.

### 4.3. Field settings v2

Dung `registerFlow(...)` tren model, khong tao `SchemaSettings` v1:

```tsx
ExampleFieldModel.registerFlow({
  key: 'exampleFieldSettings',
  title: '{{t("Example settings")}}',
  steps: {
    height: {
      title: '{{t("Height")}}',
      uiSchema: {
        height: {
          type: 'number',
          'x-decorator': 'FormItem',
          'x-component': 'InputNumber',
        },
      },
      defaultParams(ctx) {
        return { height: ctx.model.props.height || 120 };
      },
      handler(ctx, params) {
        ctx.model.setProps({ height: params.height });
      },
    },
  },
});
```

Mot so field hien tai dung `uiMode(ctx)` thay `uiSchema` de tao control gon hon
cho flow settings.

### 4.4. Server field type va import/export

Tao server `Field` subclass khi field can logic DB:

- tinh toan gia tri;
- sinh ma/sequence;
- validate server;
- relation dac thu;
- reorder/sort;
- side effect khi save/sync.

Dang ky tren DB chinh:

```ts
this.db.registerFieldTypes({
  example: ExampleField,
});
```

Dang ky cho moi Sequelize data source:

```ts
this.app.dataSourceManager.beforeAddDataSource((dataSource) => {
  if (dataSource.collectionManager instanceof SequelizeCollectionManager) {
    dataSource.collectionManager.registerFieldTypes({
      example: ExampleField,
    });
  }
});
```

Import/export dac thu dung server interface:

```ts
this.app.db.interfaceManager.registerInterfaceType('example', ExampleInterface);
```

`field.options.interface` o client phai khop type server interface de services
goi `toValue()` va `toString()` dung cach.

### 4.5. Field v1 legacy

Trong `src/client`, pattern cu van dung:

- `app.dataSourceManager.addFieldInterfaces(...)`
- `app.addComponents(...)`
- `app.addScopes(...)`
- `schemaSettingsManager.add(...)`
- `schemaSettingsManager.addItem(...)`
- Patch schema bang `x-uid` va `dn.emit('patch', ...)`

Trong `src/client-v2`, uu tien field interface class + model binding + flow
settings.

## 5. Custom block va custom table block

### 5.1. Block client-v2 don gian

```tsx
import React from 'react';
import { BlockModel } from '@nocobase/client-v2';
import { tExpr } from '../locale';

export class SimpleBlockModel extends BlockModel {
  renderComponent() {
    return <div dangerouslySetInnerHTML={{ __html: this.props.html }} />;
  }
}

SimpleBlockModel.define({
  label: tExpr('Simple block'),
  group: tExpr('Content'),
  createModelOptions: {
    use: 'SimpleBlockModel',
    props: {
      html: '<h3>Simple block</h3>',
    },
  },
});
```

### 5.2. Collection block

Dung `CollectionBlockModel` khi block can collection/resource:

```tsx
import { BlockSceneEnum, CollectionBlockModel } from '@nocobase/client-v2';

export class TodoBlockModel extends CollectionBlockModel {
  static scene = BlockSceneEnum.many;

  static filterCollection(collection) {
    return collection.name === 'todoItems';
  }
}

TodoBlockModel.define({
  label: 'Todo block',
  createModelOptions: {
    use: 'TodoBlockModel',
  },
});
```

Scene thuong gap:

- `BlockSceneEnum.many`: list/table/calendar/kanban style.
- `BlockSceneEnum.one`: current record/details style.
- `BlockSceneEnum.new`: popup/new record context.
- `BlockSceneEnum.select`: picker/select context.

### 5.3. Custom table block

2.1.x van dung y tuong `customModelClasses`, nhung tren model v2:

```tsx
import { TableBlockModel } from '@nocobase/client-v2';

export class CustomTableBlockModel extends TableBlockModel {
  customModelClasses = {
    CollectionActionGroupModel: 'CustomCollectionActionGroupModel',
    RecordActionGroupModel: 'CustomRecordActionGroupModel',
    TableColumnModel: 'CustomTableColumnModel',
    TableAssociationFieldGroupModel: null,
  };
}
```

Quy tac:

- Moi class name khac `null` phai duoc register vao FlowEngine.
- `null` nghia la bo sub-model do khoi composition.
- `define({ createModelOptions })` quyet dinh block co hien trong menu tao block
  va tao model tree mac dinh nhu the nao.
- Neu chi register model ma khong `define(...)`/khong co parent group nao goi
  den, nguoi dung co the khong thay block trong UI.

## 6. Chon kien truc cho plugin moi

### 6.1. Action moi

| Nhu cau | Nen lam |
| --- | --- |
| Nut moi trong client-v2 | Tao `ActionModel`, set scene, `define`, `registerFlow` |
| Nut goi API core da co | Client-v2 action only, server co the no-op |
| Action can resource custom | Them server resource/action/ACL |
| Action can moi data source | `afterAddDataSource`, register handler va available action |
| Action co popup/form con | Dung flow `openView`, subModels, hoac custom view content |
| Plugin chi sua legacy client | Dung schema initializer/settings trong `src/client` |

### 6.2. Field moi

| Nhu cau | Nen lam |
| --- | --- |
| UI moi tren DB type co san | `CollectionFieldInterface` + `FieldModel` bindings |
| Can renderer read/edit/filter rieng | Tao cac model rieng va bind vao interface |
| Can validation/config form field | Dung `configure`, validation configure, flow settings |
| Can DB behavior | Server `Field` subclass va hook/migration neu can |
| Can import/export mapping | Server `BaseInterface` khop interface name |
| Chi them option vao field co san | V2: register configure/operator/flow; v1: schema settings item |

### 6.3. Custom block

| Nhu cau | Nen lam |
| --- | --- |
| Block UI don gian | `BlockModel` + `renderComponent` |
| Block co collection/resource | `CollectionBlockModel` |
| Bien the table/list co composition moi | Extend `TableBlockModel` va set `customModelClasses` |
| Can data/action server rieng | Them server collection/resource/action/ACL |

## 7. Checklist tao plugin action client-v2

1. Tao `src/client-v2/plugin.tsx`.
2. Import `Plugin` tu `@nocobase/client-v2`.
3. Tao `ActionModel` subclass.
4. Set `static scene`.
5. Set `defaultProps`.
6. Implement `getAclActionName()` neu can ACL.
7. Goi `ActionModel.define(...)`.
8. Goi `ActionModel.registerFlow(...)` cho click/runtime.
9. Goi `registerFlow(...)` rieng cho settings neu can.
10. Dang ky model bang `registerModels` hoac `registerModelLoaders`.
11. Neu can server action, dang ky resource/action/ACL o server.
12. Test scene collection/record va ACL.

## 8. Checklist tao plugin field client-v2

1. Tao `CollectionFieldInterface` class.
2. Khai bao `name`, `group`, `title`, `default.interface`,
   `default.type`, `default.uiSchema`.
3. Khai bao `availableTypes`, `filterable`, `titleUsable`, `configure` neu can.
4. Dang ky bang `app.addFieldInterfaces([...])`.
5. Tao renderer model cho edit/display/filter neu can.
6. Bind model vao interface.
7. Dang ky model bang loader neu module nang.
8. Them server field type neu co DB behavior.
9. Them server interface neu import/export can mapping.
10. Test tao field, render form/table/detail/filter, import/export neu co.

## 9. Checklist tao custom block client-v2

1. Chon `BlockModel`, `CollectionBlockModel`, hoac `TableBlockModel`.
2. Implement `renderComponent()` neu la block render truc tiep.
3. Set `static scene` neu block phu thuoc context.
4. Implement `filterCollection()` neu can gioi han collection.
5. Set `customModelClasses` neu thay composition con.
6. Goi `define({ label, group, createModelOptions, sort })`.
7. Dang ky model/sub-model vao FlowEngine.
8. Neu co settings, dung `registerFlow(...)`.
9. Neu co data/action server, dang ky server resource/ACL.

## 10. File tham khao nhanh

Action v2:

- `packages/plugins/@nocobase-example/plugin-simple-action/src/client-v2/models/SimpleCollectionActionModel.tsx`
- `packages/plugins/@nocobase/plugin-action-bulk-update/src/client-v2/BulkUpdateActionModel.tsx`
- `packages/plugins/@nocobase/plugin-action-export/src/client-v2/ExportActionModel.tsx`
- `packages/plugins/@nocobase/plugin-action-duplicate/src/client-v2/DuplicateActionModel.tsx`

Field v2:

- `packages/plugins/@nocobase/plugin-field-code/src/client-v2/interface.tsx`
- `packages/plugins/@nocobase/plugin-field-code/src/client-v2/models/CodeFieldModel.tsx`
- `packages/plugins/@nocobase/plugin-field-code/src/client-v2/models/DisplayCodeFieldModel.tsx`
- `packages/core/client-v2/src/collection-field-interface/CollectionFieldInterface.ts`
- `packages/core/flow-engine/src/models/CollectionFieldModel.tsx`

Block v2:

- `packages/plugins/@nocobase-example/plugin-simple-block/src/client-v2/models/SimpleBlockModel.tsx`
- `packages/plugins/@nocobase-example/plugin-custom-table-block-resource/src/client-v2/models/TodoBlockModel.tsx`
- `packages/plugins/@nocobase/plugin-calendar/src/client-v2/models/CalendarBlockModel.tsx`
- `packages/core/client-v2/src/flow/models/base/BlockModel.tsx`
- `packages/core/client-v2/src/flow/models/base/CollectionBlockModel.tsx`
- `packages/core/client-v2/src/flow/models/blocks/table/TableBlockModel.tsx`

Legacy v1:

- `packages/plugins/@nocobase/plugin-action-bulk-update/src/client/index.tsx`
- `packages/plugins/@nocobase/plugin-field-code/src/client/interface.tsx`
- `packages/plugins/@nocobase/plugin-text-copy/src/client/index.tsx`

Server:

- `packages/plugins/@nocobase/plugin-action-export/src/server/index.ts`
- `packages/plugins/@nocobase/plugin-action-import/src/server/index.ts`
- `packages/plugins/@nocobase/plugin-field-formula/src/server/formula-field.ts`
- `packages/plugins/@nocobase/plugin-field-sequence/src/server/fields/sequence-field.ts`
- `packages/plugins/@nocobase/plugin-field-china-region/src/server/interfaces/china-region-interface.ts`

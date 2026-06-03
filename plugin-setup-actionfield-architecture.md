# Kien truc plugin action, field va custom block trong NocoBase

Tai lieu nay la nguon tham khao nhanh de agent tao plugin moi theo cac pattern da co trong repo. Noi dung tong hop tu:

- `packages/plugins/@nocobase/plugin-action-*`
- `packages/plugins/@nocobase/plugin-field-*`
- `packages/plugins/@nocobase/plugin-text-copy`
- `packages/plugins/@nocobase-example/plugin-custom-table-block*`

Nguyen tac doc tai lieu:

- Phan kien truc mo ta contract va extension point can dung.
- Phan chon huong giup quyet dinh nen tao plugin action, field, custom field type, hay chi mo rong UI co san.
- Checklist chi giu cac viec bat buoc, khong lap lai chi tiet da co o phan kien truc.

## 1. Khung chung cua plugin

Plugin NocoBase thuong tach client/server ro rang:

- `src/client/index.ts(x)`: `extends Plugin` tu `@nocobase/client`, dang ky UI, schema initializer, schema settings, component, scope, provider, flow model.
- `src/server/index.ts` hoac `src/server/plugin.ts`: `extends Plugin` tu `@nocobase/server`, dang ky resource action, ACL, collection, migration, field type, hook du lieu.
- `src/index.ts`: export server plugin lam default package entry.
- `package.json`: `main` tro ve `dist/server/index.js`; client build tao `client.js`/`client.d.ts`.

Lifecycle hay gap:

- `beforeLoad()`: dung cho dang ky phai xong truoc khi datasource/collection/resource load, vi du custom field type, migration, hook `beforeAddDataSource`.
- `load()`: dung cho dang ky UI client, resource action server, ACL, provider, settings, initializer.
- `install()`: dung de seed du lieu ban dau, vi du `chinaRegions`.
- `beforeAddDataSource()`/`afterAddDataSource()`: dung khi moi data source deu can field type, action handler, hoac ACL action.

## 2. Extension point client

Client plugin thao tac chu yeu qua `this.app`:

| API | Dung khi |
| --- | --- |
| `addComponents({ Name: Component })` | Schema dung component string qua `x-component` |
| `addScopes({ useSomething })` | Schema dung hook/function qua `x-use-component-props`, `x-use-decorator-props`, expression scope |
| `use(Provider)` | Can provider hoac `SchemaComponentOptions` theo context |
| `dataSourceManager.addFieldInterfaces([...])` | Dang ky field interface cho Collection Manager |
| `schemaInitializerManager.add(...)` | Tao initializer moi |
| `schemaInitializerManager.addItem(...)` | Them item vao initializer co san |
| `schemaSettingsManager.add(...)` | Tao settings menu moi |
| `schemaSettingsManager.addItem(...)` | Them item vao settings co san |
| `flowEngine.registerModels(...)` | Dang ky flow model |
| `flowEngine.registerActions(...)` | Dang ky flow action runtime |

`this.app.addFieldInterfaces()` chi la shortcut den `this.app.dataSourceManager.collectionFieldInterfaceManager.addFieldInterfaces()`. Plugin moi nen uu tien `this.app.addFieldInterfaces(...)` hoac `this.app.dataSourceManager.addFieldInterfaces(...)`.

`SchemaInitializerManager` va `SchemaSettingsManager` co hang doi tam khi add item truoc luc initializer/settings ton tai. Vi vay plugin co the chen item vao cac menu core nhu `table:configureActions`, `table:configureItemActions`, `details:configureActions`, `gantt:configureActions`, `map:configureActions`.

## 3. Kien truc plugin action

Action plugin them nut hanh dong vao block hien co, sau do gan behavior bang mot trong cac cach:

- UI-only action dung resource/action core co san.
- Client flow model tu xu ly runtime bang API client.
- Server custom resource action theo collection/data source.
- Server global resource/config rieng cho action cau hinh duoc.

### 3.1. Client registration

Pattern trong `PluginAction*Client.load()`:

1. Dang ky provider/component/scope neu schema can.
2. Dang ky `SchemaSettings` cho nut.
3. Dang ky `ActionModel` neu dung flow engine.
4. Tao initializer data/schema.
5. Chen vao initializer cua block phu hop.

Schema action thuong gom cac key:

```ts
{
  type: 'void',
  title: '{{ t("...") }}',
  'x-component': 'Action' | 'Action.Link' | 'ImportAction' | 'CustomRequestAction',
  'x-action': 'export' | 'importXlsx' | 'duplicate' | 'customize:bulkUpdate',
  'x-use-component-props': 'useExportAction',
  'x-toolbar': 'ActionSchemaToolbar',
  'x-settings': 'actionSettings:export',
  'x-decorator': 'ACLActionProvider',
  'x-acl-action': 'update' | 'create' | 'importXlsx',
  'x-acl-action-props': { skipScopeCheck: true },
  'x-action-settings': {}
}
```

Initializer item thuong dung:

- `title`: label hien thi trong menu cau hinh.
- `Component`: initializer component, la component string da dang ky hoac React component.
- `schema`: schema mac dinh hoac phan merge vao schema cua initializer component.
- `useVisible`: thuong dung `useActionAvailable('actionName')` de an/hien theo ACL.
- `name`: ten item neu dung `BlockInitializer`.

### 3.2. Initializer variants

| Variant | Dung khi | Vi du |
| --- | --- | --- |
| `BlockInitializer` | Action tao popup/block con | bulk update, bulk edit |
| `ActionInitializerItem` | Action link/popup co schema co dinh | duplicate |
| `SchemaInitializerItem` | Can tinh schema hoac tao config truoc khi insert | import, export, custom request |

Import/export lay danh sach field hien tai de khoi tao `x-action-settings.importSettings` hoac `exportSettings`. Custom request tao config server truoc khi insert schema, thuong dung `x-uid` lam key lien ket.

### 3.3. Action settings

Action settings sua schema dang duoc edit. Pattern chung:

1. Lay schema bang `useFieldSchema()` hoac table column schema context.
2. Lay designable bang `useDesignable()`.
3. Sua `fieldSchema['x-action-settings']` hoac `fieldSchema['x-component-props']`.
4. Goi `dn.emit('patch', { schema: { 'x-uid': ..., ... } })`.
5. Goi `dn.refresh()`.

Items thuong gap:

- `ButtonEditor`/`ActionDesigner.ButtonEditor`: sua title/icon/type.
- `SchemaSettingsLinkageRules`: hien/an/disable theo dieu kien.
- `SchemaSettingsModalItem` hoac `type: 'actionModal'`: modal cau hinh nang cao.
- `SecondConFirm`: xac nhan lan hai.
- `AssignedFieldValues`: gan gia tri field cho bulk update/edit.
- `AfterSuccess`: message, close method, redirect, refresh block.
- `SchemaSettingAccessControl`: quyen truy cap nut.
- `RefreshDataBlockRequest`: refresh block sau action.
- `RemoveButton`: xoa action khoi schema.

Giu settings deprecated neu schema cu da luu ten do, vi du `ActionSettings:duplicate` song song `actionSettings:duplicate`.

### 3.4. Flow action model

Action model mo rong `ActionModel` tu core:

- `static scene = ActionSceneEnum.collection | record | all`.
- `defaultProps`: title/icon/type mac dinh.
- `getAclActionName()`: action ACL tuong ung.
- `static capabilityActionName`: map kha nang nhu `updateMany`.
- `registerFlow({ key, on: 'click', steps })`: runtime click flow.
- `registerFlow({ key, manual: true, steps })`: flow cau hinh settings.

`plugin-action-bulk-update` la mau ro: `BulkUpdateActionModel` co sub-model `AssignFormModel`, flow settings thu thap assigned values, flow `apply` goi API update tren collection hien tai va refresh block.

### 3.5. Server action modes

| Mode | Khi dung | Server pattern |
| --- | --- | --- |
| Server empty | Dung action/API core hoac client runtime flow | `load()` rong hoac khong co logic server |
| Per data source action | Moi collection/data source can resource action moi | `afterAddDataSource`, `resourceManager.registerActionHandler`, `acl.setAvailableAction` |
| Global resource/config | Action can config rieng khong thuoc collection action mac dinh | `resourceManager.define`, collection/config server, ACL snippet/role |

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

`plugin-action-import` them middleware upload, action `downloadXlsxTemplate`, action `importXlsx`, ACL `type: 'new-data'`, va error handler. `plugin-action-export`/`import` dung `ctx.getCurrentRepository()`, `ctx.dataSource.collectionManager`, service rieng, va mutex tranh chay dong thoi.

`plugin-action-custom-request` tao resource `customRequests`, luu cau hinh theo `x-uid`, parse bien runtime nhu `currentRecord`, `currentUser`, `$nForm`, `$env`, token, roi goi `serverRequest`.

### 3.6. Bang action plugin

| Plugin | Loai action | Client | Server | Diem chinh |
| --- | --- | --- | --- | --- |
| `plugin-action-bulk-update` | Collection action | Initializer table/gantt/map, settings, `BulkUpdateActionModel` | Empty | Dung `updateMany`/`update`, assign values, selected/all mode |
| `plugin-action-bulk-edit` | Collection popup action | Popup bulk edit form, custom flow models/actions | Empty | Tao popup form rieng, co field/action/block model rieng |
| `plugin-action-custom-request` | Configurable request action | Provider, initializer, settings request/after success | Resource `customRequests` | Cau hinh request luu server, send request voi bien runtime va ACL role |
| `plugin-action-duplicate` | Record action | Chen vao `table:configureItemActions`, popup schema, `DuplicateActionModel` | Empty | Dung quyen `create`, ho tro duplicate direct hoac copy vao form |
| `plugin-action-export` | Collection action | Initializer table/gantt, settings fields, `ExportActionModel` | Handler `export` per datasource | Xuat XLSX, dung field interface `toString`, ACL action `export` |
| `plugin-action-import` | Collection action | Initializer table/gantt, settings fields, `ImportActionModel` | `importXlsx`, `downloadXlsxTemplate` | Nhap XLSX, dung field interface `toValue`, middleware upload |
| `plugin-action-print` | Detail/calendar action | Provider, settings, initializer details/calendar | Empty | Print action dung component-props hook client |

## 4. Kien truc plugin field

Field plugin them `CollectionFieldInterface` vao Collection Manager. Neu can behavior DB moi thi them server field type; neu chi can UI thi server co the no-op.

### 4.1. CollectionFieldInterface

Field interface la contract quan trong nhat o client:

| Thuoc tinh/method | Y nghia |
| --- | --- |
| `name` | Ten interface, vi du `formula`, `sequence`, `attachmentURL` |
| `type` | Kieu abstract cua interface, thuong la `object` |
| `group`, `order` | Nhom va thu tu trong UI add field |
| `title`, `description` | Label va mo ta |
| `default` | Field options mac dinh, gom `type`, `uiSchema`, option rieng |
| `availableTypes` | Server/DB field type duoc map vao interface |
| `properties` | Form schema cau hinh field trong Collection Manager |
| `filterable` | Operators/children cho filter va variable |
| `sortable`, `titleUsable`, `hasDefaultValue`, `validationType` | Khai bao kha nang cua field |
| `isAssociation` | Danh dau field relation/association |
| `schemaInitialize(schema, data)` | Dieu chinh UI schema theo block/readPretty/target collection |
| `initialize(values)` | Bo sung options khi tao field |
| `validateSchema(fieldSchema)` | Them validation config rieng |

Dang ky:

```ts
this.app.dataSourceManager.addFieldInterfaces([MyFieldInterface]);
```

### 4.2. UI component, scope, provider, settings

Neu `default.uiSchema['x-component']` la component moi, dang ky component:

```ts
this.app.addComponents({ CodeEditor });
```

Neu schema dung hook:

```ts
{
  'x-use-component-props': 'useAttachmentUrlFieldProps'
}
```

dang ky scope:

```ts
this.app.addScopes({ useAttachmentUrlFieldProps });
```

Neu field can context rieng, boc provider bang `this.app.use(SequenceFieldProvider)`.

Field component settings thuong dat ten theo component:

```ts
new SchemaSettings({
  name: 'fieldSettings:component:CodeEditor',
  items: [...],
});
```

Hoac mo rong settings co san:

```ts
this.app.schemaSettingsManager.addItem(
  'fieldSettings:component:MarkdownVditor',
  'editMode',
  editModeSettingsItem,
);
```

Settings thuong sua `x-component-props`, vi du height/indent cua CodeEditor, quick upload/select file cua AttachmentUrl, edit mode cua MarkdownVditor, number display format cua Formula.Result.

### 4.3. Flow field model

Neu field can renderer moi trong flow engine, tao model mo rong `FieldModel` hoac model co san:

```ts
export class SortFieldModel extends FieldModel {
  render() {
    return <InputNumber {...this.props} />;
  }
}

EditableItemModel.bindModelToInterface('SortFieldModel', ['sort'], { isDefault: true });
DisplayItemModel.bindModelToInterface('DisplayNumberFieldModel', ['sort'], { isDefault: true });
```

Binding hay gap:

- `EditableItemModel.bindModelToInterface(...)`: form/edit mode.
- `DisplayItemModel.bindModelToInterface(...)`: details/table read-pretty mode.
- `FilterableItemModel.bindModelToInterface(...)`: filter form.
- `DetailsItemModel`/`FormItemModel`: truong hop association/detail/form phuc tap.

Model co the `registerFlow(...)` de them settings runtime, vi du formula number/date format hoac markdown content render mode.

### 4.4. Server field type va import/export interface

Tao server `Field` subclass khi field can behavior DB: tinh toan, sinh gia tri, validate, reorder, relation custom, hoac side effect.

Dang ky tren DB mac dinh:

```ts
this.db.registerFieldTypes({
  formula: FormulaField,
});
```

Dang ky cho moi Sequelize data source:

```ts
this.app.dataSourceManager.beforeAddDataSource((dataSource) => {
  if (dataSource.collectionManager instanceof SequelizeCollectionManager) {
    dataSource.collectionManager.registerFieldTypes({
      belongsToArray: BelongsToArrayField,
    });
  }
});
```

Field subclass thuong:

- `extends Field` cho column field.
- `extends RelationField` cho association field.
- Dinh nghia `get dataType()`.
- Override `bind()`/`unbind()` de gan/thao hook nhu `beforeSave`, `beforeCreate`, `beforeBulkCreate`, `afterSync`.
- Dung transaction tu hook options.

Import/export dung server `BaseInterface` khi string trong XLSX khong map truc tiep voi DB value:

```ts
this.app.db.interfaceManager.registerInterfaceType('chinaRegion', ChinaRegionInterface);
```

Interface implement:

- `toValue(str, ctx)`: string -> DB value khi import.
- `toString(value, ctx)`: DB value -> string khi export.

Import/export services lay interface theo `field.options.interface`, nen client interface name phai khop server interface type.

### 4.5. Bang field plugin

| Plugin | Interface/client | Storage/server | Diem chinh |
| --- | --- | --- | --- |
| `plugin-field-attachment-url` | `AttachmentURLFieldInterface`, component `AttachmentUrl`, scope props, settings quick upload/select file | `string`/`text`; server action list public file collections | UI upload/preview bang URL, model mo rong `UploadFieldModel` |
| `plugin-field-china-region` | `ChinaRegionFieldInterface`, `Cascader`, scopes load data | `belongsToMany` den `chinaRegions`; seed du lieu; `ChinaRegionInterface` | Association field chon tinh/thanh/quan, list-only ACL |
| `plugin-field-code` | `CodeFieldInterface`, component `CodeEditor`, settings height/indent/language | `text`; server no-op | UI code editor voi syntax highlighting |
| `plugin-field-formula` | `FormulaFieldInterface`, `Formula.Result`, settings number format, `FormulaFieldModel` | Custom `FormulaField`, type `formula`, hooks, migrations | Luu ket qua tinh toan theo expression va dataType |
| `plugin-field-m2m-array` | `MBMFieldInterface`, config components `MBMForeignKey`, `MBMTargetKey` | Custom `BelongsToArrayField`, hooks tao/xoa foreign key | Many-to-many luu mang target key trong foreignKey |
| `plugin-field-markdown-vditor` | `MarkdownVditorFieldInterface`, component `MarkdownVditor`, editable/display models | `text`/`json`/`string`; resource `vditor:check`, copy asset | Markdown editor nang cao, upload file check theo storage |
| `plugin-field-sequence` | `SequenceFieldInterface`, provider, rule config UI, bind model co san | Custom `SequenceField`, collection `sequences`, migrations, repair hook | Tu sinh ma theo rule va reset cycle |
| `plugin-field-sort` | `SortFieldInterface`, `SortFieldModel` | Custom `SortField` BIGINT, action `move`, lock manager | Drag/drop sorting va grouped sorting |

### 4.6. Mo rong field co san: `plugin-text-copy`

Dung pattern nay khi chi them behavior/UI vao field co san, khong tao field interface moi va khong tao server field type.

`PluginTextCopyClient` lam hai viec:

- Them setting `enableCopier` vao `fieldSettings:component:Input`.
- Them flow setting vao `DisplayTextFieldModel` va patch renderer de hien copy button o read-pretty.

Diem can giu khi lam plugin tuong tu:

- `addScopes({ TextCopyButton })` neu schema luu expression nhu `{{TextCopyButton}}`.
- Uu tien `useColumnSchema()` (import tu `@nocobase/client`) khi field nam trong table column; fallback `useFieldSchema()`.
- Khi settings thay doi, patch persisted schema bang `x-uid` va cap nhat runtime props neu can.
- Prototype patch chi nen dung khi khong co extension point sach hon.
- Luon bao ve prototype patch bang flag/Symbol de idempotent khi plugin reload.
- Test ca form/detail/table read-pretty vi schema settings va flow model co the di qua hai renderer khac nhau.

Server `PluginTextCopyServer` no-op.

## 5. Kien truc custom table block model

`packages/plugins/@nocobase-example/plugin-custom-table-block` la example tao bien the table block bang flow model, khong can server behavior.

Client entry chi can dang ky models:

```ts
export class PluginCustomTableBlockClient extends Plugin {
  async load() {
    this.flowEngine.registerModels(models);
  }
}
```

Model chinh:

```ts
export class CustomTableBlockModel extends TableBlockModel {
  customModelClasses = {
    CollectionActionGroupModel: 'CustomTableCollectionActionGroupModel',
    RecordActionGroupModel: 'CustomTableRecordActionGroupModel',
    TableColumnModel: 'CustomTableColumnModel',
    TableAssociationFieldGroupModel: null,
  };
}
```

`customModelClasses` thay sub-model ma `TableBlockModel` tao ra. Gia tri `null` vo hieu hoa sub-model do. Tat ca class name khac `null` phai duoc export va register vao `flowEngine`.

Custom table block example chi register model, khong tu hien trong UI. Plugin san pham muon nguoi dung chen block can them mot trong cac cach:

- `CustomTableBlockModel.define({ label, group, createModelOptions, sort })`.
- `schemaInitializerManager.addItem(...)`.
- Initializer rieng tao schema/model voi `use: 'CustomTableBlockModel'`.

Dung pattern nay khi can table giong table core nhung co composition khac: gioi han action group, thay renderer cot mac dinh, an association/custom column group, hoac them settings rieng ma khong anh huong table core.

## 6. Chon kien truc cho plugin moi

### 6.1. Field moi

| Nhu cau | Nen lam |
| --- | --- |
| UI moi tren DB type co san (`string`, `text`, `json`, `integer`) | Tao `CollectionFieldInterface`, component/scope/settings can thiet, server no-op hoac resource phu tro |
| Gia tri tinh toan, sinh tu dong, validate server, reorder, side effect | Tao server `Field` subclass, register field type som, them hook va migration neu can |
| Association dac thu | Set `isAssociation`, default relation type, target/key options, server `RelationField` neu relation khong co san |
| Import/export can mapping rieng | Them server `BaseInterface`, khop `field.options.interface`, implement `toValue`/`toString` |
| Chi them option nho vao field/renderer co san | Dung `schemaSettingsManager.addItem(...)`, `registerFlow(...)` tren model co san; patch prototype chi khi bat buoc |

Vi du:

- UI-only: code, attachment-url, markdown-vditor.
- Server field type: formula, sequence, sort.
- Association: china-region, m2m-array.
- Existing renderer extension: text-copy.

### 6.2. Action moi

| Nhu cau | Nen lam |
| --- | --- |
| Goi collection API/action core co san | Client initializer + schema action + settings; server co the empty |
| Resource action moi tren moi collection/data source | `afterAddDataSource`, `registerActionHandler`, `acl.setAvailableAction`, client `useActionAvailable` |
| Action co config rieng | Server collection/resource config, ACL snippet, lien ket config voi schema bang `x-uid` |
| Action mo popup/block con | Nested schema (`Action.Container`, tabs/grid/block con), initializer/settings rieng, flow sub-model neu dung engine moi |

Vi du:

- Core/API co san: bulk-update, duplicate, print.
- Per data source: import, export.
- Global config: custom-request.
- Popup/block con: bulk-edit, duplicate.

### 6.3. Custom table block moi

Dung custom table block khi behavior nam o composition/rendering cua block, khong phai field/action rieng le. Can tao `Custom<Table>BlockModel`, set `customModelClasses`, register tat ca sub-model, va expose block vao UI neu nguoi dung can chen tu designer.

## 7. Checklist ngan

### 7.1. Tao plugin field

1. Dat package `plugin-field-<name>`.
2. Tao `src/client/index.tsx` voi `PluginField<Name>Client extends Plugin`.
3. Tao `FieldInterface extends CollectionFieldInterface`.
4. Khai bao `name`, `group`, `title`, `default.type`, `default.uiSchema`, `availableTypes`, `properties`, `filterable`.
5. Dang ky interface trong `load()`.
6. Dang ky component/scope/provider/settings neu schema can.
7. Neu dung flow renderer moi, tao model, bind vao interface, register model.
8. Neu can DB behavior, tao server field type va register trong lifecycle phu hop.
9. Neu can XLSX conversion, tao server `BaseInterface`.
10. Them test cho hook/action server va UI designer path co lien quan.

### 7.2. Tao plugin action

1. Dat package `plugin-action-<name>`.
2. Tao `src/client/index.ts(x)` voi `PluginAction<Name>Client extends Plugin`.
3. Xac dinh scene: collection, record, details, popup, hay global config.
4. Tao initializer component neu can logic truoc khi insert schema.
5. Chen initializer vao dung menu block.
6. Dat schema action gom `x-action`, `x-component`, `x-toolbar`, `x-settings`, `x-acl-action`, `x-action-settings`.
7. Tao `SchemaSettings` ten `actionSettings:<name>`.
8. Dung `useActionAvailable('<serverAction>')` neu action phu thuoc ACL server.
9. Neu dung flow engine, tao `ActionModel`, set scene/default props/ACL, register flow.
10. Neu can server action/config, register resource/action/ACL va lien ket schema bang key on dinh.
11. Them test cho initializer/settings va server action/ACL neu co.

### 7.3. Tao custom table block

1. Tao `Custom<Table>BlockModel extends TableBlockModel`.
2. Set `customModelClasses` cho sub-model can thay.
3. Tao va export cac class sub-model thay the.
4. Register model map bang `this.flowEngine.registerModels(models)`.
5. Expose block vao UI bang `define(...)` hoac schema initializer neu can.
6. Neu muon bo sub-model, set key do ve `null`.
7. Server co the no-op neu block chi thay UI/flow model.

## 8. Quy tac thuc dung

- Dang ky custom field type som bang `beforeLoad()` hoac `beforeAddDataSource()` neu collection manager phai biet type khi load collection.
- Dang ky action handler theo datasource bang `afterAddDataSource()` khi handler can gan vao moi resource manager.
- Plugin chi them UI field tren DB type co san thi tranh tao server `Field` subclass.
- Ten `x-settings` phai khop `SchemaSettings.name`.
- Settings sua schema phai patch bang `x-uid` va refresh designable.
- Schema dung `x-use-component-props` thi hook phai duoc dang ky bang `addScopes` hoac provider `SchemaComponentOptions`.
- Schema dung component string thi component phai duoc dang ky bang `addComponents` hoac provider `SchemaComponentOptions`.
- Import/export dac thu phai co server `BaseInterface` vi services goi `toValue`/`toString` theo field interface.
- Multi data source ben server nen dung `this.app.dataSourceManager.beforeAddDataSource(callback)` / `afterAddDataSource(callback)` de register resource/action/ACL handler cho tung data source, khong chi thao tac `this.db` (main database).
- Giu deprecated settings/initializer name neu schema cu da tung luu ten do.
- Mo rong field/component co san thi uu tien `schemaSettingsManager.addItem(...)` va `registerFlow(...)` tren model co san.
- Prototype patch phai idempotent bang flag/Symbol va nen la lua chon cuoi.
- Custom block model: `registerModels` chi dang ky class; muon hien trong UI phai co `define(...)` hoac schema initializer.
- Moi class name trong `customModelClasses` phai ton tai trong model registry; `null` nghia la loai sub-model khoi luong tao con.

## 9. File tham khao nhanh

Action:

- `packages/plugins/@nocobase/plugin-action-bulk-update/src/client/index.tsx`
- `packages/plugins/@nocobase/plugin-action-bulk-update/src/client/BulkUpdateActionModel.tsx`
- `packages/plugins/@nocobase/plugin-action-bulk-edit/src/client/index.tsx`
- `packages/plugins/@nocobase/plugin-action-duplicate/src/client/DuplicateActionInitializer.tsx`
- `packages/plugins/@nocobase/plugin-action-export/src/server/index.ts`
- `packages/plugins/@nocobase/plugin-action-import/src/server/index.ts`
- `packages/plugins/@nocobase/plugin-action-custom-request/src/server/plugin.ts`

Field:

- `packages/plugins/@nocobase/plugin-field-code/src/client/interface.tsx`
- `packages/plugins/@nocobase/plugin-field-formula/src/client/interfaces/formula.tsx`
- `packages/plugins/@nocobase/plugin-field-formula/src/server/formula-field.ts`
- `packages/plugins/@nocobase/plugin-field-sequence/src/client/sequence.tsx`
- `packages/plugins/@nocobase/plugin-field-sequence/src/server/fields/sequence-field.ts`
- `packages/plugins/@nocobase/plugin-field-sort/src/server/sort-field.ts`
- `packages/plugins/@nocobase/plugin-field-china-region/src/server/interfaces/china-region-interface.ts`
- `packages/plugins/@nocobase/plugin-text-copy/src/client/index.tsx`
- `packages/plugins/@nocobase/plugin-text-copy/src/client/textCopyDisplayField.tsx`

Custom block:

- `packages/plugins/@nocobase-example/plugin-custom-table-block/src/client/plugin.tsx`
- `packages/plugins/@nocobase-example/plugin-custom-table-block/src/client/models/CustomTableBlockModel.tsx`
- `packages/plugins/@nocobase-example/plugin-custom-table-block-action-group/src/client/models/CustomTableBlockModel.tsx`
- `packages/plugins/@nocobase-example/plugin-custom-table-block-field/src/client/models/CustomTable3BlockModel.tsx`

Core:

- `packages/core/client/src/data-source/collection-field-interface/CollectionFieldInterface.ts`
- `packages/core/client/src/application/schema-initializer/SchemaInitializerManager.ts`
- `packages/core/client/src/application/schema-settings/SchemaSettingsManager.tsx`
- `packages/core/client/src/flow/models/base/ActionModel.tsx`
- `packages/core/client/src/flow/models/base/FieldModel.tsx`
- `packages/core/client/src/flow/models/base/BlockModel.tsx`
- `packages/core/client/src/flow/models/blocks/table/TableBlockModel.tsx`
- `packages/core/client/src/flow/models/blocks/table/TableColumnModel.tsx`

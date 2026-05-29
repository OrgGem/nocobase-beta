import type { Field } from '@formily/core';
import { useField, useFieldSchema } from '@formily/react';
import {
  getShouldChange,
  Plugin,
  removeNullCondition,
  SchemaSettingsDataScope,
  useCollection_deprecated,
  useCollectionField,
  useCollectionManager_deprecated,
  useColumnSchema,
  useDesignable,
  useFormBlockContext,
  useLocalVariables,
  useRecord,
  useSchemaSettings,
  useVariables,
  VariableInput,
} from '@nocobase/client';
import React from 'react';
import { useTranslation } from 'react-i18next';

type CollectionFieldLike = {
  interface?: string;
  name?: string;
  target?: string;
  targetCollection?: string | { name?: string };
  uiSchema?: Record<string, any>;
};

const ASSOCIATION_INTERFACES = [
  'obo',
  'oho',
  'o2o',
  'o2m',
  'm2m',
  'm2o',
  'linkTo',
  'snapshot',
  'createdBy',
  'updatedBy',
];
const SELECTABLE_MODES = ['Select', 'Picker', 'RecordPicker', 'CascadeSelect'];

function getTargetCollectionName(collectionField?: CollectionFieldLike) {
  const target = collectionField?.target || collectionField?.targetCollection;

  return typeof target === 'string' ? target : target?.name;
}

function isSelectionField(collectionField?: CollectionFieldLike) {
  if (!getTargetCollectionName(collectionField)) {
    return false;
  }

  return !collectionField?.interface || ASSOCIATION_INTERFACES.includes(collectionField.interface);
}

function getFieldMode(fieldSchema?: any, collectionField?: CollectionFieldLike) {
  return (
    fieldSchema?.['x-component-props']?.mode ||
    collectionField?.uiSchema?.['x-component-props']?.mode ||
    'Select'
  );
}

function withServiceFilter(componentProps: Record<string, any> = {}, filter: any) {
  const service = componentProps.service && typeof componentProps.service === 'object' ? componentProps.service : {};
  const params = service.params && typeof service.params === 'object' ? service.params : {};

  return {
    ...componentProps,
    service: {
      ...service,
      params: {
        ...params,
        filter,
      },
    },
  };
}

function syncRenderedFieldInstances(field: Field, fieldSchema: any, componentProps: Record<string, any>) {
  if (!fieldSchema?.name || !field?.form?.query) {
    return;
  }

  if (field.props?.name === fieldSchema.name) {
    field.componentProps = {
      ...field.componentProps,
      ...componentProps,
    };
  }

  const path = field.path?.splice?.(field.path?.length - 1, 1);
  if (!path?.concat) {
    return;
  }

  field.form.query(`${path.concat(`*.` + fieldSchema.name)}`).forEach((runtimeField: Field) => {
    runtimeField.componentProps = {
      ...runtimeField.componentProps,
      ...componentProps,
    };
  });
}

function useTableColumnSelectionContext() {
  const { getCollectionJoinField, getAllCollectionsInheritChain } = useCollectionManager_deprecated();
  const { getField } = useCollection_deprecated();
  const { fieldSchema: tableColumnFieldSchema, collectionField: tableColumnCollectionField } = useColumnSchema();
  const currentSchema = useFieldSchema();
  const targetCollectionField = useCollectionField();
  
  // Try to get column/field schema from SchemaSettings context to avoid context loss in Portals/Dropdown menus
  const schemaSettings = useSchemaSettings();
  const parentSchema = schemaSettings?.fieldSchema;
  const tableColumnFieldSchemaFromSettings = parentSchema?.reduceProperties((buf, s) => {
    if (s['x-component'] === 'CollectionField') {
      return s;
    }
    return buf;
  }, null);

  const fieldSchema = tableColumnFieldSchema || tableColumnFieldSchemaFromSettings || currentSchema;
  const collectionField =
    tableColumnCollectionField ||
    targetCollectionField ||
    getField(fieldSchema?.name) ||
    getCollectionJoinField(fieldSchema?.['x-collection-field']);

  return {
    collectionField,
    fieldSchema,
    getAllCollectionsInheritChain,
  };
}

const fieldSelectionDataScopeSettingsItem = {
  Component: SchemaSettingsDataScope,
  sort: 45,
  useVisible() {
    const { collectionField, fieldSchema } = useTableColumnSelectionContext();
    const fieldMode = getFieldMode(fieldSchema, collectionField);
    
    console.log('[plugin-field-selection-filter] useVisible:', {
      collectionField,
      fieldSchema,
      fieldMode,
      isSelection: isSelectionField(collectionField),
      selectableMode: SELECTABLE_MODES.includes(fieldMode),
      modes: SELECTABLE_MODES
    });

    return isSelectionField(collectionField) && SELECTABLE_MODES.includes(fieldMode);
  },
  useComponentProps() {
    const { t } = useTranslation();
    const field = useField<Field>();
    const { collectionField, fieldSchema, getAllCollectionsInheritChain } = useTableColumnSelectionContext();
    const { form } = useFormBlockContext();
    const record = useRecord();
    const variables = useVariables();
    const localVariables = useLocalVariables();
    const { dn } = useDesignable();

    return {
      title: t('Set field selection filter'),
      collectionName: getTargetCollectionName(collectionField),
      defaultFilter: fieldSchema?.['x-component-props']?.service?.params?.filter || {},
      form,
      dynamicComponent: (props: any) => {
        return (
          <VariableInput
            {...props}
            form={form}
            collectionField={props.collectionField}
            record={record}
            noDisabled={true}
            shouldChange={getShouldChange({
              collectionField: props.collectionField,
              variables,
              localVariables,
              getAllCollectionsInheritChain,
            })}
          />
        );
      },
      onSubmit: ({ filter }) => {
        const nextFilter = removeNullCondition(filter);
        const nextComponentProps = withServiceFilter(fieldSchema?.['x-component-props'] || {}, nextFilter);

        fieldSchema['x-component-props'] = nextComponentProps;
        syncRenderedFieldInstances(field, fieldSchema, nextComponentProps);

        dn.emit('patch', {
          schema: {
            'x-uid': fieldSchema['x-uid'],
            'x-component-props': nextComponentProps,
          },
        });
        dn.refresh();
      },
    };
  },
};

export class PluginFieldSelectionFilterClient extends Plugin {
  async load() {
    // Register to component-specific settings for different field modes
    // This allows it to show up under "Specific properties" in both Form and Table settings, like copy settings
    this.app.schemaSettingsManager.addItem(
      'fieldSettings:component:Select',
      'fieldSelectionDataScope',
      fieldSelectionDataScopeSettingsItem,
    );
    this.app.schemaSettingsManager.addItem(
      'fieldSettings:component:Picker',
      'fieldSelectionDataScope',
      fieldSelectionDataScopeSettingsItem,
    );
    this.app.schemaSettingsManager.addItem(
      'fieldSettings:component:CascadeSelect',
      'fieldSelectionDataScope',
      fieldSelectionDataScopeSettingsItem,
    );

    // Keep tableColumn and formItem for backward compatibility and extra entry points
    this.app.schemaSettingsManager.addItem(
      'fieldSettings:TableColumn',
      'decoratorOptions.fieldSelectionDataScope',
      fieldSelectionDataScopeSettingsItem,
    );
    this.app.schemaSettingsManager.addItem(
      'fieldSettings:FormItem',
      'decoratorOptions.fieldSelectionDataScope',
      fieldSelectionDataScopeSettingsItem,
    );
  }
}

export default PluginFieldSelectionFilterClient;

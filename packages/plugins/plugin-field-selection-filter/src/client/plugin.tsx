import {
  FilterGroup,
  Plugin,
  QuickEditFormModel,
  SelectFieldModel,
  TableColumnModel,
  TableSelectModel,
  VariableFilterItem,
} from '@nocobase/client-v2';
import { defineAction, FlowEngine, FlowModel, useFlowSettingsContext } from '@nocobase/flow-engine';
import React from 'react';
import { tExpr } from './locale';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type FilterValue = Record<string, JsonValue>;

type FieldSelectionFilterParams = {
  filter?: FilterValue;
};

type FieldSelectionOptionScopeParams = {
  sourceFieldPath?: string;
  optionPath?: string;
  clearInvalidValue?: boolean;
};

type CollectionFieldLike = {
  interface?: string;
  target?: string;
  targetCollection?: { name?: string };
  uiSchema?: {
    enum?: Array<Record<string, JsonValue>>;
  };
  isAssociationField?: () => boolean;
};

type FieldModelLike = FlowModel & {
  collectionField?: CollectionFieldLike;
};

type TableColumnModelLike = TableColumnModel & {
  associationPathName?: string;
  collectionField?: CollectionFieldLike;
  subModels?: {
    field?: FieldModelLike;
  };
};

type FlowRuntimeContextLike<TModel = FlowModel> = {
  model: TModel;
  engine?: {
    getModel?: (uid: string, useCache?: boolean) => FlowModel | undefined;
  };
  inputArgs?: Record<string, unknown>;
  item?: { value?: unknown };
  record?: unknown;
  runAction?: (key: string, params?: unknown) => Promise<unknown>;
  view?: {
    inputArgs?: Record<string, unknown>;
  };
};

type SubModelContainerLike = FlowModel & {
  subModels?: Record<string, FlowModel | FlowModel[] | undefined>;
};

const EMPTY_FILTER: FilterValue = { logic: '$and', items: [] };
const TABLE_COLUMN_FLOW_KEY = 'fieldSelectionFilterSettings';
const FIELD_DATA_SCOPE_FLOW_KEY = 'selectSettings';
const FIELD_DATA_SCOPE_STEP_KEY = 'dataScope';
const FIELD_OPTION_SCOPE_FLOW_KEY = 'fieldSelectionOptionFilterSettings';
const FIELD_OPTION_SCOPE_STEP_KEY = 'optionScope';
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
  'mbm',
];
const ENUM_SELECTION_INTERFACES = ['select', 'multipleSelect', 'radioGroup', 'checkboxGroup'];
const originalOptionCache = new WeakMap<FlowModel, Array<Record<string, JsonValue>>>();

function getColumnFieldModel(model?: FlowModel): FieldModelLike | undefined {
  const field = (model as TableColumnModelLike | undefined)?.subModels?.field;
  return field instanceof FlowModel ? (field as FieldModelLike) : undefined;
}

function getCollectionField(model?: FlowModel): CollectionFieldLike | undefined {
  const columnModel = model as TableColumnModelLike | undefined;
  const fieldModel = getColumnFieldModel(model);
  return (
    columnModel?.context?.collectionField ||
    columnModel?.collectionField ||
    fieldModel?.context?.collectionField ||
    fieldModel?.collectionField
  );
}

function getFirstSubModel(model: SubModelContainerLike | undefined, subModelKey: string): FieldModelLike | undefined {
  const subModelValue = model?.subModels?.[subModelKey];
  const subModel = Array.isArray(subModelValue) ? subModelValue[0] : subModelValue;
  return subModel instanceof FlowModel ? (subModel as FieldModelLike) : undefined;
}

function getTargetCollectionName(collectionField?: CollectionFieldLike) {
  const target = collectionField?.target || collectionField?.targetCollection;
  return typeof target === 'string' ? target : target?.name;
}

function isAssociationSelectionField(collectionField?: CollectionFieldLike) {
  if (!getTargetCollectionName(collectionField)) {
    return false;
  }

  if (typeof collectionField?.isAssociationField === 'function') {
    return collectionField.isAssociationField();
  }

  return !collectionField?.interface || ASSOCIATION_INTERFACES.includes(collectionField.interface);
}

function isAssociationSelectionTableColumn(model?: FlowModel) {
  const columnModel = model as TableColumnModelLike | undefined;
  if (!columnModel || columnModel.use !== 'TableColumnModel') {
    return false;
  }

  if (!getColumnFieldModel(columnModel)) {
    return false;
  }

  return isAssociationSelectionField(getCollectionField(columnModel));
}

function isEnumSelectionField(collectionField?: CollectionFieldLike) {
  return !!collectionField?.interface && ENUM_SELECTION_INTERFACES.includes(collectionField.interface);
}

function isEnumSelectionTableColumn(model?: FlowModel) {
  const columnModel = model as TableColumnModelLike | undefined;
  if (!columnModel || columnModel.use !== 'TableColumnModel') {
    return false;
  }

  if (!getColumnFieldModel(columnModel)) {
    return false;
  }

  return isEnumSelectionField(getCollectionField(columnModel));
}

function cloneFilterParams(params?: FieldSelectionFilterParams): FieldSelectionFilterParams {
  return JSON.parse(JSON.stringify(params || { filter: EMPTY_FILTER })) as FieldSelectionFilterParams;
}

function cloneOptionScopeParams(params?: FieldSelectionOptionScopeParams): FieldSelectionOptionScopeParams {
  return JSON.parse(JSON.stringify(params || {})) as FieldSelectionOptionScopeParams;
}

function getFieldDataScopeParams(fieldModel?: FieldModelLike): FieldSelectionFilterParams | undefined {
  return fieldModel?.getStepParams?.(FIELD_DATA_SCOPE_FLOW_KEY, FIELD_DATA_SCOPE_STEP_KEY);
}

function getFieldOptionScopeParams(fieldModel?: FieldModelLike): FieldSelectionOptionScopeParams | undefined {
  return fieldModel?.getStepParams?.(FIELD_OPTION_SCOPE_FLOW_KEY, FIELD_OPTION_SCOPE_STEP_KEY);
}

function getTableColumnDataScopeParams(model?: FlowModel): FieldSelectionFilterParams | undefined {
  return model?.getStepParams?.(TABLE_COLUMN_FLOW_KEY, FIELD_DATA_SCOPE_STEP_KEY);
}

function hasSelectionFilterConfig(model?: FlowModel, fieldModel?: FieldModelLike) {
  return !!getTableColumnDataScopeParams(model) || !!getFieldDataScopeParams(fieldModel);
}

function syncFieldDataScopeParams(fieldModel: FieldModelLike | undefined, params?: FieldSelectionFilterParams) {
  if (!fieldModel) {
    return;
  }

  fieldModel.setStepParams(FIELD_DATA_SCOPE_FLOW_KEY, FIELD_DATA_SCOPE_STEP_KEY, cloneFilterParams(params));
}

function syncFieldOptionScopeParams(fieldModel: FieldModelLike | undefined, params?: FieldSelectionOptionScopeParams) {
  if (!fieldModel) {
    return;
  }

  fieldModel.setStepParams(FIELD_OPTION_SCOPE_FLOW_KEY, FIELD_OPTION_SCOPE_STEP_KEY, cloneOptionScopeParams(params));
}

function createFilterContextModel(sourceModel: FlowModel, collectionField?: CollectionFieldLike) {
  const filterModel = new FlowModel({
    uid: `${sourceModel.uid}-field-selection-filter-context`,
    flowEngine: sourceModel.flowEngine,
  });
  filterModel.context.addDelegate(sourceModel.context);
  filterModel.context.defineProperty('collection', {
    get: () => collectionField?.targetCollection,
    cache: false,
  });
  return filterModel;
}

function readPath(source: unknown, path?: string): unknown {
  if (!path) {
    return undefined;
  }

  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, source);
}

function normalizeCompareValue(value: unknown): unknown {
  if (value && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

function optionMatchesScope(optionValue: unknown, sourceValue: unknown) {
  if (Array.isArray(sourceValue)) {
    return sourceValue.map(normalizeCompareValue).includes(normalizeCompareValue(optionValue));
  }

  return normalizeCompareValue(optionValue) === normalizeCompareValue(sourceValue);
}

function getFieldOriginalOptions(model: FlowModel, collectionField?: CollectionFieldLike) {
  const enumOptions = collectionField?.uiSchema?.enum;
  if (Array.isArray(enumOptions)) {
    return enumOptions.map((option) => ({ ...option }));
  }

  const cached = originalOptionCache.get(model);
  if (cached) {
    return cached.map((option) => ({ ...option }));
  }

  const propsOptions = (model as FieldModelLike).props?.options;
  if (Array.isArray(propsOptions)) {
    const cloned = propsOptions.map((option) => ({ ...option }));
    originalOptionCache.set(model, cloned);
    return cloned.map((option) => ({ ...option }));
  }

  return [];
}

function getRuntimeRecord(ctx: Record<string, unknown>, model: FieldModelLike) {
  const item = ctx.item as { value?: unknown } | undefined;
  return ctx.record || item?.value || model.context?.record;
}

function getOptionValue(option: Record<string, JsonValue>, optionPath?: string) {
  if (!optionPath) {
    return undefined;
  }
  return readPath(option, optionPath);
}

function valueExistsInOptions(value: unknown, options: Array<Record<string, JsonValue>>) {
  const optionValues = options.map((option) => option.value);
  if (Array.isArray(value)) {
    return value.every((item) => optionValues.includes(item));
  }
  return optionValues.includes(value as JsonValue);
}

const fieldSelectionDataScope = defineAction<TableColumnModelLike>({
  name: 'fieldSelectionDataScope',
  title: tExpr('Set field selection filter'),
  uiMode: {
    type: 'dialog',
    props: {
      width: 800,
    },
  },
  uiSchema: {
    filter: {
      type: 'object',
      'x-decorator': 'FormItem',
      'x-component': function FieldSelectionFilterComponent(props: {
        value?: FilterValue;
        onChange?: (value: FilterValue) => void;
      }) {
        const flowContext = useFlowSettingsContext<TableColumnModelLike>();
        const fieldModel = getColumnFieldModel(flowContext.model);
        const sourceModel = fieldModel || flowContext.model;
        const collectionField = getCollectionField(flowContext.model);
        const filterModel = React.useMemo(
          () => createFilterContextModel(sourceModel, collectionField),
          [collectionField, sourceModel],
        );

        return (
          <FilterGroup
            value={props.value}
            onChange={props.onChange}
            FilterItem={(filterItemProps: Record<string, unknown>) => (
              <VariableFilterItem {...filterItemProps} model={filterModel} rightAsVariable />
            )}
          />
        );
      },
    },
  },
  defaultParams(ctx) {
    return getFieldDataScopeParams(getColumnFieldModel(ctx.model)) || { filter: EMPTY_FILTER };
  },
  useRawParams: true,
  async handler(ctx, params: FieldSelectionFilterParams) {
    const fieldModel = getColumnFieldModel(ctx.model);
    if (!hasSelectionFilterConfig(ctx.model, fieldModel)) {
      return;
    }
    syncFieldDataScopeParams(fieldModel, params);
    if (fieldModel?.getFlow(FIELD_DATA_SCOPE_FLOW_KEY)) {
      await fieldModel.applyFlow(FIELD_DATA_SCOPE_FLOW_KEY);
    }
  },
});

const fieldSelectionOptionScope = defineAction<TableColumnModelLike>({
  name: 'fieldSelectionOptionScope',
  title: tExpr('Set enum option filter'),
  uiMode: {
    type: 'dialog',
    props: {
      width: 520,
    },
  },
  uiSchema: {
    sourceFieldPath: {
      type: 'string',
      title: tExpr('Source field path'),
      'x-decorator': 'FormItem',
      'x-component': 'Input',
      required: true,
      description: tExpr('Example: city or city.id'),
    },
    optionPath: {
      type: 'string',
      title: tExpr('Option scope path'),
      'x-decorator': 'FormItem',
      'x-component': 'Input',
      required: true,
      description: tExpr('Example: city or cityId on each enum option'),
    },
    clearInvalidValue: {
      type: 'boolean',
      title: tExpr('Clear value when it is outside the filtered options'),
      'x-decorator': 'FormItem',
      'x-component': 'Switch',
    },
  },
  defaultParams: {
    clearInvalidValue: true,
  },
  useRawParams: true,
  async handler(ctx, params: FieldSelectionOptionScopeParams) {
    const fieldModel = getColumnFieldModel(ctx.model);
    syncFieldOptionScopeParams(fieldModel, params);
    if (fieldModel?.getFlow(FIELD_OPTION_SCOPE_FLOW_KEY)) {
      await fieldModel.applyFlow(FIELD_OPTION_SCOPE_FLOW_KEY);
    }
  },
});

export class PluginFieldSelectionFilterClient extends Plugin {
  declare flowEngine: FlowEngine;

  async load() {
    this.flowEngine.registerActions({
      fieldSelectionDataScope,
      fieldSelectionOptionScope,
    });

    SelectFieldModel.registerFlow({
      key: FIELD_OPTION_SCOPE_FLOW_KEY,
      sort: 805,
      on: {
        eventName: 'beforeRender',
        phase: 'afterAllFlows',
      },
      steps: {
        optionScope: {
          title: tExpr('Enum option filter'),
          async handler(ctx: FlowRuntimeContextLike<FieldModelLike>, params: FieldSelectionOptionScopeParams) {
            const fieldModel = ctx.model as FieldModelLike;
            const config = params || getFieldOptionScopeParams(fieldModel);
            if (!config?.sourceFieldPath || !config?.optionPath) {
              return;
            }

            const record = getRuntimeRecord(ctx as Record<string, unknown>, fieldModel);
            const sourceValue = readPath(record, config.sourceFieldPath);
            const originalOptions = getFieldOriginalOptions(fieldModel, getCollectionField(fieldModel));

            if (sourceValue === undefined || sourceValue === null || sourceValue === '') {
              fieldModel.setProps({ options: originalOptions });
              return;
            }

            const filteredOptions = originalOptions.filter((option) =>
              optionMatchesScope(getOptionValue(option, config.optionPath), sourceValue),
            );
            fieldModel.setProps({ options: filteredOptions });

            if (
              config.clearInvalidValue !== false &&
              fieldModel.props?.value !== undefined &&
              !valueExistsInOptions(fieldModel.props.value, filteredOptions)
            ) {
              fieldModel.props?.onChange?.(Array.isArray(fieldModel.props.value) ? [] : undefined);
            }
          },
        },
      },
    });

    TableColumnModel.registerFlow({
      key: TABLE_COLUMN_FLOW_KEY,
      sort: 505,
      steps: {
        dataScope: {
          use: 'fieldSelectionDataScope',
          title: tExpr('Set field selection filter'),
          hideInSettings(ctx: FlowRuntimeContextLike) {
            return !isAssociationSelectionTableColumn(ctx.model);
          },
          async beforeParamsSave(ctx: FlowRuntimeContextLike, params: FieldSelectionFilterParams) {
            const fieldModel = getColumnFieldModel(ctx.model);
            syncFieldDataScopeParams(fieldModel, params);
            await fieldModel?.saveStepParams?.();
          },
          async handler(ctx: FlowRuntimeContextLike, params: FieldSelectionFilterParams) {
            const fieldModel = getColumnFieldModel(ctx.model);
            if (!hasSelectionFilterConfig(ctx.model, fieldModel)) {
              return;
            }
            syncFieldDataScopeParams(fieldModel, params);
            if (fieldModel?.getFlow(FIELD_DATA_SCOPE_FLOW_KEY)) {
              await fieldModel.applyFlow(FIELD_DATA_SCOPE_FLOW_KEY);
            }
          },
        },
        optionScope: {
          use: 'fieldSelectionOptionScope',
          title: tExpr('Set enum option filter'),
          hideInSettings(ctx: FlowRuntimeContextLike) {
            return !isEnumSelectionTableColumn(ctx.model);
          },
          async beforeParamsSave(ctx: FlowRuntimeContextLike, params: FieldSelectionOptionScopeParams) {
            const fieldModel = getColumnFieldModel(ctx.model);
            syncFieldOptionScopeParams(fieldModel, params);
            await fieldModel?.saveStepParams?.();
          },
          async handler(ctx: FlowRuntimeContextLike, params: FieldSelectionOptionScopeParams) {
            const fieldModel = getColumnFieldModel(ctx.model);
            syncFieldOptionScopeParams(fieldModel, params);
            if (fieldModel?.getFlow(FIELD_OPTION_SCOPE_FLOW_KEY)) {
              await fieldModel.applyFlow(FIELD_OPTION_SCOPE_FLOW_KEY);
            }
          },
        },
      },
    });

    QuickEditFormModel.registerFlow({
      key: TABLE_COLUMN_FLOW_KEY,
      sort: 105,
      on: {
        eventName: 'beforeRender',
        phase: 'afterFlow',
        flowKey: 'quickEditFormSettings',
      },
      steps: {
        dataScope: {
          title: tExpr('Field selection filter'),
          async handler(ctx: FlowRuntimeContextLike<SubModelContainerLike>) {
            const sourceFieldModelUid = ctx.inputArgs?.sourceFieldModelUid;
            const sourceFieldModel =
              typeof sourceFieldModelUid === 'string' && ctx.engine?.getModel
                ? (ctx.engine.getModel(sourceFieldModelUid, true) as FieldModelLike | undefined)
                : undefined;
            const params = getFieldDataScopeParams(sourceFieldModel);
            const optionParams = getFieldOptionScopeParams(sourceFieldModel);
            if (!params && !optionParams) {
              return;
            }

            const quickEditField = getFirstSubModel(ctx.model as SubModelContainerLike, 'fields');
            if (params) {
              syncFieldDataScopeParams(quickEditField, params);
            }
            if (optionParams) {
              syncFieldOptionScopeParams(quickEditField, optionParams);
            }
            await quickEditField?.dispatchEvent?.('beforeRender', undefined, { useCache: false });
          },
        },
      },
    });

    TableSelectModel.registerFlow({
      key: 'fieldSelectionFilterSettings',
      sort: 505,
      steps: {
        dataScope: {
          title: tExpr('Field selection filter'),
          async handler(ctx: FlowRuntimeContextLike) {
            const sourceFieldModelUid = ctx.view?.inputArgs?.parentId;
            const sourceFieldModel =
              typeof sourceFieldModelUid === 'string' && ctx.engine?.getModel
                ? (ctx.engine.getModel(sourceFieldModelUid, true) as FieldModelLike | undefined)
                : undefined;
            const params = getFieldDataScopeParams(sourceFieldModel);
            if (params && ctx.runAction) {
              await ctx.runAction('dataScope', params);
            }
          },
        },
      },
    });
  }
}

export default PluginFieldSelectionFilterClient;

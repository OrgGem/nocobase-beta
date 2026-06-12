import {
  FilterGroup,
  Plugin,
  QuickEditFormModel,
  TableColumnModel,
  TableSelectModel,
  VariableFilterItem,
} from '@nocobase/client';
import { defineAction, FlowModel, useFlowSettingsContext } from '@nocobase/flow-engine';
import React from 'react';
import { tExpr } from './locale';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type FilterValue = Record<string, JsonValue>;

type FieldSelectionFilterParams = {
  filter?: FilterValue;
};

type CollectionFieldLike = {
  interface?: string;
  target?: string;
  targetCollection?: { name?: string };
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

type SubModelContainerLike = FlowModel & {
  subModels?: Record<string, FlowModel | FlowModel[] | undefined>;
};

const EMPTY_FILTER: FilterValue = { logic: '$and', items: [] };
const TABLE_COLUMN_FLOW_KEY = 'fieldSelectionFilterSettings';
const FIELD_DATA_SCOPE_FLOW_KEY = 'selectSettings';
const FIELD_DATA_SCOPE_STEP_KEY = 'dataScope';
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

function getColumnFieldModel(model?: FlowModel): FieldModelLike | undefined {
  const field = (model as TableColumnModelLike | undefined)?.subModels?.field;
  return field instanceof FlowModel ? field : undefined;
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

function isSelectableTableColumn(model?: FlowModel) {
  const columnModel = model as TableColumnModelLike | undefined;
  if (!columnModel || columnModel.use !== 'TableColumnModel') {
    return false;
  }

  if (!getColumnFieldModel(columnModel)) {
    return false;
  }

  return isAssociationSelectionField(getCollectionField(columnModel));
}

function cloneFilterParams(params?: FieldSelectionFilterParams): FieldSelectionFilterParams {
  return JSON.parse(JSON.stringify(params || { filter: EMPTY_FILTER })) as FieldSelectionFilterParams;
}

function getFieldDataScopeParams(fieldModel?: FieldModelLike): FieldSelectionFilterParams | undefined {
  return fieldModel?.getStepParams?.(FIELD_DATA_SCOPE_FLOW_KEY, FIELD_DATA_SCOPE_STEP_KEY);
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
      'x-component': function FieldSelectionFilterComponent(props) {
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
            FilterItem={(filterItemProps) => (
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

export class PluginFieldSelectionFilterClient extends Plugin {
  async load() {
    this.flowEngine.registerActions({
      fieldSelectionDataScope,
    });

    TableColumnModel.registerFlow({
      key: TABLE_COLUMN_FLOW_KEY,
      sort: 505,
      steps: {
        dataScope: {
          use: 'fieldSelectionDataScope',
          title: tExpr('Set field selection filter'),
          hideInSettings(ctx) {
            return !isSelectableTableColumn(ctx.model);
          },
          async beforeParamsSave(ctx, params: FieldSelectionFilterParams) {
            const fieldModel = getColumnFieldModel(ctx.model);
            syncFieldDataScopeParams(fieldModel, params);
            await fieldModel?.saveStepParams?.();
          },
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
          async handler(ctx) {
            const sourceFieldModelUid = ctx.inputArgs?.sourceFieldModelUid;
            const sourceFieldModel =
              typeof sourceFieldModelUid === 'string'
                ? (ctx.engine.getModel(sourceFieldModelUid) as FieldModelLike | undefined)
                : undefined;
            const params = getFieldDataScopeParams(sourceFieldModel);
            if (!params) {
              return;
            }

            const quickEditField = getFirstSubModel(ctx.model as SubModelContainerLike, 'fields');
            syncFieldDataScopeParams(quickEditField, params);
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
          async handler(ctx) {
            const sourceFieldModelUid = ctx.view?.inputArgs?.parentId;
            const sourceFieldModel =
              typeof sourceFieldModelUid === 'string'
                ? (ctx.engine.getModel(sourceFieldModelUid, true) as FieldModelLike | undefined)
                : undefined;
            const params = getFieldDataScopeParams(sourceFieldModel);
            if (params) {
              await ctx.runAction('dataScope', params);
            }
          },
        },
      },
    });
  }
}

export default PluginFieldSelectionFilterClient;

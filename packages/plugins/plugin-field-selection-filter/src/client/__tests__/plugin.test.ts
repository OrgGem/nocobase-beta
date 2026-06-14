import { QuickEditFormModel, TableColumnModel, TableSelectModel } from '@nocobase/client-v2';
import { FlowEngine, FlowModel } from '@nocobase/flow-engine';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import PluginFieldSelectionFilterClientV2 from '../../client-v2/plugin';
import { PluginFieldSelectionFilterClient } from '../plugin';

type FilterParams = {
  filter: {
    logic: '$and';
    items: Array<Record<string, unknown>>;
  };
};

type TestStep = {
  hideInSettings?: (ctx: { model: unknown }) => boolean | Promise<boolean>;
  beforeParamsSave?: (ctx: { model: unknown }, params: FilterParams) => Promise<void>;
  handler?: (ctx: Record<string, unknown>, params?: FilterParams) => Promise<void>;
};

const params: FilterParams = {
  filter: {
    logic: '$and',
    items: [{ path: 'status', operator: '$eq', value: 'active' }],
  },
};

function createFieldModel(engine: FlowEngine, uid: string) {
  return engine.createModel<FlowModel>({
    uid,
    use: FlowModel,
  });
}

describe('PluginFieldSelectionFilterClient', () => {
  beforeAll(async () => {
    await PluginFieldSelectionFilterClient.prototype.load.call({
      flowEngine: {
        registerActions: vi.fn(),
      },
    } as unknown as PluginFieldSelectionFilterClient);
  });

  it('shows the setting only for association table columns', async () => {
    const engine = new FlowEngine();
    const associationField = createFieldModel(engine, 'association-field');
    associationField.context.defineProperty('collectionField', {
      value: {
        isAssociationField: () => false,
      },
    });
    const scalarField = createFieldModel(engine, 'scalar-field');
    scalarField.context.defineProperty('collectionField', {
      value: {
        isAssociationField: () => false,
      },
    });
    const step = TableColumnModel.globalFlowRegistry.getFlow('fieldSelectionFilterSettings')?.steps
      ?.dataScope as TestStep;

    expect(
      await step.hideInSettings?.({
        model: {
          use: 'TableColumnModel',
          collectionField: {
            target: 'departments',
            isAssociationField: () => true,
          },
          subModels: { field: associationField },
        },
      }),
    ).toBe(false);
    expect(
      await step.hideInSettings?.({
        model: {
          use: 'TableColumnModel',
          subModels: { field: scalarField },
        },
      }),
    ).toBe(true);
  });

  it('persists the table-column filter on its nested field model', async () => {
    const engine = new FlowEngine();
    const field = createFieldModel(engine, 'persisted-field');
    const saveStepParams = vi.spyOn(field, 'saveStepParams').mockResolvedValue(undefined);
    const step = TableColumnModel.globalFlowRegistry.getFlow('fieldSelectionFilterSettings')?.steps
      ?.dataScope as TestStep;

    await step.beforeParamsSave?.(
      {
        model: {
          use: 'TableColumnModel',
          subModels: { field },
        },
      },
      params,
    );

    expect(field.getStepParams('selectSettings', 'dataScope')).toEqual(params);
    expect(saveStepParams).toHaveBeenCalledOnce();
  });

  it('propagates the configured filter into the quick-edit field model', async () => {
    const engine = new FlowEngine();
    const sourceField = createFieldModel(engine, 'quick-edit-source');
    sourceField.setStepParams('selectSettings', 'dataScope', params);
    const getModel = vi.spyOn(engine, 'getModel');
    const quickEditField = createFieldModel(engine, 'quick-edit-target');
    const dispatchEvent = vi.spyOn(quickEditField, 'dispatchEvent').mockResolvedValue(undefined);
    const step = QuickEditFormModel.globalFlowRegistry.getFlow('fieldSelectionFilterSettings')?.steps
      ?.dataScope as TestStep;

    await step.handler?.({
      engine,
      inputArgs: {
        sourceFieldModelUid: sourceField.uid,
      },
      model: {
        subModels: {
          fields: [quickEditField],
        },
      },
    });

    expect(quickEditField.getStepParams('selectSettings', 'dataScope')).toEqual(params);
    expect(getModel).toHaveBeenCalledWith(sourceField.uid, true);
    expect(dispatchEvent).toHaveBeenCalledWith('beforeRender', undefined, { useCache: false });
  });

  it('loads the same flow registrations from the client-v2 entry', () => {
    expect(PluginFieldSelectionFilterClientV2).toBe(PluginFieldSelectionFilterClient);
    expect(QuickEditFormModel.globalFlowRegistry.getFlow('fieldSelectionFilterSettings')).toBeDefined();
    expect(TableSelectModel.globalFlowRegistry.getFlow('fieldSelectionFilterSettings')).toBeDefined();
  });

  it('applies the source field filter to the popup record-picker table', async () => {
    const engine = new FlowEngine();
    const sourceField = createFieldModel(engine, 'record-picker-source');
    sourceField.setStepParams('selectSettings', 'dataScope', params);
    const getModel = vi.fn().mockReturnValue(sourceField);
    const runAction = vi.fn().mockResolvedValue(undefined);
    const step = TableSelectModel.globalFlowRegistry.getFlow('fieldSelectionFilterSettings')?.steps
      ?.dataScope as TestStep;

    await step.handler?.({
      engine: {
        getModel,
      },
      runAction,
      view: {
        inputArgs: {
          parentId: sourceField.uid,
        },
      },
    });

    expect(getModel).toHaveBeenCalledWith(sourceField.uid, true);
    expect(runAction).toHaveBeenCalledWith('dataScope', params);
  });
});

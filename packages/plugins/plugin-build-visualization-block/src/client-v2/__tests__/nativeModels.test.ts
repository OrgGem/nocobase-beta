/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import * as client from '@nocobase/client-v2';
import { FlowEngine, FlowModel, type CreateModelOptions } from '@nocobase/flow-engine';
import type { BlockSpec } from '../../shared/blockSpec';
import { BuildVisualizationBlockModel } from '../models/BuildVisualizationBlockModel';
import { buildNativeOptions } from '../nativeBlock';

function createEngine() {
  const engine = new FlowEngine();
  const models: Record<string, typeof FlowModel> = {};
  for (const [name, value] of Object.entries(client)) {
    if (typeof value === 'function' && value.prototype instanceof FlowModel) models[name] = value as typeof FlowModel;
  }
  engine.registerModels({ ...models, BuildVisualizationBlockModel });
  engine.context.defineProperty('app', { value: { pm: { get: () => undefined } } });
  engine.context.defineProperty('api', { value: new client.APIClient({ baseURL: 'http://example.test/api/' }) });
  engine.context.dataSourceManager.getDataSource('main').addCollection({
    name: 'orders',
    filterTargetKey: 'id',
    fields: [
      { name: 'id', type: 'integer', interface: 'integer' },
      { name: 'name', type: 'string', interface: 'input' },
    ],
  });
  return engine;
}

const spec: BlockSpec = {
  version: 1,
  title: 'Orders',
  dataSource: 'main',
  primaryCollection: 'orders',
  blockType: 'table',
  table: { fields: ['name'] },
};

describe('V2 native model tree integration', () => {
  it('instantiates real table/field models and restores their datasource/field bindings after serialization', async () => {
    const engine = createEngine();
    const host = engine.createModel<BuildVisualizationBlockModel>({ use: 'BuildVisualizationBlockModel' });
    const grid = await engine.createModelAsync<client.BlockGridModel>(buildNativeOptions(host.context, spec));
    const table = grid.subModels.items[0] as client.TableBlockModel;
    expect(table).toBeInstanceOf(client.TableBlockModel);
    expect(table.collection.name).toBe('orders');
    expect(table.resource.getDataSourceKey()).toBe('main');
    expect(table.subModels.columns[0].collectionField.name).toBe('name');
    const restoredEngine = createEngine();
    const restored = await restoredEngine.createModelAsync<client.BlockGridModel>(
      grid.serialize() as CreateModelOptions,
    );
    const restoredTable = restored.subModels.items[0] as client.TableBlockModel;
    expect(restoredTable.subModels.columns[0].collectionField.name).toBe('name');
    expect(restoredTable.subModels.columns[0].subModels.field).toBeInstanceOf(client.DisplayTextFieldModel);
  });

  it('creates real editable form fields and restores the existing tree when persistence fails', async () => {
    const engine = createEngine();
    const host = engine.createModel<BuildVisualizationBlockModel>({ use: 'BuildVisualizationBlockModel' });
    const formSpec: BlockSpec = { ...spec, blockType: 'form', form: { mode: 'create', fields: ['name'] } };
    host.pendingOptions = buildNativeOptions(host.context, formSpec);
    const save = vi.spyOn(host, 'save').mockResolvedValue(undefined);
    const selection = { buildId: '9007199254740993', spec: formSpec };
    await host.installGenerated(selection);
    const previous = host.subModels.content;
    const form = (previous as client.BlockGridModel).subModels.items[0] as client.CreateFormModel;
    expect(form).toBeInstanceOf(client.CreateFormModel);
    expect(form.subModels.grid.subModels.items[0].subModels.field).toBeInstanceOf(client.InputFieldModel);
    expect(form.subModels.actions[0]).toBeInstanceOf(client.FormSubmitActionModel);
    host.pendingOptions = buildNativeOptions(host.context, spec);
    save.mockRejectedValue(new Error('save failed'));
    await expect(host.installGenerated({ buildId: 'new', spec })).rejects.toThrow('save failed');
    expect(host.subModels.content).toBe(previous);
    expect(host.props.generationFingerprint).toBe(JSON.stringify(selection));
  });
});

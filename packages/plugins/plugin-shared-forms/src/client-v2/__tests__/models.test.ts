/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import * as client from '@nocobase/client-v2';
import { FlowEngine, FlowModel, type CreateModelOptions } from '@nocobase/flow-engine';
import MockAdapter from 'axios-mock-adapter';
import { describe, expect, it, vi } from 'vitest';
import { createFormEngine, loadFormModel } from '../formEngine';
import { formModelOptions, SharedFormModel, SharedSubmitResource, SharedFormSubmitActionModel } from '../models';

function parentEngine() {
  const parent = new FlowEngine();
  const models: Record<string, typeof FlowModel> = {};
  for (const [name, value] of Object.entries(client))
    if (typeof value === 'function' && value.prototype instanceof FlowModel) models[name] = value as typeof FlowModel;
  parent.registerModels(models);
  const api = new client.APIClient({ baseURL: 'http://example.test/api/', storageType: 'memory' });
  parent.context.defineProperty('api', { value: api });
  parent.context.defineProperty('app', { value: { apiClient: api, pm: { get: () => undefined } } });
  vi.spyOn(parent.flowSettings, 'load').mockResolvedValue(undefined);
  return { parent, api };
}
describe('Shared Forms with native V2 models/resources', () => {
  it('uses independent model storage and a real create form/field tree that survives serialization', async () => {
    const { parent } = parentEngine();
    const original = parent.modelRepository;
    const engine = await createFormEngine(parent, true, 'form-key', vi.fn());
    expect(parent.modelRepository).toBe(original);
    expect(parent.context.flowSettingsEnabled).not.toBe(true);
    engine.context.dataSourceManager
      .getDataSource('main')
      .addCollection({ name: 'orders', fields: [{ name: 'title', type: 'string', interface: 'input' }] });
    const options = formModelOptions('main', 'orders') as CreateModelOptions;
    options.subModels.grid = {
      use: 'FormGridModel',
      subModels: {
        items: [
          {
            use: 'FormItemModel',
            stepParams: {
              fieldSettings: { init: { dataSourceKey: 'main', collectionName: 'orders', fieldPath: 'title' } },
            },
            subModels: { field: { use: 'InputFieldModel' } },
          },
        ],
      },
    };
    const model = await loadFormModel(engine, { version: 2, model: options as never, successMessage: 'Done' });
    expect(model).toBeInstanceOf(SharedFormModel);
    expect(model.subModels.actions[0]).toBeInstanceOf(SharedFormSubmitActionModel);
    expect(model.resource).toBeInstanceOf(SharedSubmitResource);
    const item = model.subModels.grid.subModels.items[0] as client.FormItemModel;
    expect(item.collectionField.name).toBe('title');
    expect(item.subModels.field).toBeInstanceOf(client.InputFieldModel);
    const stored = await engine.modelRepository.save(model);
    expect(stored.use).toBe('SharedFormModel');
    expect(stored.subModels.grid.subModels.items[0].stepParams.fieldSettings.init.fieldPath).toBe('title');
    expect((await engine.modelRepository.findOne({ parentId: model.uid, subKey: 'grid' }))?.uid).toBe(
      model.subModels.grid.uid,
    );
    const restoredEngine = await createFormEngine(parent, true, 'form-key', vi.fn());
    restoredEngine.context.dataSourceManager
      .getDataSource('main')
      .addCollection({ name: 'orders', fields: [{ name: 'title', type: 'string', interface: 'input' }] });
    const restored = await loadFormModel(restoredEngine, {
      version: 2,
      model: stored as never,
      successMessage: 'Done',
    });
    expect((restored.subModels.grid.subModels.items[0] as client.FormItemModel).collectionField.name).toBe('title');
  });
  it('posts sharedSubmit with the scoped form key/source and does not change the root Axios headers', async () => {
    const { parent, api } = parentEngine();
    const mock = new MockAdapter(api.axios);
    mock.onPost('orders:sharedSubmit').reply(200, { data: { id: 1 } });
    mock.onGet('customers:list').reply(200, { data: [] });
    mock.onPost('attachments:create').reply(200, { data: { id: 2 } });
    const engine = await createFormEngine(parent, false, 'form-a', vi.fn());
    const resource = new SharedSubmitResource(engine.context);
    resource.isNewRecord = true;
    resource.setResourceName('orders');
    resource.setDataSourceKey('crm');
    const defaults = JSON.stringify(api.axios.defaults.headers);
    await resource.save({ title: 'Hello' });
    expect(mock.history.post[0].headers).toMatchObject({
      'X-Data-Source': 'crm',
      'X-Shared-Form-Key': 'form-a',
      'X-Shared-Form-Version': '2',
    });
    expect(JSON.parse(mock.history.post[0].data)).toEqual({ title: 'Hello' });
    await engine.context.api.resource('customers', undefined, { 'X-Data-Source': 'crm' }).list();
    expect(mock.history.get[0].headers).toMatchObject({
      'X-Shared-Form-Key': 'form-a',
      'X-Shared-Form-Version': '2',
      'X-Data-Source': 'crm',
    });
    await api.resource('customers').list();
    expect(mock.history.get[1].headers['X-Shared-Form-Key']).toBeUndefined();
    await engine.context.api.axios.post('attachments:create', new FormData());
    expect(mock.history.post[1].headers).toMatchObject({ 'X-Shared-Form-Key': 'form-a', 'X-Shared-Form-Version': '2' });
    expect(JSON.stringify(api.axios.defaults.headers)).toBe(defaults);
    mock.restore();
  });
  it('prevents the native designer from submitting preview data', async () => {
    const { parent, api } = parentEngine();
    const request = vi.spyOn(api, 'request');
    const engine = await createFormEngine(parent, true, 'form', vi.fn());
    const resource = new SharedSubmitResource(engine.context);
    resource.setResourceName('orders');
    await expect(resource.save({ title: 'Preview' })).rejects.toThrow('Preview cannot submit records');
    expect(request).not.toHaveBeenCalled();
  });
  it('does not mark an error or canceled submission successful when native flows exit early', async () => {
    const { parent, api } = parentEngine();
    const mock = new MockAdapter(api.axios);
    mock.onPost('orders:sharedSubmit').reply(400, { errors: [{ message: 'Rejected' }] });
    const engine = await createFormEngine(parent, false, 'form', vi.fn());
    const resource = new SharedSubmitResource(engine.context);
    resource.setResourceName('orders');
    await expect(resource.save({ title: 'Rejected' })).rejects.toThrow();
    const success = vi.fn();
    const model = engine.createModel<SharedFormSubmitActionModel>({ use: 'SharedFormSubmitActionModel' });
    const step = model.getFlow('sharedFormSubmission').steps.success;
    const handler = step.handler as unknown as (
      ctx: { publicFormRuntime: boolean; resource: SharedSubmitResource; setSharedFormSubmitted: typeof success },
      params: Record<string, never>,
    ) => void;
    handler({ publicFormRuntime: true, resource, setSharedFormSubmitted: success }, {});
    expect(success).not.toHaveBeenCalled();
    resource.setMeta({ sharedSubmitSucceeded: true });
    handler({ publicFormRuntime: true, resource, setSharedFormSubmitted: success }, {});
    expect(success).toHaveBeenCalledWith(true);
    mock.restore();
  });
});

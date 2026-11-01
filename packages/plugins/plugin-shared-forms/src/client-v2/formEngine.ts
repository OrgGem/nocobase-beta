/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { FlowEngine, FlowModel, type CreateModelOptions, type IFlowModelRepository } from '@nocobase/flow-engine';
import { APIClient } from '@nocobase/client-v2';
import { uid } from '@nocobase/utils/client';
import type { SharedFormConfig } from '../shared/v2Config';
import { SharedFormModel, SharedFormSubmitActionModel } from './models';

/** Designer saves stay in this in-memory tree until the administrator chooses Save V2 configuration. */
export class FormDraftRepository implements IFlowModelRepository {
  constructor(private engine: FlowEngine) {}
  async findOne(query: Record<string, unknown>) {
    if (query.uid) return this.engine.getModel(String(query.uid))?.serialize() || null;
    let result: Record<string, unknown> = null;
    if (query.parentId)
      this.engine.forEachModel((model) => {
        if (model.parentId === query.parentId && (!query.subKey || model.subKey === query.subKey))
          result = model.serialize();
      });
    return result;
  }
  async save(model: FlowModel) {
    return model.serialize();
  }
  async destroy() {
    return true;
  }
  async move() {}
  async duplicate(modelUid: string) {
    const model = this.engine.getModel(modelUid);
    if (!model) return null;
    const json = JSON.stringify(model.serialize());
    const ids = new Map<string, string>();
    const tree = JSON.parse(json);
    function collect(node: unknown) {
      if (!node || typeof node !== 'object') return;
      if ('uid' in node && typeof node.uid === 'string') ids.set(node.uid, uid());
      Object.values(node).forEach(collect);
    }
    collect(tree);
    return JSON.parse(json, (_, value: unknown) =>
      typeof value === 'string' && ids.has(value) ? ids.get(value) : value,
    );
  }
}

export async function createFormEngine(parent: FlowEngine, editable: boolean, key: string, onSubmitted: () => void) {
  const engine = new FlowEngine();
  engine.context.addDelegate(parent.context);
  const parentApi = parent.context.api;
  const api = new APIClient({
    baseURL: parentApi.axios.defaults.baseURL,
    storageType: 'memory',
    adapter: (config) => {
      config.headers.set('X-Shared-Form-Key', key);
      config.headers.set('X-Shared-Form-Version', '2');
      return parentApi.request({ ...config, adapter: undefined });
    },
  });
  api.auth = parentApi.auth;
  engine.context.defineProperty('api', { value: editable ? parentApi : api });
  engine.context.dataSourceManager.setCollectionFieldInterfaceManager(
    parent.context.dataSourceManager.collectionFieldInterfaceManager,
  );
  engine.registerActions(Object.fromEntries(parent.getActions()));
  engine.registerEvents(Object.fromEntries(parent.getEvents()));
  const models = [...(await parent.getModelClassesAsync())].filter(([name]) => name !== 'FlowModel');
  engine.registerModels({
    ...Object.fromEntries(models),
    SharedFormModel,
    SharedFormSubmitActionModel,
  });
  await parent.flowSettings.load();
  engine.flowSettings.registerComponents(parent.flowSettings.components);
  engine.flowSettings.registerScopes(
    Object.fromEntries(Object.entries(parent.flowSettings.scopes).filter(([name]) => name !== 't')),
  );
  parent.flowSettings.toolbarItems.forEach((item) => engine.flowSettings.addToolbarItem(item));
  engine.setModelRepository(new FormDraftRepository(engine));
  engine.context.defineProperty('sharedFormKey', { value: key });
  engine.context.defineProperty('publicFormRuntime', { value: !editable });
  engine.context.defineProperty('allowedFormActionModelNames', { value: ['SharedFormSubmitActionModel'] });
  engine.context.defineMethod('setSharedFormSubmitted', onSubmitted);
  engine.context.defineProperty('flowSettingsEnabled', { value: editable });
  engine.context.defineProperty('skipAclCheck', { value: true });
  engine.context.defineProperty('view', {
    value: {
      inputArgs: {},
      type: 'embed',
      Header: null,
      Footer: null,
      close: async () => undefined,
      update: () => undefined,
    },
  });
  engine.context.defineMethod('aclCheck', () => true);
  if (editable) await engine.flowSettings.forceEnable();
  return engine;
}

export async function loadFormModel(engine: FlowEngine, config: SharedFormConfig) {
  const model = await engine.createModelAsync<SharedFormModel>(config.model as CreateModelOptions);
  const init = config.model.stepParams.resourceSettings.init;
  engine.context.defineProperty('view', {
    value: {
      type: 'embed',
      Header: null,
      Footer: null,
      close: async () => undefined,
      update: () => undefined,
      inputArgs: { ...engine.context.view.inputArgs, collectionName: init.collectionName },
    },
  });
  return model;
}

/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockServer, type MockServer } from '@nocobase/test';
import PluginDocumentUnderstandingServer from '../plugin';

describe('Document Understanding actions', () => {
  let app: MockServer;
  let agent: ReturnType<MockServer['agent']>;
  let plugin: PluginDocumentUnderstandingServer;

  beforeEach(async () => {
    app = await createMockServer({
      plugins: [
        'field-sort',
        'system-settings',
        'users',
        'auth',
        'acl',
        'data-source-manager',
        'data-source-main',
        'error-handler',
      ],
      acl: false,
    });
    plugin = new PluginDocumentUnderstandingServer(app, { name: 'plugin-document-understanding' });
    await plugin.beforeLoad();
    await plugin.load();
    await app.db.sync();

    const adminUser = await app.db.getRepository('users').findOne();
    agent = app.agent();
    if (adminUser) {
      await agent.login(adminUser);
    }
  });

  afterEach(async () => {
    await plugin?.beforeStop();
    await app?.destroy();
  });

  it('creates, lists, updates, and deletes endpoints', async () => {
    const createRes = await agent.resource('docUnderstanding').createEndpoint({
      values: {
        name: 'ocr',
        subpath: '/ocr',
        method: 'POST',
        fileInputMode: 'multipart',
        executionMode: 'sync',
        customHeaders: { 'X-Test': '1' },
        enabled: true,
      },
    });
    expect(createRes.status).toBe(200);
    expect(createRes.body.data.name).toBe('ocr');

    const listRes = await agent.resource('docUnderstanding').listEndpoints();
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);

    const id = createRes.body.data.id;
    const updateRes = await agent.resource('docUnderstanding').updateEndpoint({
      filterByTk: id,
      values: { description: 'OCR endpoint' },
    });
    expect(updateRes.status).toBe(200);

    const deleteRes = await agent.resource('docUnderstanding').deleteEndpoint({ filterByTk: id });
    expect(deleteRes.status).toBe(200);
  });

  it('rejects invalid custom header names', async () => {
    const res = await agent.resource('docUnderstanding').createEndpoint({
      values: {
        name: 'bad-header',
        subpath: '/bad',
        method: 'POST',
        fileInputMode: 'none',
        executionMode: 'sync',
        customHeaders: { 'Bad Header': '1' },
        enabled: true,
      },
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects duplicate pipeline step output aliases', async () => {
    const endpointRes = await agent.resource('docUnderstanding').createEndpoint({
      values: {
        name: 'extract',
        subpath: '/extract',
        method: 'POST',
        fileInputMode: 'none',
        executionMode: 'sync',
        enabled: true,
      },
    });

    const endpointId = endpointRes.body.data.id;
    const res = await agent.resource('docUnderstanding').createPipeline({
      values: {
        name: 'duplicate-aliases',
        enabled: true,
        steps: [
          { stepOrder: 1, name: 'first', endpointId, outputAlias: 'same', onError: 'fail', retryCount: 0 },
          { stepOrder: 2, name: 'second', endpointId, outputAlias: 'same', onError: 'fail', retryCount: 0 },
        ],
      },
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

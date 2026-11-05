/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';
import { createMockServer, type MockServer } from '@nocobase/test';
import { DefaultToolsManager } from '@nocobase/ai';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import Plugin from '../plugin';
import { PageIndexRunnerService } from '../services/pageindex-runner';
import { LlmServiceMapper } from '../services/llm-service-mapper';
import { saveSettings } from '../services/settings';

let app: MockServer;
let reader: ReturnType<MockServer['agent']>;
let allowedId: number;
const manager = new DefaultToolsManager();
const search = vi.spyOn(PageIndexRunnerService.prototype, 'search').mockImplementation(async (_settings, ids) => ({
  results: ids.map((id) => ({ doc_id: id, snippet: `Result ${id}` })),
}));

beforeAll(async () => {
  app = await createMockServer({
    acl: true,
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
  });
  Object.assign(app, { aiManager: { toolsManager: manager } });
  const plugin = new Plugin(app, { name: 'plugin-file-search' });
  await plugin.beforeLoad();
  await plugin.load();
  app.db.collection({ name: 'searchRecords', fields: [{ type: 'string', name: 'title' }] });
  await app.db.sync();
  await app.db.getRepository('roles').create({ values: { name: 'file-tool-reader', title: 'Reader' } });
  const user = await app.db
    .getRepository('users')
    .create({ values: { username: 'file-tool-reader', roles: ['file-tool-reader'] } });
  reader = await app.agent().login(user, 'file-tool-reader');
  for (const name of ['allowed-document', 'private-document']) {
    const row = await app.db.getRepository('searchRecords').create({ values: { title: name } });
    if (name === 'allowed-document') allowedId = row.get('id');
    const doc = await app.db.getRepository('fileSearchDocuments').create({
      values: {
        fileCollection: 'attachments',
        fileId: String(row.get('id')),
        filename: name,
        pageIndexDocId: name,
        status: 'indexed',
      },
    });
    await app.db.getRepository('fileSearchReferences').create({
      values: {
        documentId: doc.get('id'),
        ownerCollection: 'searchRecords',
        ownerRecordId: String(row.get('id')),
      },
    });
  }
  app.resourceManager.define({
    name: 'fileToolTest',
    actions: {
      async invoke(ctx, next) {
        const originalAction = ctx.action;
        const tool = await manager.getTools('file_search');
        const result = await tool.invoke(ctx as Context, ctx.action.params.values, {
          toolCallId: 'test',
          writer: () => {},
        });
        expect(ctx.action).toBe(originalAction);
        ctx.body = result;
        await next();
      },
    },
  });
  app.acl.allow('fileToolTest', 'invoke', 'loggedIn');
}, 120000);
beforeEach(async () => {
  search.mockClear();
  await saveSettings(app.db, { enableAiTool: true });
  app.acl.define({ role: 'file-tool-reader', actions: { 'searchRecords:get': { filter: { id: allowedId } } } });
});
afterAll(async () => {
  await app?.destroy();
  vi.restoreAllMocks();
});

function invoke(values: Record<string, unknown> = { query: 'document' }) {
  return reader.resource('fileToolTest').invoke({ values });
}

it('registers a real core tool with a callable Zod schema', async () => {
  const tool = await manager.getTools('file_search');
  expect(tool).toMatchObject({ scope: 'CUSTOM', execution: 'backend', definition: { name: 'file_search' } });
  expect(tool.definition.schema.safeParse({ query: 'document' }).success).toBe(true);
});

it('invokes the actual search action and passes only records allowed by the caller row scope', async () => {
  const response = await invoke();
  expect(response.status).toBe(200);
  expect(response.body.data.status).toBe('success');
  expect(response.body.data.content).toContain('allowed-document');
  expect(response.body.data.content).not.toContain('private-document');
  expect(search.mock.calls[0][1]).toEqual(['allowed-document']);
});

it('does not query the runner when the caller has no document access', async () => {
  app.acl.define({ role: 'file-tool-reader', actions: {} });
  expect((await invoke()).body.data).toMatchObject({ status: 'success', content: '[]' });
  expect(search).not.toHaveBeenCalled();
});

it('honors enableAiTool without invoking search', async () => {
  await saveSettings(app.db, { enableAiTool: false });
  expect((await invoke()).body.data.status).toBe('error');
  expect(search).not.toHaveBeenCalled();
});

it('rejects invalid inputs before querying search', async () => {
  expect((await invoke({ query: '   ' })).body.data.status).toBe('error');
  expect((await invoke({ query: 'document', topK: 1000 })).body.data.status).toBe('error');
  expect(search).not.toHaveBeenCalled();
});

it('preserves Koa throw methods used by the actual search action', async () => {
  const mapper = vi
    .spyOn(LlmServiceMapper.prototype, 'resolveEnv')
    .mockResolvedValueOnce({ ok: false, message: 'Test configuration failure', env: {} });
  try {
    expect((await invoke()).status).toBe(400);
  } finally {
    mapper.mockRestore();
  }
});

it('rejects anonymous invocation', async () => {
  const response = await app
    .agent()
    .resource('fileToolTest')
    .invoke({ values: { query: 'document' } });
  expect(response.status).toBe(401);
  expect(search).not.toHaveBeenCalled();
});

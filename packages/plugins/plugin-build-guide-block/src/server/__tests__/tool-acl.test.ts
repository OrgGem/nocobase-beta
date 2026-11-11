/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

// SPDX-License-Identifier: Apache-2.0

import type { Context } from '@nocobase/actions';
import { createMockServer, type MockServer } from '@nocobase/test';
import { DefaultToolsManager } from '@nocobase/ai';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import Plugin from '../plugin';

vi.mock('../actions/build', () => ({
  build: vi.fn(),
  buildPageMarkdown: vi.fn(),
  buildPlan: vi.fn(),
  createBuildGuideInputDescriptor: vi.fn(),
  createGuideSearchMetadata: vi.fn(),
  getLLMProvider: vi.fn(),
  markdownToCleanHtml: vi.fn(),
  materializeBuildGuideInputSnapshot: vi.fn(),
  normalizePlan: vi.fn(),
  recoverInterruptedBuilds: vi.fn(),
  registerBuildGuideQueue: vi.fn(),
  slugify: vi.fn(),
  toPlainText: vi.fn(),
  unregisterBuildGuideQueue: vi.fn(),
}));
let app: MockServer;
let reader: ReturnType<MockServer['agent']>;
let allowedSpace: string;
let allowedPage: string;
let otherPage: string;
let hiddenSpacePage: string;
const manager = new DefaultToolsManager();

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
  await new Plugin(app, { name: 'plugin-build-guide-block' }).load();
  await app.db.getRepository('roles').create({ values: { name: 'guide-tool-reader', title: 'Reader' } });
  const user = await app.db
    .getRepository('users')
    .create({ values: { username: 'guide-tool-reader', roles: ['guide-tool-reader'] } });
  reader = await app.agent().login(user, 'guide-tool-reader');
  const spaces = app.db.getRepository('aiBuildGuideSpaces');
  const pages = app.db.getRepository('aiBuildGuidePages');
  allowedSpace = (await spaces.create({ values: { title: 'Public space', status: 'completed' } })).get('id');
  const hiddenSpace = (await spaces.create({ values: { title: 'PRIVATE_SPACE', status: 'completed' } })).get('id');
  allowedPage = (
    await pages.create({
      values: { title: 'Allowed', spaceId: allowedSpace, status: 'completed', generatedMarkdown: 'PUBLIC_CONTENT' },
    })
  ).get('id');
  otherPage = (
    await pages.create({
      values: {
        title: 'PRIVATE_PAGE',
        spaceId: allowedSpace,
        status: 'completed',
        generatedMarkdown: 'PRIVATE_CONTENT',
      },
    })
  ).get('id');
  hiddenSpacePage = (
    await pages.create({
      values: {
        title: 'PRIVATE_PARENT',
        spaceId: hiddenSpace,
        status: 'completed',
        generatedMarkdown: 'PRIVATE_PARENT_CONTENT',
      },
    })
  ).get('id');
  app.resourceManager.define({
    name: 'guideToolTest',
    actions: {
      async invoke(ctx, next) {
        const tool = await manager.getTools('plugin-build-guide-search_build_guides');
        ctx.body = await tool.invoke(ctx as Context, ctx.action.params.values, {
          toolCallId: 'test',
          writer: () => {},
        });
        await next();
      },
    },
  });
  app.acl.allow('guideToolTest', 'invoke', 'loggedIn');
}, 120000);

function grant(pageParams: Record<string, unknown> = {}, spaceParams: Record<string, unknown> = {}) {
  app.acl.define({
    role: 'guide-tool-reader',
    actions: {
      'aiBuildGuidePages:list': pageParams,
      'aiBuildGuidePages:get': pageParams,
      'aiBuildGuideSpaces:list': spaceParams,
      'aiBuildGuideSpaces:get': spaceParams,
    },
  });
}
beforeEach(() => {
  grant({ filter: { id: allowedPage } }, { filter: { id: allowedSpace } });
});
afterAll(async () => {
  await app?.destroy();
});
function invoke(action: string, extra: Record<string, unknown> = {}) {
  return reader.resource('guideToolTest').invoke({ values: { action, ...extra } });
}

it.each(['list_spaces', 'search_pages', 'read_page'])('denies %s without collection access', async (action) => {
  app.acl.define({ role: 'guide-tool-reader', actions: {} });
  expect((await reader.resource('aiBuildGuidePages').get({ filterByTk: otherPage })).status).toBe(403);
  const response = await invoke(action, { pageId: otherPage });
  expect(response.body.data.status).toBe('error');
  expect(response.text).not.toContain('PRIVATE');
});

it('applies page and parent space row scopes to list/search/read', async () => {
  expect((await invoke('list_spaces')).text).not.toContain('PRIVATE');
  const search = await invoke('search_pages');
  expect(search.body.data.content).toHaveLength(1);
  expect(search.text).toContain('PUBLIC_CONTENT');
  expect(search.text).not.toContain('PRIVATE');
  expect((await invoke('read_page', { pageId: otherPage })).body.data.status).toBe('error');
  grant({}, { filter: { id: allowedSpace } });
  expect((await invoke('search_pages')).text).not.toContain('PRIVATE_PARENT');
  expect((await invoke('read_page', { pageId: hiddenSpacePage })).body.data.status).toBe('error');
});

it('keeps the page row scope in keyword queries and fallback queries', async () => {
  const hidden = await invoke('search_pages', { query: 'PRIVATE_CONTENT' });
  expect(hidden.body.data).toMatchObject({ status: 'success', content: [] });
  const allowed = await invoke('search_pages', { query: 'PUBLIC_CONTENT' });
  expect(allowed.body.data.status).toBe('success');
  expect(allowed.text).toContain('PUBLIC_CONTENT');
  expect(allowed.text).not.toContain('PRIVATE_CONTENT');
});

it.each([{ fields: ['id', 'title', 'spaceId'] }, { except: ['generatedMarkdown'] }])(
  'honors page field restrictions %j',
  async (params) => {
    grant(params);
    for (const action of ['search_pages', 'read_page']) {
      const response = await invoke(action, { pageId: allowedPage, query: 'PUBLIC_CONTENT' });
      expect(response.body.data.status).toBe('error');
      expect(response.text).not.toContain('PUBLIC_CONTENT');
    }
  },
);

it('does not bypass parent field restrictions via an association append', async () => {
  grant({}, { fields: ['id'] });
  for (const action of ['list_spaces', 'search_pages', 'read_page']) {
    expect((await invoke(action, { pageId: allowedPage })).body.data.status).toBe('error');
  }
});

it('reads a completed page in a permitted completed space', async () => {
  const response = await invoke('read_page', { pageId: allowedPage });
  expect(response.body.data).toMatchObject({
    status: 'success',
    content: { markdown: 'PUBLIC_CONTENT', spaceName: 'Public space' },
  });
  await app.db.getRepository('aiBuildGuideSpaces').update({ filterByTk: allowedSpace, values: { status: 'pending' } });
  try {
    expect((await invoke('read_page', { pageId: allowedPage })).body.data.status).toBe('error');
  } finally {
    await app.db
      .getRepository('aiBuildGuideSpaces')
      .update({ filterByTk: allowedSpace, values: { status: 'completed' } });
  }
});

it('denies anonymous invocation through the resource', async () => {
  const response = await app
    .agent()
    .resource('guideToolTest')
    .invoke({ values: { action: 'search_pages' } });
  expect(response.status).toBe(401);
  expect(response.text).not.toContain('CONTENT');
});

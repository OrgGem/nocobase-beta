/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockServer, type MockServer } from '@nocobase/test';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import Plugin from '../plugin';

vi.mock('../actions/build', () => ({
  build: vi.fn(),
  recoverInterruptedBuilds: vi.fn(),
  registerBuildGuideQueue: vi.fn(),
  unregisterBuildGuideQueue: vi.fn(),
}));
let app: MockServer;
let reader: ReturnType<MockServer['agent']>;
let ownId: number;
let otherId: number;

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
  await new Plugin(app, { name: 'plugin-build-guide-block' }).load();
  await app.db.getRepository('roles').create({ values: { name: 'guide-reader', title: 'Reader' } });
  const user = await app.db
    .getRepository('users')
    .create({ values: { username: 'guide-reader', roles: ['guide-reader'] } });
  reader = await app.agent().login(user, 'guide-reader');
  const repo = app.db.getRepository('aiBuildGuideSpaces');
  ownId = (
    await repo.create({
      values: {
        title: 'Allowed',
        status: 'completed',
        generatedHtml: '<p>allowed</p>',
        generatedMarkdown: '# allowed',
      },
    })
  ).get('id');
  otherId = (
    await repo.create({
      values: {
        title: 'Private',
        status: 'completed',
        generatedHtml: '<p>private</p>',
        generatedMarkdown: '# private',
      },
    })
  ).get('id');
}, 120000);
afterAll(async () => {
  await app?.destroy();
});

it.each(['getHtml', 'getMarkdown'])('requires normal get permission for %s', async (action) => {
  app.acl.define({ role: 'guide-reader', actions: {} });
  const response = await reader.resource('aiBuildGuideSpaces')[action]({ filterByTk: otherId });
  expect(response.status).toBe(403);
  expect(response.text).not.toContain('private');
});

it.each(['getHtml', 'getMarkdown'])('applies row scope and returns unwrapped content for %s', async (action) => {
  app.acl.define({ role: 'guide-reader', actions: { 'aiBuildGuideSpaces:get': { filter: { id: ownId } } } });
  const allowed = await reader.resource('aiBuildGuideSpaces')[action]({ filterByTk: ownId });
  expect(allowed.status).toBe(200);
  expect(allowed.text).toBe(action === 'getHtml' ? '<p>allowed</p>' : '# allowed');
  const denied = await reader.resource('aiBuildGuideSpaces')[action]({ filterByTk: otherId });
  expect(denied.status).toBe(404);
  expect(denied.text).not.toContain('private');
});

it.each(['getHtml', 'getMarkdown'])('honors field restrictions for %s', async (action) => {
  app.acl.define({ role: 'guide-reader', actions: { 'aiBuildGuideSpaces:get': { fields: ['id', 'title'] } } });
  const denied = await reader.resource('aiBuildGuideSpaces')[action]({ filterByTk: ownId });
  expect(denied.status).toBe(403);
});

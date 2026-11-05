/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockServer, type MockServer } from '@nocobase/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import Plugin from '../plugin';

let app: MockServer;
let reader: ReturnType<MockServer['agent']>;
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
      [Plugin, { name: 'plugin-database-plus-manager' }],
    ],
  });
  const collection = app.db.collection({
    name: 'cursorDocuments',
    fields: [
      { name: 'ownerId', type: 'integer' },
      { name: 'title', type: 'string' },
    ],
  });
  await collection.sync();
  await app.db.getRepository('roles').create({ values: { name: 'cursor-reader', title: 'Reader' } });
  const user = await app.db
    .getRepository('users')
    .create({ values: { username: 'cursor-reader', roles: ['cursor-reader'] } });
  await collection.repository.create({ values: { ownerId: user.id, title: 'mine' } });
  await collection.repository.create({ values: { ownerId: 999, title: 'other' } });
  reader = await app.agent().login(user, 'cursor-reader');
  app.acl
    .define({
      role: 'cursor-reader',
      actions: { 'cursorDocuments:list': { fields: ['id', 'title'], filter: { ownerId: user.id } } },
    })
    .snippets.add('pm.plugin-database-plus-manager');
}, 120000);
afterAll(async () => {
  await app?.destroy();
});

it('cannot substitute a collection after list ACL', async () => {
  const response = await reader
    .resource('cursorDocuments')
    .list({ paginationMode: 'cursor', collection: 'users', sort: ['id'] });
  expect(response.status).toBe(200);
  expect(response.body.data).toHaveLength(1);
  expect(response.body.data[0]).toMatchObject({ id: expect.any(Number), title: 'mine' });
  expect(response.body.data[0]).not.toHaveProperty('ownerId');
});

it('requires read permission even with access to the standalone cursor endpoint', async () => {
  const response = await reader
    .resource('databasePlusManager')
    .cursor({ paginationMode: 'cursor', collection: 'users', sort: ['id'] });
  expect(response.status).toBe(403);
  const allowed = await reader
    .resource('databasePlusManager')
    .cursor({ paginationMode: 'cursor', collection: 'cursorDocuments', sort: ['id'] });
  expect(allowed.status).toBe(200);
  expect(allowed.body.data).toHaveLength(1);
  expect(allowed.body.data[0]).toMatchObject({ id: expect.any(Number), title: 'mine' });
  expect(allowed.body.data[0]).not.toHaveProperty('ownerId');
});

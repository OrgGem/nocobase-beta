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
      [Plugin, { name: 'plugin-package-registry' }],
    ],
  });
  for (const name of ['public', 'private']) {
    const registry = await app.db
      .getRepository('packageRegistries')
      .create({ values: { name, authRequired: name === 'private' } });
    await app.db.getRepository('packages').create({ values: { name: 'example', registryId: registry.id } });
  }
  const user = await app.db.getRepository('users').create({ values: { username: 'npm-reader' } });
  reader = await app.agent().login(user);
}, 120000);
afterAll(async () => {
  await app?.destroy();
});

it('authenticates private npm metadata with the normal NocoBase bearer token', async () => {
  const anonymous = await app.agent().get('/api/package-registry/npm/private/example');
  expect(anonymous.status).toBe(401);
  const authenticated = await reader.get('/api/package-registry/npm/private/example');
  expect(authenticated.status).toBe(200);
  expect(authenticated.body.name).toBe('example');
});

it('keeps public metadata anonymous and protects tarballs before lookup', async () => {
  const response = await app.agent().get('/api/package-registry/npm/public/example');
  expect(response.status).toBe(200);
  const tarball = await app.agent().get('/api/package-registry/npm/private/example/-/example-1.0.0.tgz');
  expect(tarball.status).toBe(401);
  const invalidToken = await app
    .agent()
    .get('/api/package-registry/npm/private/example')
    .set('Authorization', 'Bearer invalid');
  expect(invalidToken.status).toBe(401);
});

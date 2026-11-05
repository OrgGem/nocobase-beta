/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockServer, type MockServer } from '@nocobase/test';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import Plugin from '../plugin';

let app: MockServer;
let reader: ReturnType<MockServer['agent']>;
let admin: ReturnType<MockServer['agent']>;
let upstream: Server;
let nodes: string;
const requests: string[] = [];

beforeAll(async () => {
  upstream = createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('x-elastic-product', 'Elasticsearch');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.includes('_cat/indices') ? [{ index: 'fixture-index' }] : {}));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  nodes = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
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
      [Plugin, { name: 'plugin-data-source-elasticsearch' }],
    ],
  });
  for (const name of ['connection-reader', 'connection-admin']) {
    await app.db.getRepository('roles').create({
      values: {
        name,
        title: name,
        snippets: name === 'connection-admin' ? ['pm.data-source-manager.elasticsearch'] : [],
      },
    });
    const user = await app.db.getRepository('users').create({ values: { username: name, roles: [name] } });
    const agent = await app.agent().login(user, name);
    if (name === 'connection-reader') reader = agent;
    else admin = agent;
  }
  app.acl.getRole('connection-admin').snippets.add('pm.data-source-manager.elasticsearch');
}, 120000);

afterAll(async () => {
  await app?.destroy();
  if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

it.each(['readIndices', 'testConnection'])('denies %s before any outbound request', async (action) => {
  const count = requests.length;
  const response = await reader.resource('external-elasticsearch')[action]({ values: { nodes } });
  expect(response.status).toBe(403);
  expect(requests).toHaveLength(count);
});

it('allows the datasource administrator to inspect an explicitly configured private server', async () => {
  const response = await admin.resource('external-elasticsearch').readIndices({ values: { nodes } });
  expect(response.status).toBe(200);
  expect(response.body.data).toEqual([{ name: 'fixture-index' }]);
  expect(requests.some((url) => url.includes('_cat/indices'))).toBe(true);
});

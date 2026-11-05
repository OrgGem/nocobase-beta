/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { UiSchemaRepository } from '@nocobase/plugin-ui-schema-storage';
import { createMockServer, type MockServer } from '@nocobase/test';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import Plugin from '../plugin';
import forms from '../collections/sharedForms';
import formRoles from '../collections/sharedFormsRoles';

let app: MockServer;
let reader: ReturnType<MockServer['agent']>;
let customerId: number;

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
      'ui-schema-storage',
    ],
  });
  app.db.collection(forms);
  app.db.collection(formRoles);
  app.db.collection({ name: 'formCustomers', fields: [{ type: 'string', name: 'name' }] });
  app.db.collection({
    name: 'formOrders',
    fields: [
      { type: 'string', name: 'title' },
      { type: 'boolean', name: 'approved' },
      { type: 'belongsTo', name: 'customer', target: 'formCustomers', foreignKey: 'customerId' },
    ],
  });
  await app.db.sync();
  await new Plugin(app, { name: 'plugin-shared-forms' }).load();
  await app.db.getRepository('roles').create({ values: { name: 'form-reader', title: 'Reader' } });
  const user = await app.db
    .getRepository('users')
    .create({ values: { username: 'form-reader', roles: ['form-reader'] } });
  reader = await app.agent().login(user, 'form-reader');
  customerId = (await app.db.getRepository('formCustomers').create({ values: { name: 'Unchanged' } })).get('id');
  for (const key of ['allowed-form', 'other-form']) {
    await app.db
      .getRepository('sharedForms')
      .create({ values: { key, title: key, collection: 'formOrders', enabled: true } });
    await app.db.getRepository<UiSchemaRepository>('uiSchemas').insert({
      type: 'object',
      'x-uid': key,
      properties: {
        form: {
          type: 'void',
          properties: {
            layout: {
              type: 'void',
              properties: { title: { type: 'string', 'x-collection-field': 'formOrders.title' } },
            },
            customer: { type: 'object', 'x-collection-field': 'formOrders.customer' },
          },
        },
      },
    });
  }
}, 120000);
beforeEach(() => {
  app.acl.define({ role: 'form-reader', actions: { 'sharedForms:view': { filter: { key: 'allowed-form' } } } });
});
afterAll(async () => {
  await app?.destroy();
});

function submit(values: Record<string, unknown>, key = 'allowed-form') {
  return reader.post('/formOrders:sharedSubmit').set('X-Shared-Form-Key', key).send(values);
}

it('requires form view permission even when the allowed role list is empty', async () => {
  app.acl.define({ role: 'form-reader', actions: {} });
  expect((await submit({ title: 'Denied' })).status).toBe(403);
});

it('honors row scope for both legacy submission and metadata', async () => {
  expect((await submit({ title: 'Denied row' }, 'other-form')).status).toBe(403);
  const metadata = await reader.resource('sharedForms').getMeta({ filterByTk: 'other-form' });
  expect(metadata.status).toBe(403);
  expect(metadata.text).not.toContain('other-form');
});

it('rejects hidden fields and caller-supplied whitelist overrides', async () => {
  const response = await reader
    .post('/formOrders:sharedSubmit?whitelist[]=title&whitelist[]=approved')
    .set('X-Shared-Form-Key', 'allowed-form')
    .send({ title: 'Injection', approved: true });
  expect(response.status).toBe(400);
  expect(await app.db.getRepository('formOrders').count({ filter: { title: 'Injection' } })).toBe(0);
});

it('allows configured fields without granting general collection create', async () => {
  expect((await reader.resource('formOrders').create({ values: { title: 'General create' } })).status).toBe(403);
  expect((await submit({ title: 'Valid submission' })).status).toBe(200);
  const row = await app.db.getRepository('formOrders').findOne({ filter: { title: 'Valid submission' } });
  expect(row).toBeTruthy();
  expect(row.get('approved')).not.toBe(true);
});

it('links an existing association without accepting nested writes', async () => {
  const response = await reader
    .post('/formOrders:sharedSubmit?updateAssociationValues[]=customer')
    .set('X-Shared-Form-Key', 'allowed-form')
    .send({ title: 'Linked', customer: { id: customerId, name: 'Injected' } });
  expect(response.status).toBe(200);
  const row = await app.db.getRepository('formOrders').findOne({ filter: { title: 'Linked' } });
  expect(row.get('customerId')).toBe(customerId);
  expect((await app.db.getRepository('formCustomers').findById(customerId)).get('name')).toBe('Unchanged');
  expect((await submit({ title: 'Nested create', customer: { name: 'Unauthorized' } })).status).toBe(400);
  expect(await app.db.getRepository('formCustomers').count({ filter: { name: 'Unauthorized' } })).toBe(0);
});

it('retains form role restrictions and rejects anonymous submissions', async () => {
  const repo = app.db.getRepository('sharedFormsRoles');
  const restriction = await repo.create({ values: { sharedFormKey: 'allowed-form', roleName: 'root' } });
  try {
    expect((await submit({ title: 'Wrong role' })).status).toBe(403);
  } finally {
    await repo.destroy({ filterByTk: restriction.get('id') });
  }
  const anonymous = await app
    .agent()
    .post('/formOrders:sharedSubmit')
    .set('X-Shared-Form-Key', 'allowed-form')
    .send({ title: 'Anonymous' });
  expect(anonymous.status).toBe(401);
});

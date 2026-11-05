/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockServer, type MockServer } from '@nocobase/test';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import Plugin from '../plugin';

let app: MockServer;
let reader: ReturnType<MockServer['agent']>;
let plugin: Plugin;
const execute = vi.fn().mockResolvedValue({ jobId: 1 });

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
  plugin = new Plugin(app, { name: 'plugin-document-understanding' });
  await plugin.beforeLoad();
  await plugin.load();
  plugin.service.executePipeline = execute;
  await app.db.getRepository('roles').create({ values: { name: 'pipeline-runner', title: 'Runner' } });
  const user = await app.db
    .getRepository('users')
    .create({ values: { username: 'pipeline-runner', roles: ['pipeline-runner'] } });
  reader = await app.agent().login(user, 'pipeline-runner');
}, 120000);
beforeEach(() => {
  execute.mockClear();
  app.acl.define({ role: 'pipeline-runner', actions: { 'docUnderstanding:executePipeline': {} } });
});
afterAll(async () => {
  await app?.destroy();
});

it.each(['path', 'filepath'])('rejects JSON that supplies a local %s instead of an upload', async (key) => {
  const response = await reader
    .post('/docUnderstanding:executePipeline')
    .send({ pipelineId: 1, files: { document: { [key]: __filename } } });
  expect(response.status).toBe(400);
  expect(execute).not.toHaveBeenCalled();
});

it('preserves JSON pipeline execution without files', async () => {
  const response = await reader
    .post('/docUnderstanding:executePipeline')
    .send({ pipelineId: 1, input: { text: 'Document' } });
  expect(response.status).toBe(200);
  expect(execute).toHaveBeenCalledWith(1, { text: 'Document' }, [], expect.any(Number));
});

it('accepts bytes from the actual multipart parser and parses input JSON', async () => {
  const response = await reader
    .post('/docUnderstanding:executePipeline')
    .field('pipelineId', '2')
    .field('input', '{"language":"en"}')
    .attach('document', Buffer.from('UPLOADED_DOCUMENT_BYTES'), {
      filename: 'document.txt',
      contentType: 'text/plain',
    });
  expect(response.status).toBe(200);
  expect(execute).toHaveBeenCalledWith(
    2,
    { language: 'en' },
    [
      {
        fieldName: 'document',
        filename: 'document.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('UPLOADED_DOCUMENT_BYTES'),
      },
    ],
    expect.any(Number),
  );
});

it('rejects malformed multipart input without starting a pipeline', async () => {
  const response = await reader
    .post('/docUnderstanding:executePipeline')
    .field('pipelineId', '1')
    .field('input', '{invalid');
  expect(response.status).toBe(400);
  expect(execute).not.toHaveBeenCalled();
});

it('enforces upload count and size limits', async () => {
  const request = reader.post('/docUnderstanding:executePipeline').field('pipelineId', '1');
  for (let i = 0; i < 6; i++) request.attach('document', Buffer.from('x'), `document-${i}.txt`);
  expect((await request).status).toBe(413);
  const oversized = await reader
    .post('/docUnderstanding:executePipeline')
    .field('pipelineId', '1')
    .attach('document', Buffer.alloc(20 * 1024 * 1024 + 1), 'large.txt');
  expect(oversized.status).toBe(413);
  expect(execute).not.toHaveBeenCalled();
});

it('accepts exactly five files together with both supported text fields', async () => {
  const request = reader.post('/docUnderstanding:executePipeline').field('pipelineId', '1').field('input', '{}');
  for (let i = 0; i < 5; i++) request.attach('document', Buffer.from('x'), `document-${i}.txt`);
  expect((await request).status).toBe(200);
  expect(execute.mock.calls[0][2]).toHaveLength(5);
});

it('requires the resource grant before processing uploads', async () => {
  app.acl.define({ role: 'pipeline-runner', actions: {} });
  const response = await reader
    .post('/docUnderstanding:executePipeline')
    .field('pipelineId', '1')
    .attach('document', Buffer.from('PRIVATE'), 'private.txt');
  expect(response.status).toBe(403);
  expect(execute).not.toHaveBeenCalled();
});

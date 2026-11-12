// SPDX-License-Identifier: Apache-2.0

import { createMockServer, type MockServer } from '@nocobase/test';
import { afterAll, beforeAll, expect, it, vi, type MockInstance } from 'vitest';
import { PluginKnowledgeBaseServer } from '../plugin';

let app: MockServer;
let memberAgent: ReturnType<MockServer['agent']>;
let rootAgent: ReturnType<MockServer['agent']>;
let ownerId: number;
let otherUserId: number;
let publicKbId: string;
let sharedKbId: string;
let ownerKbId: string;
let privateKbId: string;
let publicDocId: string;
let sharedDocId: string;
let ownerDocId: string;
let privateDocId: string;
let privateFileId: string;
let ragKbId: string;
let queuePublish: MockInstance;

beforeAll(async () => {
  vi.stubEnv('KB_DEFAULT_VECTOR_DATABASE_PROVIDER', '');
  app = await createMockServer({
    acl: true,
    skipSupervisor: true,
    name: `knowledge-base-security-${process.pid}`,
    plugins: [
      'field-sort',
      'users',
      'auth',
      'acl',
      'data-source-manager',
      'data-source-main',
      'error-handler',
      'file-manager',
      'workflow',
      'ai',
      [PluginKnowledgeBaseServer, { name: 'plugin-knowledge-base', packageName: 'plugin-knowledge-base' }],
    ],
  });

  const users = app.db.getRepository('users');
  const rootUser = await users.findOne();
  if (!rootUser) throw new Error('The test application has no root user');
  rootAgent = await app.agent().loginUsingId(rootUser.get('id'));
  const owner = await users.create({
    values: { username: `kb-security-owner-${process.pid}`, roles: ['member'] },
  });
  const otherUser = await users.create({
    values: { username: `kb-security-other-${process.pid}`, roles: ['member'] },
  });
  ownerId = Number(owner.get('id'));
  otherUserId = Number(otherUser.get('id'));
  memberAgent = await app.agent().login(owner, 'member');

  const kbRepo = app.db.getRepository('aiKnowledgeBases');
  const publicKb = await kbRepo.create({
    values: { name: 'Public KB', type: 'LOCAL', accessLevel: 'PUBLIC', enabled: true },
  });
  const sharedKb = await kbRepo.create({
    values: { name: 'Role KB', type: 'LOCAL', accessLevel: 'SHARED', allowedRoles: ['member'], enabled: true },
  });
  const ownerKb = await kbRepo.create({
    values: { name: 'Owner KB', type: 'LOCAL', accessLevel: 'BASIC', ownerId, enabled: true },
  });
  const privateKb = await kbRepo.create({
    values: { name: 'Private KB', type: 'LOCAL', accessLevel: 'BASIC', ownerId: otherUserId, enabled: true },
  });
  publicKbId = String(publicKb.get('id'));
  sharedKbId = String(sharedKb.get('id'));
  ownerKbId = String(ownerKb.get('id'));
  privateKbId = String(privateKb.get('id'));

  const documents = app.db.getRepository('aiKnowledgeBaseDocuments');
  publicDocId = String(
    (
      await documents.create({
        values: { knowledgeBaseId: publicKbId, filename: 'public.txt', status: 'success', textContent: 'public' },
      })
    ).get('id'),
  );
  sharedDocId = String(
    (
      await documents.create({
        values: { knowledgeBaseId: sharedKbId, filename: 'shared.txt', status: 'failed', textContent: 'shared' },
      })
    ).get('id'),
  );
  ownerDocId = String(
    (
      await documents.create({
        values: { knowledgeBaseId: ownerKbId, filename: 'owner.txt', status: 'pending', textContent: 'owner' },
      })
    ).get('id'),
  );
  privateDocId = String(
    (
      await documents.create({
        values: { knowledgeBaseId: privateKbId, filename: 'private.txt', status: 'failed', textContent: 'private' },
      })
    ).get('id'),
  );

  const files = app.db.getRepository('aiFiles');
  privateFileId = String(
    (
      await files.create({
        values: {
          title: 'other user file',
          filename: 'other-user.txt',
          extname: '.txt',
          size: 1,
          mimetype: 'text/plain',
          path: '/test/other-user.txt',
          url: '/test/other-user.txt',
          createdById: otherUserId,
        },
      })
    ).get('id'),
  );

  const ragKb = await kbRepo.create({
    values: {
      name: 'Public External RAG',
      type: 'EXTERNAL_RAG',
      accessLevel: 'PUBLIC',
      enabled: true,
      options: {
        ragProvider: 'external-http',
        ragApiUrl: 'https://rag.example.test/search',
        ragApiKey: 'external-rag-secret',
      },
    },
  });
  ragKbId = String(ragKb.get('id'));

  const plugin = app.pm.get<PluginKnowledgeBaseServer>(PluginKnowledgeBaseServer);
  queuePublish = vi.spyOn(plugin.app.eventQueue, 'publish');
}, 120000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await app?.destroy();
});

it('enforces PUBLIC, role-shared, owner and private document visibility over the authenticated resource API', async () => {
  const listed = await memberAgent.resource('aiKnowledgeBaseDoc').list({
    filter: { $or: [{ status: 'success' }, { status: 'failed' }] },
  });
  expect(listed.status).toBe(200);
  expect(listed.body.data.map((document: { id: string }) => document.id).sort()).toEqual(
    [publicDocId, sharedDocId].sort(),
  );
  expect(listed.body.data.map((document: { id: string }) => document.id)).not.toContain(privateDocId);

  const stats = await memberAgent.resource('aiKnowledgeBaseDoc').stats({
    filter: { $or: [{ status: 'failed' }, { status: 'pending' }] },
  });
  expect(stats.status).toBe(200);
  expect(stats.body.data).toMatchObject({ total: 2, failed: 1, pending: 1, success: 0 });

  const ownAndPublic = await memberAgent.resource('aiKnowledgeBaseDoc').list({
    filter: { knowledgeBaseId: { $in: [publicKbId, ownerKbId, privateKbId] } },
  });
  expect(ownAndPublic.body.data.map((document: { id: string }) => document.id).sort()).toEqual(
    [publicDocId, ownerDocId].sort(),
  );
});

it('denies private version reads through HTTP', async () => {
  const response = await memberAgent.resource('aiKnowledgeBaseDoc').listVersions({ filterByTk: privateDocId });

  expect(response.status).toBe(403);
});

it('blocks generic collection and association routes to protected tables with 404', async () => {
  // This control request confirms the fixture exposes generic collection routes.
  const genericControl = await rootAgent.resource('aiFiles').list({ filter: { id: privateFileId } });
  expect(genericControl.status).toBe(200);

  const directDocuments = await rootAgent.resource('aiKnowledgeBaseDocuments').list();
  const directVersions = await rootAgent.resource('aiKnowledgeBaseDocumentVersions').list();
  const associatedDocuments = await rootAgent.resource('aiKnowledgeBases.documents', publicKbId).list();

  expect([directDocuments.status, directVersions.status, associatedDocuments.status]).toEqual([404, 404, 404]);
});

it('does not create or enqueue a document from another user’s aiFiles ID through either HTTP action', async () => {
  const documents = app.db.getRepository('aiKnowledgeBaseDocuments');
  const before = await documents.count({ filter: { knowledgeBaseId: ownerKbId } });

  const resourceCreate = await memberAgent.resource('aiKnowledgeBaseDoc').create({
    values: { knowledgeBaseId: ownerKbId, fileId: privateFileId, filename: 'spoofed.txt' },
  });
  const workflowAdd = await memberAgent.resource('aiKnowledgeBase').addDocument({
    values: { knowledgeBaseId: ownerKbId, fileId: privateFileId, filename: 'spoofed.txt' },
  });

  expect([resourceCreate.status, workflowAdd.status]).toEqual([404, 404]);
  expect(await documents.count({ filter: { knowledgeBaseId: ownerKbId } })).toBe(before);
  expect(queuePublish).not.toHaveBeenCalled();
});

it('masks External RAG credentials in authenticated KB reads', async () => {
  const response = await memberAgent.resource('aiKnowledgeBase').get({ filterByTk: ragKbId });

  expect(response.status).toBe(200);
  expect(response.body.data.options).toMatchObject({ hasRagApiKey: true });
  expect(response.body.data.options).not.toHaveProperty('ragApiKey');
  expect(JSON.stringify(response.body)).not.toContain('external-rag-secret');
});

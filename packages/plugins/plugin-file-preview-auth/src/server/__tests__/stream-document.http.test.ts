// SPDX-License-Identifier: Apache-2.0

import { createMockServer, type MockServer } from '@nocobase/test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseContentDispositionFilename } from '../../shared/documentPreview';
import Plugin from '../plugin';

describe('filePreviewAuth:streamDocument HTTP integration', () => {
  let app: MockServer;
  let storageRoot: string;
  let storageId: number;
  let owner: any;
  let otherUser: any;
  let readerUser: any;

  const aiFileBytes = Buffer.from('%PDF-1.4\nPrivate AI file content — Bảo mật\n%%EOF', 'utf-8');
  const attachmentBytes = Buffer.from('%PDF-1.4\nFile Manager attachment content\n%%EOF', 'utf-8');

  beforeAll(async () => {
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nb-stream-doc-test-'));
    app = await createMockServer({
      registerActions: true,
      acl: true,
      plugins: ['nocobase'],
    });
    await app.pm.enable('ai');
    await app.pm.add(Plugin, { name: 'plugin-file-preview-auth', enabled: true });
    const previewPlugin = app.pm.get('plugin-file-preview-auth') as Plugin;
    await previewPlugin.beforeLoad();
    await previewPlugin.load();
    await previewPlugin.install();

    const storageRepo = app.db.getRepository('storages');
    const storage = await storageRepo.create({
      values: {
        name: 'test-stream-doc-local',
        title: 'Test Stream Doc Local',
        type: 'local',
        baseUrl: '/storage/uploads/test-stream-doc',
        options: {
          documentRoot: storageRoot,
        },
      },
    });
    storageId = storage.get('id');

    const fileManager = app.pm.get('file-manager') as any;
    fileManager.storagesCache.set(
      storageId,
      typeof fileManager.parseStorage === 'function' ? fileManager.parseStorage(storage) : storage.toJSON(),
    );

    await fs.writeFile(path.join(storageRoot, 'ai-owned.pdf'), aiFileBytes);
    await fs.writeFile(path.join(storageRoot, 'fm-doc.pdf'), attachmentBytes);

    const usersRepo = app.db.getRepository('users');
    owner = await usersRepo.create({
      values: {
        nickname: 'Doc Owner',
        username: 'doc-owner',
        email: 'doc-owner@example.com',
      },
    });
    otherUser = await usersRepo.create({
      values: {
        nickname: 'Other Member',
        username: 'doc-other',
        email: 'doc-other@example.com',
      },
    });
    readerUser = await usersRepo.create({
      values: {
        nickname: 'ACL Reader',
        username: 'doc-reader',
        email: 'doc-reader@example.com',
      },
    });

    const rolesRepo = app.db.getRepository('roles');
    await rolesRepo.create({
      values: {
        name: 'doc_reader',
        title: 'Doc Reader',
        resources: [
          {
            name: 'attachments',
            usingActionsConfig: true,
            actions: [{ name: 'view' }],
          },
        ],
      },
    });
    await usersRepo.update({
      filterByTk: readerUser.id,
      values: {
        roles: ['doc_reader'],
      },
    });

    // Create records in aiFiles and attachments with colliding ID=501 and colliding filename='report.pdf'
    // (while pointing to distinct storage files on disk).
    await app.db.getRepository('aiFiles').create({
      values: {
        id: 501,
        title: 'Báo cáo tiếng Việt',
        filename: 'ai-owned.pdf',
        extname: '.pdf',
        mimetype: 'application/pdf',
        size: aiFileBytes.length,
        storageId,
        createdById: owner.id,
      },
      context: { state: { currentUser: owner } },
    });

    await app.db.getRepository('attachments').create({
      values: {
        id: 501,
        title: 'File Manager Doc',
        filename: 'fm-doc.pdf',
        extname: '.pdf',
        mimetype: 'application/pdf',
        size: attachmentBytes.length,
        storageId,
        createdById: owner.id,
      },
      context: { state: { currentUser: owner } },
    });
  });

  afterAll(async () => {
    await app?.db?.clean({ drop: true });
    await app?.destroy();
    if (storageRoot) {
      await fs.rm(storageRoot, { recursive: true, force: true });
    }
  });

  it('streams exact aiFiles bytes to owner, blocks other user with 403, and blocks unauthenticated with 401', async () => {
    const ownerAgent = await app.agent().login(owner.id);
    const ownerRes = await ownerAgent
      .get('/filePreviewAuth:streamDocument?collection=aiFiles&id=501')
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(ownerRes.statusCode).toBe(200);
    expect(ownerRes.headers['cache-control']).toBe('private, no-store');
    expect(ownerRes.headers['x-content-type-options']).toBe('nosniff');
    expect(ownerRes.headers['content-type']).toContain('application/pdf');
    expect(ownerRes.headers['content-disposition']).toContain('filename*=');
    expect(parseContentDispositionFilename(ownerRes.headers['content-disposition'])).toBe('Báo cáo tiếng Việt.pdf');
    expect(Buffer.from(ownerRes.body)).toEqual(aiFileBytes);

    const otherAgent = await app.agent().login(otherUser.id);
    const deniedRes = await otherAgent.get('/filePreviewAuth:streamDocument?collection=aiFiles&id=501');
    expect(deniedRes.statusCode).toBe(403);
    expect(JSON.stringify(deniedRes.body || '')).not.toContain('Private AI file content');

    const anonRes = await app.agent().get('/filePreviewAuth:streamDocument?collection=aiFiles&id=501');
    expect(anonRes.statusCode).toBe(401);
    expect(JSON.stringify(anonRes.body || '')).not.toContain('Private AI file content');
  });

  it('enforces strict collection isolation and ACL access for attachments vs aiFiles', async () => {
    const readerAgent = await app.agent().login(readerUser.id);
    readerAgent.set('X-Role', 'doc_reader');

    // Reader has attachments:view -> gets attachments#501 exact bytes
    const attRes = await readerAgent
      .get('/filePreviewAuth:streamDocument?collection=attachments&id=501')
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(attRes.statusCode).toBe(200);
    expect(Buffer.from(attRes.body)).toEqual(attachmentBytes);

    // Same ID 501 in aiFiles -> reader does NOT have aiFiles:view and is not owner -> 403!
    const aiDenied = await readerAgent.get('/filePreviewAuth:streamDocument?collection=aiFiles&id=501');
    expect(aiDenied.statusCode).toBe(403);

    // Non-existent ID -> 404
    const ownerAgent = await app.agent().login(owner.id);
    const missingRes = await ownerAgent.get('/filePreviewAuth:streamDocument?collection=aiFiles&id=999999');
    expect(missingRes.statusCode).toBe(404);
  });
});

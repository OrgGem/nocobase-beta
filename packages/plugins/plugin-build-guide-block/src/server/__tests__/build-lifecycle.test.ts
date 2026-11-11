/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockServer, type MockServer } from '@nocobase/test';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Plugin from '../plugin';
import {
  markBuildError,
  processQueuedBuildsFromDb,
  readDocumentsWithMetadata,
  recoverInterruptedBuilds,
  runBuild,
} from '../actions/build';

function attachment(id: string, filename: string, mimetype: string, extname: string) {
  return { id, filename, mimetype, extname };
}

function sourceApp(documentParser?: Record<string, unknown>) {
  const get = vi.fn((name: string) => {
    if (name === '@nocobase/plugin-document-parser' || name === 'plugin-document-parser') return documentParser;
    return undefined;
  });
  return { app: { pm: { get }, log: { warn: vi.fn() }, db: {} as unknown }, get };
}

function sourceSpace(documents: unknown[]) {
  return { getDocuments: async () => documents };
}

describe('Build Guide legacy recovery and source lifecycle', () => {
  let app: MockServer;
  let manager: ReturnType<MockServer['agent']>;

  beforeAll(async () => {
    vi.stubEnv('WORKER_MODE', '');
    app = await createMockServer({
      acl: true,
      skipSupervisor: true,
      plugins: [
        'field-sort',
        'users',
        'auth',
        'acl',
        'data-source-manager',
        'data-source-main',
        'error-handler',
        'file-manager',
      ],
    });
    vi.spyOn(app, 'serving').mockReturnValue(false);
    await new Plugin(app, { name: 'plugin-build-guide-block' }).load();
    await app.db.sequelize.sync();
    await app.db.getRepository('roles').create({ values: { name: 'guide-lifecycle-manager', title: 'Manager' } });
    const user = await app.db
      .getRepository('users')
      .create({ values: { username: 'guide-lifecycle-manager', roles: ['guide-lifecycle-manager'] } });
    manager = await app.agent().login(user, 'guide-lifecycle-manager');
    app.acl.define({
      role: 'guide-lifecycle-manager',
      actions: {
        'aiBuildGuideSpaces:get': {},
        'aiBuildGuideSpaces:build': {},
        'aiBuildGuideRuns:getStatus': {},
      },
    });
  }, 120_000);

  afterAll(async () => {
    await app?.destroy();
    vi.unstubAllEnvs();
  });

  it('skips orphaned queued rows without starving a later runnable legacy build', async () => {
    const runRepo = app.db.getRepository('aiBuildGuideRuns');
    const orphanRunId = randomUUID();
    await runRepo.create({
      values: {
        id: orphanRunId,
        spaceId: randomUUID(),
        engine: 'legacy',
        status: 'queued',
        stage: 'queued',
        createdAt: new Date(Date.now() - 60 * 60_000),
      },
    });

    const runId = randomUUID();
    const space = await app.db.getRepository('aiBuildGuideSpaces').create({
      values: {
        title: 'later queued fixture',
        status: 'building',
        buildPhase: 'queued',
        buildRunId: runId,
        activeRunId: runId,
        latestRunId: runId,
      },
    });
    await runRepo.create({
      values: { id: runId, spaceId: String(space.get('id')), engine: 'legacy', status: 'queued', stage: 'queued' },
    });

    await processQueuedBuildsFromDb(app, 1);
    expect((await runRepo.findById(runId))?.get('status')).toBe('failed');
    expect((await runRepo.findById(orphanRunId))?.get('status')).toBe('queued');
    await processQueuedBuildsFromDb(app, 1);
  });

  it('requeues only stale legacy owners, repairs old run pointers, and rolls back partial recovery', async () => {
    const spaceRepo = app.db.getRepository('aiBuildGuideSpaces');
    const runRepo = app.db.getRepository('aiBuildGuideRuns');
    const staleAt = new Date(Date.now() - 10 * 60_000);
    const runId = randomUUID();
    const space = await spaceRepo.create({
      values: {
        title: 'stale recovery fixture',
        status: 'building',
        buildPhase: 'running',
        buildRunId: runId,
        activeRunId: runId,
        latestRunId: runId,
        buildWorkerId: 'old-worker',
        buildHeartbeatAt: new Date(),
      },
    });
    await runRepo.create({
      values: { id: runId, spaceId: String(space.get('id')), engine: 'legacy', status: 'running', stage: 'writing' },
    });

    await recoverInterruptedBuilds(app);
    let currentSpace = await spaceRepo.findById(space.get('id'));
    let currentRun = await runRepo.findById(runId);
    expect(currentSpace?.get('buildPhase')).toBe('running');
    expect(currentRun?.get('status')).toBe('running');

    await currentSpace?.update({ buildHeartbeatAt: staleAt });
    await recoverInterruptedBuilds(app);
    currentSpace = await spaceRepo.findById(space.get('id'));
    currentRun = await runRepo.findById(runId);
    expect(currentSpace?.get('buildPhase')).toBe('queued');
    expect(currentSpace?.get('buildWorkerId')).toBeNull();
    expect(currentSpace?.get('activeRunId')).toBe(runId);
    expect(currentSpace?.get('latestRunId')).toBe(runId);
    expect(currentRun?.get('status')).toBe('queued');
    const queuedAt = currentSpace?.get('buildQueuedAt');
    await recoverInterruptedBuilds(app);
    expect((await spaceRepo.findById(space.get('id')))?.get('buildQueuedAt')).toEqual(queuedAt);

    const oldSpaceId = randomUUID();
    const oldRunId = randomUUID();
    const oldSpace = await spaceRepo.create({
      values: {
        id: oldSpaceId,
        title: 'pre-run migration fixture',
        status: 'building',
        buildPhase: 'running',
        buildRunId: oldRunId,
        buildWorkerId: 'old-worker',
        buildHeartbeatAt: staleAt,
      },
    });
    await recoverInterruptedBuilds(app);
    const migratedSpace = await spaceRepo.findById(oldSpace.get('id'));
    const migratedRun = await runRepo.findById(oldRunId);
    expect(migratedRun?.get('status')).toBe('queued');
    expect(migratedSpace?.get('activeRunId')).toBe(oldRunId);
    expect(migratedSpace?.get('latestRunId')).toBe(oldRunId);

    const rollbackRunId = randomUUID();
    const rollbackSpace = await spaceRepo.create({
      values: {
        title: 'recovery transaction fixture',
        status: 'building',
        buildPhase: 'running',
        buildRunId: rollbackRunId,
        activeRunId: rollbackRunId,
        buildWorkerId: 'old-worker',
        buildHeartbeatAt: staleAt,
      },
    });
    await runRepo.create({
      values: {
        id: rollbackRunId,
        spaceId: String(rollbackSpace.get('id')),
        engine: 'legacy',
        status: 'running',
        stage: 'writing',
      },
    });
    await app.db.getRepository('aiBuildGuidePages').create({
      values: { spaceId: String(rollbackSpace.get('id')), runId: rollbackRunId, status: 'pending' },
    });
    const pageModel = app.db.getCollection('aiBuildGuidePages').model;
    pageModel.addHook('beforeBulkUpdate', 'fail-build-guide-recovery-test', () => {
      throw new Error('recovery transaction fixture');
    });
    try {
      await expect(recoverInterruptedBuilds(app)).rejects.toThrow('recovery transaction fixture');
    } finally {
      pageModel.removeHook('beforeBulkUpdate', 'fail-build-guide-recovery-test');
    }
    expect((await runRepo.findById(rollbackRunId))?.get('status')).toBe('running');
    expect((await spaceRepo.findById(rollbackSpace.get('id')))?.get('buildPhase')).toBe('running');
  });

  it('keeps published legacy output visible through a failed rebuild and does not publish page-count-only data', async () => {
    const repo = app.db.getRepository('aiBuildGuideSpaces');
    const oldSpace = await repo.create({
      values: {
        title: 'Published before workflow release',
        llmService: 'unused-test-service',
        model: 'unused-test-model',
        status: 'completed',
        pageCount: 3,
        generatedHtml: '<p>previous guide</p>',
        generatedMarkdown: '# Previous guide',
      },
    });
    const accepted = await manager.resource('aiBuildGuideSpaces').build({ filterByTk: oldSpace.get('id') });
    expect(accepted.status).toBe(200);
    const oldRunId = String(accepted.body.data.runId);
    expect((await repo.findById(oldSpace.get('id')))?.get('published')).toBe(true);
    const visibleWhileBuilding = await manager
      .resource('aiBuildGuideSpaces')
      .getHtml({ filterByTk: oldSpace.get('id') });
    expect(visibleWhileBuilding.status).toBe(200);
    expect(visibleWhileBuilding.text).toBe('<p>previous guide</p>');

    await markBuildError(app, String(oldSpace.get('id')), oldRunId, new Error('provider failed'));
    const visibleAfterFailure = await manager
      .resource('aiBuildGuideSpaces')
      .getMarkdown({ filterByTk: oldSpace.get('id') });
    expect(visibleAfterFailure.status).toBe(200);
    expect(visibleAfterFailure.text).toBe('# Previous guide');

    const partialSpace = await repo.create({
      values: {
        title: 'Partial first build',
        llmService: 'unused-test-service',
        model: 'unused-test-model',
        status: 'error',
        pageCount: 2,
        published: false,
      },
    });
    const partialBuild = await manager.resource('aiBuildGuideSpaces').build({ filterByTk: partialSpace.get('id') });
    expect(partialBuild.status).toBe(200);
    expect((await repo.findById(partialSpace.get('id')))?.get('published')).toBe(false);
    await markBuildError(
      app,
      String(partialSpace.get('id')),
      String(partialBuild.body.data.runId),
      new Error('failed'),
    );
    expect((await repo.findById(partialSpace.get('id')))?.get('published')).toBe(false);
  });

  it('returns only warning codes and counts from a private source snapshot', async () => {
    const space = await app.db.getRepository('aiBuildGuideSpaces').create({
      values: { title: 'warning status fixture', status: 'error' },
    });
    const runId = randomUUID();
    await app.db.getRepository('aiBuildGuideRuns').create({
      values: {
        id: runId,
        spaceId: String(space.get('id')),
        engine: 'legacy',
        status: 'failed',
        stage: 'failed',
        errorCode: 'BUILD_FAILED',
      },
    });
    await app.db.getRepository('aiBuildGuideRunArtifacts').create({
      values: {
        runId,
        artifactKey: 'input',
        payload: {
          sourceWarnings: [
            { code: 'SOURCE_READ_FAILED', documentId: 'private-id-a', filename: 'private-a.txt' },
            { code: 'SOURCE_READ_FAILED', documentId: 'private-id-b', filename: 'private-b.txt' },
            { code: 'SOURCE_UNSUPPORTED', documentId: 'private-id-c', filename: 'private-c.pdf' },
            { code: 'PRIVATE_ERROR', documentId: 'private-id-d', filename: 'private-d.txt' },
          ],
        },
      },
    });

    const response = await manager.resource('aiBuildGuideRuns').getStatus({ filterByTk: runId });
    expect(response.status).toBe(200);
    expect(response.body.data.sourceWarnings).toEqual([
      { code: 'SOURCE_READ_FAILED', count: 2 },
      { code: 'SOURCE_UNSUPPORTED', count: 1 },
    ]);
    expect(JSON.stringify(response.body.data)).not.toContain('private-');
  });
});

describe('Build Guide source extraction', () => {
  it('uses only readable text and reports safe warning codes for partial source failures', async () => {
    const parser = {
      fetchFileBuffer: async (_ctx: unknown, file: { id: string }) => {
        if (file.id === 'unreadable') throw new Error('private read error');
        return { buffer: Buffer.from('readable source text') };
      },
    };
    const { app } = sourceApp(parser);
    const result = await readDocumentsWithMetadata(
      app,
      sourceSpace([
        attachment('readable', 'readable.txt', 'text/plain', '.txt'),
        attachment('unreadable', 'unreadable.txt', 'text/plain', '.txt'),
      ]),
    );
    expect(result.documentsText).toContain('readable source text');
    expect(result.documentsText).not.toContain('unreadable.txt');
    expect(result.sourceWarnings).toMatchObject([{ code: 'SOURCE_READ_FAILED', documentId: 'unreadable' }]);
  });

  it('fails before provider resolution when every attached source is unsupported', async () => {
    const runId = randomUUID();
    const descriptor = {
      title: 'Unsupported source fixture',
      llmService: 'should-not-resolve',
      model: 'should-not-resolve',
      systemPrompt: '',
      outputFormat: 'html',
      targetChapterCount: 1,
      chapterGuidance: '',
      documents: [
        {
          id: 'pdf-1',
          updatedAt: '2026-11-12T00:00:00.000Z',
          filename: 'manual.pdf',
          mimetype: 'application/pdf',
          extname: '.pdf',
        },
      ],
    };
    const attachmentRow = {
      id: 'pdf-1',
      updatedAt: new Date(descriptor.documents[0].updatedAt),
      filename: 'manual.pdf',
      mimetype: 'application/pdf',
      extname: '.pdf',
    };
    const spaceValues = { id: 'space-1', buildRunId: runId, status: 'building' };
    const space = { get: (field?: string) => (field ? spaceValues[field as keyof typeof spaceValues] : spaceValues) };
    const db = {
      getRepository(name: string) {
        if (name === 'aiBuildGuideSpaces') return { findById: async () => space };
        if (name === 'aiBuildGuideRunArtifacts')
          return { findOne: async () => ({ get: (field: string) => (field === 'payload' ? descriptor : undefined) }) };
        if (name === 'attachments')
          return {
            findOne: async () => ({ get: (field: string) => attachmentRow[field as keyof typeof attachmentRow] }),
          };
        throw new Error(`Unexpected repository ${name}`);
      },
    };
    const { app, get } = sourceApp();
    app.db = db;
    await expect(runBuild(app, db, { spaceId: 'space-1', runId, workerId: 'test-owner' })).rejects.toMatchObject({
      code: 'SOURCE_NO_USABLE_TEXT',
    });
    expect(get).not.toHaveBeenCalledWith('ai');
  });

  it.each(['[Attachment: guide.pdf — no parser available]', '<document_indexed query="look up document contents">'])(
    'does not treat parser instructions as extracted content: %s',
    async (parserOutput) => {
      const route = vi.fn(async () => ({ content: { type: 'text', text: parserOutput } }));
      const { app } = sourceApp({ parseRouter: { route } });
      await expect(
        readDocumentsWithMetadata(app, sourceSpace([attachment('pdf-2', 'guide.pdf', 'application/pdf', '.pdf')])),
      ).rejects.toMatchObject({ code: 'SOURCE_NO_USABLE_TEXT' });
      expect(route).toHaveBeenCalledTimes(1);
    },
  );

  it('uses the structured parser API and treats handled=false as unreadable', async () => {
    const parseAttachment = vi.fn(async (_ctx: unknown, _file: unknown, options: { useCase: string }) => {
      expect(options.useCase).toBe('api');
      return { handled: false, text: '', attempts: [] };
    });
    const { app } = sourceApp({ documentParseService: { parseAttachment } });
    await expect(
      readDocumentsWithMetadata(app, sourceSpace([attachment('pdf-3', 'guide.pdf', 'application/pdf', '.pdf')])),
    ).rejects.toMatchObject({ code: 'SOURCE_NO_USABLE_TEXT' });
    expect(parseAttachment).toHaveBeenCalledTimes(1);
  });
});

// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getApp } from '@nocobase/plugin-workflow-test';
import PluginGitManagerServer from '../../../../plugin-git-manager/src/server/plugin';
import PluginWorkflowGitReviewServer from '../plugin';

describe('Git Review ACL integration', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let testDbDirectory: string;
  let repoA: number;
  let repoB: number;
  let flowA: number;
  let flowB: number;

  beforeAll(async () => {
    testDbDirectory = mkdtempSync(join(tmpdir(), 'nocobase-git-review-acl-'));
    app = await getApp({
      acl: true,
      name: `git-review-acl-${Date.now()}`,
      database: { storage: join(testDbDirectory, 'main.sqlite') },
      plugins: [
        'error-handler',
        [PluginGitManagerServer, { name: 'git-manager' }],
        [PluginWorkflowGitReviewServer, { name: 'workflow-git-review' }],
      ],
      skipSupervisor: true,
    });

    const firstRepository = await app.db.getRepository('gitRepositories').create({
      values: { name: 'ACL repository A', repoUrl: 'https://example.test/a.git', localPath: 'a' },
    });
    const secondRepository = await app.db.getRepository('gitRepositories').create({
      values: { name: 'ACL repository B', repoUrl: 'https://example.test/b.git', localPath: 'b' },
    });
    repoA = Number(firstRepository.id);
    repoB = Number(secondRepository.id);

    const firstFlow = await app.db.getRepository('gitReviewFlows').create({
      values: { name: 'ACL flow A', repositoryId: repoA },
    });
    const secondFlow = await app.db.getRepository('gitReviewFlows').create({
      values: { name: 'ACL flow B', repositoryId: repoB },
    });
    flowA = Number(firstFlow.id);
    flowB = Number(secondFlow.id);
  }, 120_000);

  afterAll(async () => {
    await app?.destroy();
    if (testDbDirectory) rmSync(testDbDirectory, { recursive: true, force: true });
  });

  it('applies Git Manager read and write ACL scopes to Git Review flows and workflow controls', async () => {
    const readOnlyRoleName = 'custom-review-read-only';
    const readOnlyRoleScope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: {
        name: 'Repository A read scope',
        resourceName: 'gitManager',
        scope: { id: { $in: [repoA] } },
      },
    });
    await app.db.getRepository('roles').create({ values: { name: readOnlyRoleName, title: readOnlyRoleName } });
    await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        roleName: readOnlyRoleName,
        name: 'gitManager',
        usingActionsConfig: true,
        actions: [{ name: 'fileContent', scope: readOnlyRoleScope.id }],
      },
    });
    const aclPlugin = app.pm.get('acl') as {
      writeRolesToACL(options?: Record<string, unknown>): Promise<void>;
    };
    await aclPlugin.writeRolesToACL({});
    expect(app.acl.can({ role: readOnlyRoleName, resource: 'gitManager', action: 'fileContent' })).toMatchObject({
      params: { filter: { id: { $in: [repoA] } } },
    });
    expect(app.acl.can({ role: readOnlyRoleName, resource: 'workflowGitReview', action: 'status' })).toBeNull();
    const readOnlyUser = await app.db.getRepository('users').create({
      values: { nickname: readOnlyRoleName, roles: [{ name: readOnlyRoleName }] },
    });
    const reader = await app.agent().login(readOnlyUser, readOnlyRoleName);

    const visibleFlows = await reader.resource('gitReviewFlows').list();
    expect(visibleFlows.status).toBe(200);
    expect(visibleFlows.body.data.map((flow: { id: number }) => flow.id)).toEqual([flowA]);

    const resourcerPrefix = app.resourcer.options.prefix || '';
    const readOnlyStatus = await reader
      .get(`${resourcerPrefix}/workflowGitReview:status`)
      .set('X-Role', readOnlyRoleName);
    expect(readOnlyStatus.status).toBe(200);
    expect(readOnlyStatus.body.data.flows).toHaveLength(1);
    expect(readOnlyStatus.body.data.flows[0].canWrite).toBe(false);

    const readOnlyCutoverStatus = await reader.get(`${resourcerPrefix}/gitManager:reviewCutoverStatus`);
    expect(readOnlyCutoverStatus.status).toBe(200);
    expect(readOnlyCutoverStatus.body.data.data.canConfirmCutover).toBe(false);

    const deniedWrite = await reader.resource('gitReviewFlows').create({
      values: { name: 'Read only cannot create', repositoryId: repoA },
    });
    expect(deniedWrite.status).toBe(403);

    const deniedSetup = await reader.resource('workflowGitReview').setup({
      values: { flowId: flowA, template: 'quick' },
    });
    expect(deniedSetup.status).toBe(403);

    const deniedRepair = await reader.resource('workflowGitReview').repair({
      values: { flowId: flowA, template: 'quick' },
    });
    expect(deniedRepair.status).toBe(403);

    const inboxA = await app.db.getRepository('gitReviewInbox').create({
      values: {
        projectKey: 'acl-repository-a',
        repositoryId: repoA,
        reviewId: 1001,
        eventKey: 'acl-repository-a-1001',
        queuedAt: new Date(),
        state: 'queued',
        payload: {},
      },
    });
    const deniedRecovery = await reader.resource('gitManager').reviewRecover({
      values: { confirmation: 'AI_STOPPED', inboxId: inboxA.id },
    });
    expect(deniedRecovery.status).toBe(403);

    const writeRoleName = 'custom-review-scoped-writer';
    const writeRoleScope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: {
        name: 'Repository A write scope',
        resourceName: 'gitManager',
        scope: { id: { $in: [repoA] } },
      },
    });
    await app.db.getRepository('roles').create({ values: { name: writeRoleName, title: writeRoleName } });
    await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        roleName: writeRoleName,
        name: 'gitManager',
        usingActionsConfig: true,
        actions: [
          { name: 'fileContent', scope: writeRoleScope.id },
          { name: 'triggerReview', scope: writeRoleScope.id },
        ],
      },
    });
    await aclPlugin.writeRolesToACL({});
    const writeUser = await app.db.getRepository('users').create({
      values: { nickname: writeRoleName, roles: [{ name: writeRoleName }] },
    });
    const writer = await app.agent().login(writeUser, writeRoleName);

    const allowedWrite = await writer.resource('gitReviewFlows').create({
      values: { name: 'Scoped writer can create', repositoryId: repoA },
    });
    expect(allowedWrite.status).toBe(200);

    const deniedCrossRepositoryCreate = await writer.resource('gitReviewFlows').create({
      values: { name: 'Scoped writer cannot create outside scope', repositoryId: repoB },
    });
    expect(deniedCrossRepositoryCreate.status).toBe(403);

    const writeStatus = await writer.get(`${resourcerPrefix}/workflowGitReview:status`);
    expect(writeStatus.status).toBe(200);
    expect(writeStatus.body.data.flows.map((flow: { name: string; canWrite: boolean }) => flow.name)).toEqual([
      'ACL flow A',
      'Scoped writer can create',
    ]);
    expect(writeStatus.body.data.flows.every((flow: { canWrite: boolean }) => flow.canWrite)).toBe(true);

    const writeCutoverStatus = await writer.get(`${resourcerPrefix}/gitManager:reviewCutoverStatus`);
    expect(writeCutoverStatus.status).toBe(200);
    expect(writeCutoverStatus.body.data.data.canConfirmCutover).toBe(false);

    const deniedCrossRepositoryUpdate = await writer.resource('gitReviewFlows').update({
      filterByTk: flowB,
      values: { name: 'Cross-repository update' },
    });
    expect(deniedCrossRepositoryUpdate.status).toBe(200);
    const unchangedFlowB = await app.db.getRepository('gitReviewFlows').findOne({ filterByTk: flowB });
    expect(unchangedFlowB?.name).toBe('ACL flow B');

    const inboxB = await app.db.getRepository('gitReviewInbox').create({
      values: {
        projectKey: 'acl-repository-b',
        repositoryId: repoB,
        reviewId: 1002,
        eventKey: 'acl-repository-b-1002',
        queuedAt: new Date(),
        state: 'queued',
        payload: {},
      },
    });
    const deniedCrossRepositoryRecovery = await writer.resource('gitManager').reviewRecover({
      values: { confirmation: 'AI_STOPPED', inboxId: inboxB.id },
    });
    expect(deniedCrossRepositoryRecovery.status).toBe(403);

    const deniedScopedCutover = await writer.resource('gitManager').reviewConfirmCutover({
      values: { confirmation: 'OLD_WORKERS_AND_AI_STOPPED' },
    });
    expect(deniedScopedCutover.status).toBe(403);

    const deniedCrossRepositorySetup = await writer.resource('workflowGitReview').setup({
      values: { flowId: flowB, template: 'quick' },
    });
    expect(deniedCrossRepositorySetup.status).toBe(403);

    const allowedRepositorySetup = await writer.resource('workflowGitReview').setup({
      values: { flowId: flowA, template: 'quick' },
    });
    expect(allowedRepositorySetup.status).toBe(200);
    expect(allowedRepositorySetup.body.data.blockers).toContain('unsupported_dependencies');

    const readResource = await app.db.getRepository('dataSourcesRolesResources').findOne({
      filter: { roleName: readOnlyRoleName, name: 'gitManager' },
    });
    if (!readResource) throw new Error('The persisted Git Manager role resource is missing');
    await app.db.getRepository('dataSourcesRolesResourcesActions').destroy({
      filter: { rolesResourceId: readResource.id, name: 'fileContent' },
    });
    await aclPlugin.writeRolesToACL({});
    const afterRevocation = {
      gitManagerFileContent: app.acl.can({ role: readOnlyRoleName, resource: 'gitManager', action: 'fileContent' }),
      workflowGitReviewStatus: app.acl.can({
        role: readOnlyRoleName,
        resource: 'workflowGitReview',
        action: 'status',
      }),
    };
    expect(afterRevocation.gitManagerFileContent).toBeNull();
    expect(afterRevocation.workflowGitReviewStatus).toBeNull();
    const deniedAfterRevocation = await reader
      .get(`${resourcerPrefix}/workflowGitReview:status`)
      .set('X-Role', readOnlyRoleName);
    expect(deniedAfterRevocation.status).toBe(403);
  }, 120_000);

  it('handles old Git Review schema on unrelated and managed workflow paths', async () => {
    const unrelatedWorkflow = await app.db.getRepository('workflows').create({
      values: { type: 'collection', config: {} },
    });
    const markedWorkflow = await app.db.getRepository('workflows').create({
      values: { type: 'collection', config: {}, options: { gitReview: { frozen: true } } },
    });
    const requestBoundWorkflow = await app.db.getRepository('workflows').create({
      values: { type: 'collection', config: {} },
    });
    const inbox = await app.db.getRepository('gitReviewInbox').create({
      values: {
        projectKey: 'schema-regression',
        repositoryId: repoA,
        reviewId: 2001,
        eventKey: 'schema-regression-2001',
        queuedAt: new Date(),
        state: 'queued',
        payload: {},
      },
    });
    await app.db.getRepository('gitReviewRequests').create({
      values: {
        inboxId: inbox.id,
        reviewId: 2001,
        repositoryId: repoA,
        flowId: flowA,
        workflowId: requestBoundWorkflow.id,
        eventType: 'manual',
      },
    });

    const collection = app.db.getCollection('gitReviewFlows');
    const tableName = collection.getTableNameWithSchema();
    const queryInterface = app.db.sequelize.getQueryInterface();
    await queryInterface.removeColumn(tableName, 'workflowKey');
    await queryInterface.removeColumn(tableName, 'workflowId');
    await queryInterface.removeColumn(tableName, 'instructions');

    const roleName = 'custom-workflow-editor';
    const role = app.acl.define({ role: roleName });
    role.grantAction('workflows:create');
    role.grantAction('workflows:revision');
    const user = await app.db.getRepository('users').create({
      values: { nickname: roleName, roles: [{ name: roleName }] },
    });
    const editor = await app.agent().login(user, roleName);

    const unrelatedRevision = await editor.resource('workflows').revision({ filterByTk: unrelatedWorkflow.id });
    expect(unrelatedRevision.status).toBe(200);

    const markedRevision = await editor.resource('workflows').revision({
      filterByTk: markedWorkflow.id,
      values: { enabled: true },
    });
    expect(markedRevision.status).toBe(403);

    const requestBoundRevision = await editor.resource('workflows').revision({
      filterByTk: requestBoundWorkflow.id,
      values: { enabled: true },
    });
    expect(requestBoundRevision.status).toBe(403);

    const forbiddenReviewTrigger = await editor.resource('workflows').create({
      values: { type: 'collection', config: { collection: 'gitReviewRequests' } },
    });
    expect(forbiddenReviewTrigger.status).toBe(403);

    const gitManager = app.pm.get('git-manager') as PluginGitManagerServer;
    await gitManager.ensureReviewSchema();
    await gitManager.ensureReviewSchema();
    const columns = await queryInterface.describeTable(tableName);
    expect(columns).toHaveProperty('workflowKey');
    expect(columns).toHaveProperty('workflowId');
    expect(columns).toHaveProperty('instructions');
    await expect(app.db.getRepository('gitReviewFlows').findOne({ filterByTk: flowA })).resolves.toMatchObject({
      name: 'ACL flow A',
    });
  }, 120_000);
});

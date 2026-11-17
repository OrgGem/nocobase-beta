// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@nocobase/actions';
import { getApp } from '@nocobase/plugin-workflow-test';
import PluginGitManagerServer from '../../../../plugin-git-manager/src/server/plugin';
import PluginWorkflowGitReviewServer from '../plugin';
import { guardReviewReads } from '../read-guard';

type GuardContext = Parameters<typeof guardReviewReads>[0];

function createGuardContext(
  body: unknown,
  resourceName: string,
  actionName: string,
  params: Record<string, unknown>,
  db: unknown,
): GuardContext {
  return {
    body,
    action: { actionName, resourceName, params },
    request: { body: {} },
    query: {},
    state: {},
    db,
    app: { acl: {} },
  } as unknown as Context;
}

describe('Git Review read guard integration', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let testDbDirectory: string;

  beforeAll(async () => {
    testDbDirectory = mkdtempSync(join(tmpdir(), 'nocobase-git-review-read-guard-'));
    app = await getApp({
      acl: true,
      name: `git-review-read-guard-${Date.now()}`,
      database: { storage: join(testDbDirectory, 'main.sqlite') },
      plugins: [
        'error-handler',
        'data-source-main',
        [PluginGitManagerServer, { name: 'git-manager' }],
        [PluginWorkflowGitReviewServer, { name: 'workflow-git-review' }],
      ],
      skipSupervisor: true,
    });
  }, 120_000);

  afterAll(async () => {
    await app?.destroy();
    if (testDbDirectory) rmSync(testDbDirectory, { recursive: true, force: true });
  });

  async function rootAgent() {
    const user = await app.db.getRepository('users').findOne();
    if (!user) throw new Error('The disposable test database has no user');
    return app.agent().login(user);
  }

  it('keeps field Models available to the field-source middleware for both list response shapes', async () => {
    const agent = await rootAgent();

    const unpaginated = await agent.resource('collections.fields', 'users').list({
      paginate: false,
      sort: ['sort'],
      filter: { name: { $ne: 'id' } },
    });

    expect(unpaginated.status).toBe(200);
    expect(Array.isArray(unpaginated.body.data)).toBe(true);
    expect(unpaginated.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'nickname' })]));

    const paginated = await agent.resource('collections.fields', 'users').list({
      page: 1,
      pageSize: 5,
      sort: ['sort'],
    });

    expect(paginated.status).toBe(200);
    expect(Array.isArray(paginated.body.data)).toBe(true);
    expect(paginated.body.data.length).toBeGreaterThan(0);
    expect(paginated.body.meta).toMatchObject({ page: 1, pageSize: 5 });
  });

  it('keeps the data-source Model available to the data-source response middleware', async () => {
    const agent = await rootAgent();
    const response = await agent.resource('dataSources').get({ filterByTk: 'another' });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ key: 'another', type: 'sequelize' });
    expect(JSON.stringify(response.body)).not.toMatch(/dataValues|_previousDataValues|_options/);
  });

  it('removes execution context without identity and filters expanded jobs without identity', async () => {
    const hiddenContext = 'guard-hidden-execution-context';
    const executionContext = createGuardContext(
      { context: { secret: hiddenContext }, status: 1 },
      'executions',
      'get',
      {},
      {},
    );
    await guardReviewReads(executionContext, async () => undefined);
    expect(executionContext.body).toEqual({ status: 1 });
    expect(JSON.stringify(executionContext.body)).not.toContain(hiddenContext);

    const hiddenJob = 'guard-hidden-expanded-job';
    const collections = {
      workflowReadGuardContainers: {
        getField: (name: string) => (name === 'jobs' ? { target: 'jobs', isRelationField: () => true } : undefined),
        model: { associations: { jobs: { associationType: 'HasMany' } } },
      },
      jobs: { model: { primaryKeyAttribute: 'id' } },
    };
    const db = {
      getCollection: (name: keyof typeof collections) => collections[name],
    };
    const parent = createGuardContext(
      { id: 1, jobs: [{ nodeKey: 'review-job-without-id', result: { secret: hiddenJob } }] },
      'workflowReadGuardContainers',
      'get',
      { filterByTk: 1 },
      db,
    );
    await guardReviewReads(parent, async () => undefined);
    expect(parent.body).toEqual({ id: 1, jobs: [] });
    expect(JSON.stringify(parent.body)).not.toContain(hiddenJob);
  });
});

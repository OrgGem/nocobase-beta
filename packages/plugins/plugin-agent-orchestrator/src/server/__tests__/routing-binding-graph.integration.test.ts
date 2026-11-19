/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockServer, type MockServer } from '@nocobase/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginAgentOrchestratorServer } from '../plugin';
import { RoutingCycleError } from '../services/RoutingBindingValidation';

type Agent = ReturnType<MockServer['agent']>;

function routingBinding(leaderUsername: string, subAgentUsername: string, routingRole: 'specialist' | 'worker') {
  return {
    leaderUsername,
    subAgentUsername,
    enabled: true,
    routingEnabled: true,
    routingRole,
    routingPrompt: `Use ${subAgentUsername} for this routing test.`,
    maxDepth: 2,
    timeout: 5000,
  };
}

describe('routing binding graph transaction integration', () => {
  let app: MockServer;
  let rootAgent: Agent;
  let memberAgent: Agent;
  let suffix: string;

  beforeAll(async () => {
    suffix = `${process.pid}-${Date.now()}`;
    app = await createMockServer({
      plugins: ['nocobase', PluginAgentOrchestratorServer],
      name: `routing-binding-graph-${suffix}`,
      acl: true,
      skipSupervisor: true,
    });
    const users = app.db.getRepository('users');
    const root = await users.findOne({ filter: { 'roles.name': 'root' } });
    if (!root) throw new Error('Mock server did not seed a root user.');
    const member = await users.create({ values: { username: `routing-graph-member-${suffix}`, roles: ['member'] } });
    rootAgent = await app.agent().login(root);
    memberAgent = await app.agent().login(member);
  });

  afterAll(async () => {
    await app?.destroy();
  });

  it('serializes opposite native creates so exactly one edge can commit', async () => {
    const left = `routing-graph-left-${suffix}`;
    const right = `routing-graph-right-${suffix}`;
    const [leftToRight, rightToLeft] = await Promise.all([
      rootAgent.resource('orchestratorConfig').create({
        values: routingBinding(left, right, 'specialist'),
      }),
      rootAgent.resource('orchestratorConfig').create({
        values: routingBinding(right, left, 'worker'),
      }),
    ]);

    const responses = [leftToRight, rightToLeft];
    expect(responses.filter((response) => response.status === 200 || response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 400)).toHaveLength(1);

    const repository = app.db.getRepository('orchestratorConfig');
    const committed = await Promise.all([
      repository.findOne({ filter: { leaderUsername: left, subAgentUsername: right } }),
      repository.findOne({ filter: { leaderUsername: right, subAgentUsername: left } }),
    ]);
    expect(committed.filter(Boolean)).toHaveLength(1);
  });

  it('retains valid concurrent edges and partial updates', async () => {
    const firstParent = `routing-graph-valid-a-${suffix}`;
    const firstChild = `routing-graph-valid-b-${suffix}`;
    const secondParent = `routing-graph-valid-c-${suffix}`;
    const secondChild = `routing-graph-valid-d-${suffix}`;
    const [firstCreate, secondCreate] = await Promise.all([
      rootAgent.resource('orchestratorConfig').create({
        values: routingBinding(firstParent, firstChild, 'specialist'),
      }),
      rootAgent.resource('orchestratorConfig').create({
        values: routingBinding(secondParent, secondChild, 'worker'),
      }),
    ]);
    expect([firstCreate.status, secondCreate.status]).toEqual([200, 200]);

    const repository = app.db.getRepository('orchestratorConfig');
    const firstBinding = await repository.findOne({
      filter: { leaderUsername: firstParent, subAgentUsername: firstChild },
    });
    const secondBinding = await repository.findOne({
      filter: { leaderUsername: secondParent, subAgentUsername: secondChild },
    });
    if (!firstBinding || !secondBinding) throw new Error('Concurrent acyclic bindings were not persisted.');

    const firstId = Number(firstBinding.get('id'));
    const updateRequests = [
      () =>
        rootAgent.resource('orchestratorConfig').update({
          filterByTk: firstId,
          values: { routingPrompt: 'Keep the original parent and target while updating this description.' },
        }),
      () =>
        rootAgent.resource('orchestratorConfig').update({
          filterByTk: firstId,
          values: { llmService: 'routing-test-provider', model: 'routing-test-model' },
        }),
    ];
    // These metadata edits use native CRUD; SQLite has one writer, so run this race only on PostgreSQL.
    const updateResults =
      app.db.sequelize.getDialect() === 'sqlite'
        ? [await updateRequests[0](), await updateRequests[1]()]
        : await Promise.all(updateRequests.map((update) => update()));
    expect(updateResults.map((response) => response.status)).toEqual([200, 200]);

    const updated = await repository.findOne({ filterByTk: firstId });
    expect(updated?.get('leaderUsername')).toBe(firstParent);
    expect(updated?.get('subAgentUsername')).toBe(firstChild);
    expect(updated?.get('routingPrompt')).toBe('Keep the original parent and target while updating this description.');
    expect(updated?.get('llmService')).toBe('routing-test-provider');
    expect(updated?.get('model')).toBe('routing-test-model');
    expect(await repository.findOne({ filterByTk: secondBinding.get('id') })).toBeTruthy();
  });

  it('keeps a caller transaction usable after rejecting a cycle inside its savepoint', async () => {
    const parent = `routing-graph-tx-parent-${suffix}`;
    const child = `routing-graph-tx-child-${suffix}`;
    const validParent = `routing-graph-tx-valid-parent-${suffix}`;
    const validChild = `routing-graph-tx-valid-child-${suffix}`;
    const repository = app.db.getRepository('orchestratorConfig');

    await app.db.sequelize.transaction(async (transaction) => {
      await repository.create({ values: routingBinding(parent, child, 'specialist'), transaction });
      await expect(
        repository.create({ values: routingBinding(child, parent, 'worker'), transaction }),
      ).rejects.toBeInstanceOf(RoutingCycleError);
      await repository.create({ values: routingBinding(validParent, validChild, 'worker'), transaction });
    });

    expect(await repository.findOne({ filter: { leaderUsername: parent, subAgentUsername: child } })).toBeTruthy();
    expect(await repository.findOne({ filter: { leaderUsername: child, subAgentUsername: parent } })).toBeNull();
    expect(
      await repository.findOne({ filter: { leaderUsername: validParent, subAgentUsername: validChild } }),
    ).toBeTruthy();
  });

  it('defers nested afterCommit hooks to the caller transaction outcome', async () => {
    const repository = app.db.getRepository('orchestratorConfig');
    const model = app.db.getModel('orchestratorConfig');
    const hookName = `routing-graph-after-commit-${suffix}`;
    let callbackCount = 0;
    model.addHook('afterCreate', hookName, (_record, options) => {
      options.transaction?.afterCommit(() => {
        callbackCount += 1;
      });
    });

    try {
      await app.db.sequelize.transaction(async (transaction) => {
        await repository.create({
          values: routingBinding(`routing-graph-hook-commit-${suffix}`, `routing-graph-hook-child-${suffix}`, 'worker'),
          transaction,
        });
        expect(callbackCount).toBe(0);
      });
      expect(callbackCount).toBe(1);

      await expect(
        app.db.sequelize.transaction(async (transaction) => {
          await repository.create({
            values: routingBinding(
              `routing-graph-hook-rollback-${suffix}`,
              `routing-graph-hook-rollback-child-${suffix}`,
              'worker',
            ),
            transaction,
          });
          expect(callbackCount).toBe(1);
          throw new Error('rollback caller transaction');
        }),
      ).rejects.toThrow('rollback caller transaction');
      expect(callbackCount).toBe(1);
    } finally {
      model.removeHook('afterCreate', hookName);
    }
  });

  it('rolls back every row when a bulk create would introduce a cycle', async () => {
    const left = `routing-graph-bulk-left-${suffix}`;
    const right = `routing-graph-bulk-right-${suffix}`;
    const repository = app.db.getRepository('orchestratorConfig');

    await expect(
      repository.createMany({
        records: [routingBinding(left, right, 'specialist'), routingBinding(right, left, 'worker')],
      }),
    ).rejects.toBeInstanceOf(RoutingCycleError);

    expect(await repository.find({ filter: { leaderUsername: left } })).toHaveLength(0);
    expect(await repository.find({ filter: { leaderUsername: right } })).toHaveLength(0);
  });

  it('preserves the routing graph collection ACL for non-root users', async () => {
    const response = await memberAgent.resource('orchestratorConfig').create({
      values: routingBinding(`routing-graph-denied-${suffix}`, `routing-graph-target-${suffix}`, 'specialist'),
    });
    expect(response.status).toBe(403);
  });
});

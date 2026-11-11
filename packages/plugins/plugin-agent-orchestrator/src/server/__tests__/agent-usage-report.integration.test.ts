/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockServer, type MockServer } from '@nocobase/test';
import { PluginAgentOrchestratorServer } from '../plugin';

const FROM = '2026-11-01T00:00:00.000Z';
const TO = '2026-11-11T00:00:00.000Z';

type UsageCall = {
  id: number;
  usageIdentity: string;
  usageOccurredAt: Date;
  model: string;
  employeeUsername: string;
  userId: number;
  departmentId: string | number | null;
  departmentAttribution?: string | null;
  usageSource: 'actual' | 'estimated' | 'missing';
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cost: number | null;
  priceCurrency: string | null;
  pricingStatus: string;
};

describe('agent usage reporting over HTTP', () => {
  let app: MockServer;
  let adminAgent: ReturnType<MockServer['agent']>;
  let memberAgent: ReturnType<MockServer['agent']>;
  let departmentId: string;
  let inferredUserId: number;
  let unassignedUserId: number;
  let callIds: Record<string, string>;

  beforeAll(async () => {
    app = await createMockServer({
      plugins: ['nocobase', PluginAgentOrchestratorServer],
      name: `agent-usage-report-${process.pid}`,
      acl: true,
      skipSupervisor: true,
    });

    const users = app.db.getRepository('users');
    const admin = await users.findOne({ filter: { 'roles.name': 'root' } });
    if (!admin) throw new Error('Mock server did not create its root user.');
    const member = await users.create({
      values: { username: `usage-report-member-${process.pid}`, roles: ['member'] },
    });
    const inferredUser = await users.create({
      values: { username: `usage-report-inferred-${process.pid}`, roles: ['member'] },
    });
    const unassignedUser = await users.create({
      values: { username: `usage-report-unassigned-${process.pid}`, roles: ['member'] },
    });
    adminAgent = await app.agent().login(admin);
    memberAgent = await app.agent().login(member);
    inferredUserId = Number(inferredUser.id);
    unassignedUserId = Number(unassignedUser.id);

    const userCollection = app.db.getCollection('users');
    if (!userCollection.hasField('mainDepartmentId')) {
      userCollection.addField('mainDepartmentId', { type: 'bigInt', allowNull: true });
      await userCollection.sync();
    }
    departmentId = '9007199254740993';
    const otherDepartmentId = (BigInt(departmentId) + 1n).toString();
    const memberships = app.db.collection({
      name: 'departmentsUsers',
      fields: [
        { name: 'userId', type: 'bigInt', allowNull: false },
        { name: 'departmentId', type: 'bigInt', allowNull: false },
      ],
    });
    await memberships.sync();
    await app.db.getRepository('users').update({
      filterByTk: inferredUserId,
      values: { mainDepartmentId: departmentId },
    });
    await app.db.getRepository('departmentsUsers').create({
      values: { userId: inferredUserId, departmentId },
    });

    const spans = app.db.getRepository('agentExecutionSpans');
    const common = {
      source: 'native-plugin-ai',
      type: 'model_call',
      status: 'success',
      pricingStatus: 'configured',
      createdAt: new Date('2026-11-05T00:00:00.000Z'),
      updatedAt: new Date('2026-11-05T00:00:00.000Z'),
    };
    const calls: Array<Omit<UsageCall, 'id'> & { rootRunId: string; startedAt: Date }> = [
      {
        ...common,
        rootRunId: 'usage-report-a',
        startedAt: new Date('2026-11-09T12:00:00.000Z'),
        usageIdentity: 'usage-report:a',
        usageOccurredAt: new Date('2026-11-09T12:00:00.000Z'),
        model: 'model-alpha',
        employeeUsername: 'employee-alice',
        userId: inferredUserId,
        departmentId,
        departmentAttribution: 'snapshot',
        usageSource: 'actual',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cost: 0.2,
        priceCurrency: 'USD',
      },
      {
        ...common,
        rootRunId: 'usage-report-b',
        startedAt: new Date('2026-11-08T12:00:00.000Z'),
        usageIdentity: 'usage-report:b',
        usageOccurredAt: new Date('2026-11-08T12:00:00.000Z'),
        model: 'model-beta',
        employeeUsername: 'employee-bob',
        userId: inferredUserId,
        departmentId: null,
        departmentAttribution: null,
        usageSource: 'estimated',
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        cost: null,
        priceCurrency: null,
        pricingStatus: 'unpriced',
      },
      {
        ...common,
        rootRunId: 'usage-report-c',
        startedAt: new Date('2026-11-07T12:00:00.000Z'),
        usageIdentity: 'usage-report:c',
        usageOccurredAt: new Date('2026-11-07T12:00:00.000Z'),
        model: 'model-alpha',
        employeeUsername: 'employee-alice',
        userId: unassignedUserId,
        departmentId: null,
        departmentAttribution: null,
        usageSource: 'missing',
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        cost: null,
        priceCurrency: null,
        pricingStatus: 'unpriced',
      },
      {
        ...common,
        rootRunId: 'usage-report-d',
        startedAt: new Date('2026-11-06T12:00:00.000Z'),
        usageIdentity: 'usage-report:d',
        usageOccurredAt: new Date('2026-11-06T12:00:00.000Z'),
        model: 'model-gamma',
        employeeUsername: 'employee-carol',
        userId: unassignedUserId,
        departmentId: otherDepartmentId,
        departmentAttribution: 'snapshot',
        usageSource: 'actual',
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        cost: 1.4,
        priceCurrency: 'EUR',
      },
      {
        ...common,
        rootRunId: 'usage-report-e',
        startedAt: new Date('2026-11-05T12:00:00.000Z'),
        usageIdentity: 'usage-report:e',
        usageOccurredAt: new Date('2026-11-05T12:00:00.000Z'),
        model: 'model-gamma',
        employeeUsername: 'employee-carol',
        userId: inferredUserId,
        departmentId,
        departmentAttribution: 'snapshot',
        usageSource: 'actual',
        inputTokens: 50,
        outputTokens: 25,
        totalTokens: 75,
        cost: 0.6,
        priceCurrency: 'USD',
      },
    ];

    callIds = {};
    for (const call of calls) {
      const { rootRunId, startedAt, ...values } = call;
      const row = await spans.create({ values: { ...values, rootRunId, startedAt } });
      callIds[rootRunId.slice(-1)] = String(row.id);
    }
  });

  afterAll(async () => {
    await app?.destroy();
  });

  it('allows administrators to query reports and denies authenticated members', async () => {
    const adminResponse = await adminAgent.resource('agentUsage').summary({ from: FROM, to: TO });
    expect(adminResponse.status).toBe(200);
    expect(adminResponse.body.data.data.calls).toBe(5);

    const memberResponse = await memberAgent.resource('agentUsage').summary({ from: FROM, to: TO });
    expect(memberResponse.status).toBe(403);
    await expect(memberAgent.resource('agentUsage').calls({ from: FROM, to: TO })).resolves.toMatchObject({
      status: 403,
    });
    await expect(
      memberAgent.resource('agentUsage').breakdown({ from: FROM, to: TO, groupBy: 'model' }),
    ).resolves.toMatchObject({
      status: 403,
    });
  });

  it('filters calls by date, model, employee, user, and snapshot department', async () => {
    const dateFilter = {
      from: '2026-11-09T00:00:00.000Z',
      to: '2026-11-10T00:00:00.000Z',
    };
    const individualFilters = [
      { model: 'model-alpha' },
      { employeeUsername: 'employee-alice' },
      { userId: inferredUserId },
      { departmentId },
    ];
    for (const filter of individualFilters) {
      const filtered = await adminAgent.resource('agentUsage').calls({ ...dateFilter, ...filter });
      expect(
        filtered.body.data.data.map((row: UsageCall) => row.usageIdentity),
        `Filter ${JSON.stringify(filter)} should retain the matching call.`,
      ).toContain('usage-report:a');
    }

    const response = await adminAgent.resource('agentUsage').calls({
      ...dateFilter,
      model: 'model-alpha',
      employeeUsername: 'employee-alice',
      userId: inferredUserId,
      departmentId,
      page: 1,
      pageSize: 10,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.data).toHaveLength(1);
    expect(response.body.data.data[0]).toMatchObject({
      id: callIds.a,
      usageIdentity: 'usage-report:a',
      departmentId,
      departmentAttribution: 'snapshot',
    });

    const outsideRange = await adminAgent.resource('agentUsage').calls({
      from: FROM,
      to: '2026-11-09T00:00:00.000Z',
      model: 'model-alpha',
    });
    expect(outsideRange.status).toBe(200);
    expect(outsideRange.body.data.data.map((row: UsageCall) => row.usageIdentity)).toContain('usage-report:c');
    expect(outsideRange.body.data.data.map((row: UsageCall) => row.usageIdentity)).not.toContain('usage-report:a');
  });

  it('reports missing and estimated usage, inferred and unknown departments, and currency-separated costs', async () => {
    const response = await adminAgent.resource('agentUsage').summary({
      from: FROM,
      to: TO,
      includeInferredDepartment: true,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.data).toMatchObject({
      calls: 5,
      actualCalls: 3,
      estimatedCalls: 1,
      missingCalls: 1,
      unpricedCalls: 2,
      snapshotCalls: 3,
      inferredCalls: 1,
      unattributedCalls: 1,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
    expect(response.body.data.data.knownTotalTokens).toBe(555);
    expect(response.body.data.data.totalTokensReportedCalls).toBe(4);
    expect(response.body.data.data.coverage.departmentAttribution).toBe('snapshot-or-current-membership-inference');
    expect(response.body.data.data.coverage.inferenceAvailable).toBe(true);
    expect(response.body.data.data.costByCurrency).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ currency: 'EUR', knownCost: 1.4 }),
        expect.objectContaining({ currency: 'USD', knownCost: 0.8 }),
      ]),
    );

    const breakdown = await adminAgent.resource('agentUsage').breakdown({
      from: FROM,
      to: TO,
      groupBy: 'departmentId',
      includeInferredDepartment: true,
      page: 1,
      pageSize: 100,
    });
    expect(breakdown.status).toBe(200);
    expect(breakdown.body.data.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: departmentId, departmentAttribution: 'snapshot', currency: 'USD' }),
        expect.objectContaining({ key: departmentId, departmentAttribution: 'inferred', currency: null }),
        expect.objectContaining({ key: null, departmentAttribution: 'unknown', currency: null }),
      ]),
    );
  });

  it('paginates persisted calls in stable time order and rejects invalid filters', async () => {
    const first = await adminAgent.resource('agentUsage').calls({ from: FROM, to: TO, page: 1, pageSize: 2 });
    const second = await adminAgent.resource('agentUsage').calls({ from: FROM, to: TO, page: 2, pageSize: 2 });
    const third = await adminAgent.resource('agentUsage').calls({ from: FROM, to: TO, page: 3, pageSize: 2 });

    expect(first.status).toBe(200);
    expect(first.body.data.meta).toMatchObject({ count: 5, page: 1, pageSize: 2, totalPage: 3 });
    expect(first.body.data.data.map((row: UsageCall) => row.usageIdentity)).toEqual([
      'usage-report:a',
      'usage-report:b',
    ]);
    expect(second.body.data.data.map((row: UsageCall) => row.usageIdentity)).toEqual([
      'usage-report:c',
      'usage-report:d',
    ]);
    expect(third.body.data.data.map((row: UsageCall) => row.usageIdentity)).toEqual(['usage-report:e']);

    const invalid = await adminAgent.resource('agentUsage').calls({ from: TO, to: FROM });
    expect(invalid.status).toBe(400);
  });
});

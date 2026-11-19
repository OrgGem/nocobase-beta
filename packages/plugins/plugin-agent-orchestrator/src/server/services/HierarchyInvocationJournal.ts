// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import type { Database, Model } from '@nocobase/database';
import { read } from '../utils/record-utils';

export type HierarchyInvocationKey = {
  ownerId: number;
  parentSessionId: string;
  parentToolCallId: string;
};

export type HierarchySnapshot = {
  profileTag: string;
  profileVersion: number;
  profileVersionId: number;
  policy: unknown;
  model: { llmService: string; model: string };
  provider?: string;
  ancestors: string[];
  bindingTimeout?: number;
  bindingMaxDepth?: number;
};

export type ReserveHierarchyInvocation = HierarchyInvocationKey & {
  rootSessionId: string;
  parentEmployee: string;
  employeeUsername: string;
  role: 'specialist' | 'worker';
  question: string;
  snapshot: HierarchySnapshot;
};

function digest(question: string) {
  return createHash('sha256').update(question, 'utf8').digest('hex');
}

function requireKey(key: HierarchyInvocationKey) {
  if (!Number.isSafeInteger(key.ownerId) || key.ownerId <= 0 || !key.parentSessionId || !key.parentToolCallId) {
    throw new Error('Invalid hierarchy invocation identity.');
  }
}

/** Store for hierarchy invocations. It never reclaims uncertain in-flight work. */
export class HierarchyInvocationJournal {
  constructor(private readonly database: Database) {}

  private async findOwned(key: HierarchyInvocationKey) {
    requireKey(key);
    const row = await this.database.getRepository('agentHierarchyInvocations').findOne({
      filter: { parentSessionId: key.parentSessionId, parentToolCallId: key.parentToolCallId, ownerId: key.ownerId },
    });
    if (!row) throw new Error('The hierarchy invocation is unavailable.');
    return row;
  }

  async get(key: HierarchyInvocationKey) {
    return this.findOwned(key);
  }

  private assertSame(row: Model, input: ReserveHierarchyInvocation) {
    if (
      Number(read(row, 'ownerId')) !== input.ownerId ||
      read(row, 'rootSessionId') !== input.rootSessionId ||
      read(row, 'parentEmployee') !== input.parentEmployee ||
      read(row, 'employeeUsername') !== input.employeeUsername ||
      read(row, 'role') !== input.role ||
      read(row, 'questionHash') !== digest(input.question)
    ) {
      throw new Error('The hierarchy invocation identity does not match the existing request.');
    }
    return row;
  }

  async reserve(input: ReserveHierarchyInvocation): Promise<Model> {
    requireKey(input);
    if (!input.rootSessionId || !input.parentEmployee || !input.employeeUsername || !input.question) {
      throw new Error('Incomplete hierarchy invocation.');
    }
    try {
      return await this.database.getRepository('agentHierarchyInvocations').create({
        values: {
          ownerId: input.ownerId,
          rootSessionId: input.rootSessionId,
          parentSessionId: input.parentSessionId,
          parentToolCallId: input.parentToolCallId,
          parentEmployee: input.parentEmployee,
          employeeUsername: input.employeeUsername,
          role: input.role,
          questionHash: digest(input.question),
          snapshot: input.snapshot,
          status: 'reserved',
        },
      });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'SequelizeUniqueConstraintError') throw error;
      return this.assertSame(await this.findOwned(input), input);
    }
  }

  async claim(key: HierarchyInvocationKey) {
    const row = await this.findOwned(key);
    const status = read(row, 'status');
    if (status !== 'reserved') throw new Error('The hierarchy invocation is not ready.');
    const token = randomUUID();
    const [updated] = await this.database
      .getModel('agentHierarchyInvocations')
      .update(
        { status: 'running', claimToken: token },
        { where: { id: read(row, 'id'), ownerId: key.ownerId, status } },
      );
    if (updated !== 1) throw new Error('The hierarchy invocation was claimed by another request.');
    return { row, token };
  }

  private async updateClaim(key: HierarchyInvocationKey, token: string, values: Record<string, unknown>) {
    requireKey(key);
    if (!token) throw new Error('A hierarchy claim is required.');
    const [updated] = await this.database.getModel('agentHierarchyInvocations').update(values, {
      where: {
        parentSessionId: key.parentSessionId,
        parentToolCallId: key.parentToolCallId,
        ownerId: key.ownerId,
        status: 'running',
        claimToken: token,
      },
    });
    if (updated !== 1) throw new Error('The hierarchy claim is no longer active.');
  }

  async attachChild(key: HierarchyInvocationKey, token: string, childSessionId: string) {
    if (!childSessionId) throw new Error('A child session is required.');
    await this.updateClaim(key, token, { childSessionId });
  }

  async complete(key: HierarchyInvocationKey, token: string, result: unknown, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('The hierarchy invocation was cancelled.');
    await this.updateClaim(key, token, { status: 'succeeded', claimToken: null, result });
    if (signal?.aborted) {
      await this.database.getModel('agentHierarchyInvocations').update(
        { status: 'uncertain', result: null },
        {
          where: {
            parentSessionId: key.parentSessionId,
            parentToolCallId: key.parentToolCallId,
            ownerId: key.ownerId,
            status: 'succeeded',
          },
        },
      );
      throw new Error('The hierarchy invocation was cancelled.');
    }
  }

  async markUncertain(key: HierarchyInvocationKey, token: string) {
    await this.updateClaim(key, token, { status: 'uncertain', claimToken: null });
  }

  async invalidateCompleted(key: HierarchyInvocationKey) {
    requireKey(key);
    await this.database.getModel('agentHierarchyInvocations').update(
      { status: 'uncertain', result: null },
      {
        where: {
          parentSessionId: key.parentSessionId,
          parentToolCallId: key.parentToolCallId,
          ownerId: key.ownerId,
          status: 'succeeded',
        },
      },
    );
  }
}

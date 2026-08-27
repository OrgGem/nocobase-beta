import type { Database, Model } from '@nocobase/database';
import { getRunEventBus } from './RunEventBus';
import { read } from '../utils/record-utils';

export type LoopRunRecord = Record<string, unknown>;

export class LoopRunAccessError extends Error {
  constructor(
    public readonly status: 401 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'LoopRunAccessError';
  }
}

function plain(record: Model | LoopRunRecord): LoopRunRecord {
  return typeof (record as Model).toJSON === 'function'
    ? ((record as Model).toJSON() as LoopRunRecord)
    : structuredClone(record as LoopRunRecord);
}

function positiveId(value: unknown, label: string) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new LoopRunAccessError(404, `${label} was not found.`);
  }
  return parsed;
}

function requireUserId(userId: number | undefined) {
  if (!Number.isSafeInteger(userId) || Number(userId) <= 0) {
    throw new LoopRunAccessError(401, 'Authentication is required.');
  }
  return Number(userId);
}

function mergeFilter(filter: Record<string, unknown>, required: Record<string, unknown>) {
  return Object.keys(filter).length > 0 ? { $and: [filter, required] } : required;
}

export class LoopRunRepository {
  constructor(private readonly database: Database) {}

  async requireRun(runId: string | number) {
    const id = positiveId(runId, 'Agent loop run');
    const record = await this.database.getRepository('agentLoopRuns').findOne({ filterByTk: id });
    if (!record) throw new LoopRunAccessError(404, `Agent loop run ${id} was not found.`);
    return plain(record);
  }

  async requireOwnedRun(runId: string | number, userId: number | undefined, isAdmin: boolean) {
    const authenticatedUserId = requireUserId(userId);
    const run = await this.requireRun(runId);
    if (!isAdmin && Number(run.userId) !== authenticatedUserId) {
      throw new LoopRunAccessError(403, 'You cannot access this agent loop run.');
    }
    return run;
  }

  async requireMutableV2Run(runId: string | number, userId: number | undefined, isAdmin: boolean) {
    const run = await this.requireOwnedRun(runId, userId, isAdmin);
    if (run.runtimeVersion !== 'control-plane-v2') {
      throw new LoopRunAccessError(409, 'Historical plan-era runs are read-only.');
    }
    return run;
  }

  async listOwnedRuns(input: {
    userId: number | undefined;
    isAdmin: boolean;
    filter?: Record<string, unknown>;
    sort?: string[];
    page?: number;
    pageSize?: number;
  }) {
    const userId = requireUserId(input.userId);
    const page = Number.isSafeInteger(input.page) && Number(input.page) > 0 ? Number(input.page) : 1;
    const pageSize =
      Number.isSafeInteger(input.pageSize) && Number(input.pageSize) > 0 ? Math.min(Number(input.pageSize), 100) : 20;
    const requestedFilter = input.filter || {};
    const filter = input.isAdmin ? requestedFilter : mergeFilter(requestedFilter, { userId });
    const [rows, count] = await this.database.getRepository('agentLoopRuns').findAndCount({
      filter,
      sort: input.sort || ['-createdAt'],
      offset: (page - 1) * pageSize,
      limit: pageSize,
    });
    return {
      rows: rows.map(plain),
      count,
      page,
      pageSize,
      totalPage: Math.ceil(count / pageSize),
    };
  }

  async listOwnedRunIds(userId: number | undefined, isAdmin: boolean) {
    const authenticatedUserId = requireUserId(userId);
    const repository = this.database.getRepository('agentLoopRuns');
    const filter = isAdmin ? {} : { userId: authenticatedUserId };
    const pageSize = 5_000;
    const ids: number[] = [];
    for (let page = 1; ; page += 1) {
      const rows = await repository.find({ filter, fields: ['id'], sort: ['id'], page, pageSize });
      for (const row of rows) {
        ids.push(positiveId(read(row, 'id'), 'Agent loop run'));
      }
      if (rows.length < pageSize) break;
    }
    return ids;
  }

  async getOwnedRunDetail(runId: string | number, userId: number | undefined, isAdmin: boolean) {
    const run = await this.requireOwnedRun(runId, userId, isAdmin);
    const id = positiveId(run.id, 'Agent loop run');
    const rootRunId = typeof run.rootRunId === 'string' ? run.rootRunId : '';
    const [steps, events, spans, artifacts, approvals, skillExecutions] = await Promise.all([
      this.database.getRepository('agentLoopSteps').find({ filter: { runId: id }, sort: ['index', 'createdAt'] }),
      this.database.getRepository('agentLoopEvents').find({ filter: { runId: id }, sort: ['id'], pageSize: 1000 }),
      this.database
        .getRepository('agentExecutionSpans')
        .find({ filter: { agentLoopRunId: id }, sort: ['createdAt'], pageSize: 1000 }),
      this.database.getRepository('agentLoopArtifacts').find({ filter: { runId: id }, sort: ['createdAt'] }),
      this.database.getRepository('agentLoopActionApprovals').find({ filter: { runId: id }, sort: ['createdAt'] }),
      this.database.getRepository('skillExecutions')
        ? this.database
            .getRepository('skillExecutions')
            .find({ filter: { agentLoopRunId: String(id) }, sort: ['createdAt'], pageSize: 1000 })
        : [],
    ]);
    return {
      run: {
        ...run,
        historical: run.runtimeVersion !== 'control-plane-v2',
        readOnly: run.runtimeVersion !== 'control-plane-v2',
      },
      steps: steps.map(plain),
      events: events.map(plain),
      spans: spans.map(plain),
      artifacts: artifacts.map(plain),
      approvals: approvals.map(plain),
      skillExecutions: skillExecutions.map(plain),
      rootRunId,
    };
  }

  async listApprovals(input: {
    userId: number | undefined;
    isAdmin: boolean;
    filter?: Record<string, unknown>;
    sort?: string[];
    page?: number;
    pageSize?: number;
  }) {
    const userId = requireUserId(input.userId);
    // Scope via the run association so ownership holds for any number of runs
    // (a materialized id list would silently truncate for prolific users).
    const accessible = input.isAdmin
      ? {}
      : {
          $or: [{ assignedToId: userId }, { 'run.userId': userId }],
        };
    return this.findAndCount('agentLoopActionApprovals', input, accessible);
  }

  async requireAccessibleApproval(approvalId: string | number, userId: number | undefined, isAdmin: boolean) {
    const authenticatedUserId = requireUserId(userId);
    const id = positiveId(approvalId, 'Agent loop approval');
    const record = await this.database.getRepository('agentLoopActionApprovals').findOne({ filterByTk: id });
    if (!record) throw new LoopRunAccessError(404, `Agent loop approval ${id} was not found.`);
    const approval = plain(record);
    const run = await this.requireRun(positiveId(approval.runId, 'Agent loop run'));
    if (
      !isAdmin &&
      Number(run.userId) !== authenticatedUserId &&
      Number(approval.assignedToId) !== authenticatedUserId
    ) {
      throw new LoopRunAccessError(403, 'You cannot access this agent loop approval.');
    }
    return approval;
  }

  // Records a human decision on one approval and requeues the run once every pending approval of
  // the run has been decided. Fail-closed throughout: an expired window, a decided row, or a run
  // that moved on all reject the decision instead of guessing what the human meant.
  async decideApproval(input: {
    approvalId: string | number;
    userId: number | undefined;
    isAdmin: boolean;
    decision: 'approved' | 'rejected';
    note?: string;
    editedInput?: unknown;
  }) {
    const decidedById = requireUserId(input.userId);
    const id = positiveId(input.approvalId, 'Agent loop approval');
    // Fast access check before taking row locks; the transaction re-reads the rows anyway.
    await this.requireAccessibleApproval(id, input.userId, input.isAdmin);

    const committed = await this.database.sequelize.transaction(async (transaction) => {
      const approvals = this.database.getRepository('agentLoopActionApprovals');
      const runs = this.database.getRepository('agentLoopRuns');
      const record = await approvals.findOne({ filterByTk: id, transaction, lock: transaction.LOCK.UPDATE });
      if (!record) throw new LoopRunAccessError(404, `Agent loop approval ${id} was not found.`);
      const approval = plain(record);

      if (approval.status !== 'pending') {
        throw new LoopRunAccessError(409, `This approval has already been ${String(approval.status)}.`);
      }
      const expiresAt = approval.expiresAt ? new Date(String(approval.expiresAt)) : null;
      if (expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= Date.now()) {
        throw new LoopRunAccessError(409, 'The approval window has expired. Retry the run to request approval again.');
      }

      const runId = positiveId(approval.runId, 'Agent loop run');
      const runRecord = await runs.findOne({ filterByTk: runId, transaction, lock: transaction.LOCK.UPDATE });
      if (!runRecord) throw new LoopRunAccessError(404, `Agent loop run ${runId} was not found.`);
      const run = plain(runRecord);
      if (run.runtimeVersion !== 'control-plane-v2') {
        throw new LoopRunAccessError(409, 'Historical plan-era runs are read-only.');
      }
      // A paused run keeps its decisions; the human resume requeues it later. Any other status
      // means the run moved on and the decision can no longer be applied.
      if (run.status !== 'waiting_approval' && run.status !== 'paused') {
        throw new LoopRunAccessError(409, 'The run is no longer waiting for approval.');
      }

      const now = new Date();
      await approvals.update({
        filterByTk: id,
        values: {
          status: input.decision,
          decidedById,
          decidedAt: now,
          decisionNote: input.note || null,
          ...(input.decision === 'approved' && input.editedInput !== undefined
            ? { editedInput: input.editedInput }
            : {}),
        },
        transaction,
      });

      const remaining = await approvals.find({ filter: { runId, status: 'pending' }, transaction });
      let requeued = false;
      let event: LoopRunRecord | null = null;
      if (!remaining.length && run.status === 'waiting_approval') {
        await runs.update({
          filterByTk: runId,
          values: { status: 'queued', approvalStatus: 'decided' },
          transaction,
        });
        const created = await this.database.getRepository('agentLoopEvents').create({
          values: {
            runId,
            type: 'run_approval_decided',
            title: 'Approvals decided',
            content: 'All pending action approvals were decided. Run requeued to resume.',
            status: 'queued',
            payload: { decision: input.decision },
            actorType: 'human',
            actorIdentity: String(decidedById),
            correlationKey: `approval-decided:${runId}`,
            createdAt: now,
          },
          transaction,
        });
        event = typeof created.toJSON === 'function' ? created.toJSON() : created;
        requeued = true;
      }
      return { approval, runId, requeued, event };
    });

    if (committed.requeued && committed.event) getRunEventBus().emit(committed.runId, committed.event);
    return {
      ...committed.approval,
      status: input.decision,
      decidedById,
      requeued: committed.requeued,
    };
  }

  async listArtifacts(input: {
    userId: number | undefined;
    isAdmin: boolean;
    filter?: Record<string, unknown>;
    sort?: string[];
    page?: number;
    pageSize?: number;
  }) {
    const userId = requireUserId(input.userId);
    const accessible = input.isAdmin ? {} : { 'run.userId': userId };
    return this.findAndCount('agentLoopArtifacts', input, accessible);
  }

  async requireOwnedArtifact(artifactId: string | number, userId: number | undefined, isAdmin: boolean) {
    const id = positiveId(artifactId, 'Agent loop artifact');
    const record = await this.database.getRepository('agentLoopArtifacts').findOne({ filterByTk: id });
    if (!record) throw new LoopRunAccessError(404, `Agent loop artifact ${id} was not found.`);
    const artifact = plain(record);
    await this.requireOwnedRun(positiveId(artifact.runId, 'Agent loop run'), userId, isAdmin);
    return artifact;
  }

  private async findAndCount(
    collection: string,
    input: {
      filter?: Record<string, unknown>;
      sort?: string[];
      page?: number;
      pageSize?: number;
    },
    accessible: Record<string, unknown>,
  ) {
    const page = Number.isSafeInteger(input.page) && Number(input.page) > 0 ? Number(input.page) : 1;
    const pageSize =
      Number.isSafeInteger(input.pageSize) && Number(input.pageSize) > 0 ? Math.min(Number(input.pageSize), 100) : 20;
    const filter = mergeFilter(input.filter || {}, accessible);
    const [rows, count] = await this.database.getRepository(collection).findAndCount({
      filter,
      sort: input.sort || ['-createdAt'],
      offset: (page - 1) * pageSize,
      limit: pageSize,
    });
    return {
      rows: rows.map(plain),
      count,
      page,
      pageSize,
      totalPage: Math.ceil(count / pageSize),
    };
  }
}

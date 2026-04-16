import { Context } from '@nocobase/actions';

export const workflowActions = {
  async list(ctx: Context, next: () => Promise<void>) {
    const repo = ctx.db.getRepository('executions');
    const { page = 1, pageSize = 20, statusFilter } = ctx.action.params;

    const filter: any = {};
    if (statusFilter !== undefined && statusFilter !== '') {
       filter.status = statusFilter === 'null' ? null : Number(statusFilter);
    }

    const [rows, count] = await repo.findAndCount({
      filter,
      appends: ['workflow'],
      offset: (page - 1) * pageSize,
      limit: pageSize,
      sort: ['-createdAt'],
    });

    const redis = (ctx.app as any).redisConnectionManager?.getConnection();
    if (redis && rows.length > 0) {
      try {
        const keys = rows.map((r: any) => `worker-monitor:exec-node:${r.id}`);
        const nodes = await redis.sendCommand(['MGET', ...keys]);
        if (Array.isArray(nodes)) {
          rows.forEach((row: any, i: number) => {
             row.setDataValue('workerNode', nodes[i] || '-');
          });
        }
      } catch (e) {
        // ignore errors
      }
    }

    ctx.body = {
      data: rows,
      meta: { count, page: Number(page), pageSize: Number(pageSize) },
    };
    await next();
  },

  async getJobs(ctx: Context, next: () => Promise<void>) {
    const { filterByTk } = ctx.action.params;
    if (!filterByTk) {
      ctx.throw(400, 'Execution ID is required');
    }

    const repo = ctx.db.getRepository('jobs');
    const jobs = await repo.find({
      filter: { executionId: filterByTk },
      appends: ['node'],
      sort: ['id'],
    });

    ctx.body = { data: jobs };
    await next();
  },

  async cancel(ctx: Context, next: () => Promise<void>) {
    const { filterByTk } = ctx.action.params;
    if (!filterByTk) {
      ctx.throw(400, 'Execution ID is required');
    }

    const repo = ctx.db.getRepository('executions');
    const execution = await repo.findOne({ filterByTk });
    if (!execution) {
      ctx.throw(404, 'Execution not found');
    }

    const status = execution.get('status');
    // QUEUEING = null, STARTED = 0
    if (status !== null && status !== 0) {
      ctx.throw(400, 'Execution is not running or queued');
    }

    await repo.update({
      filterByTk,
      values: { status: -4 }, // CANCELED
    });

    // Cancel all pending jobs
    const jobRepo = ctx.db.getRepository('jobs');
    await jobRepo.update({
      filter: { executionId: filterByTk, status: 0 }, // PENDING
      values: { status: -4 }, // CANCELED
    });

    ctx.body = { success: true };
    await next();
  },

  async purge(ctx: Context, next: () => Promise<void>) {
    const { days = 0 } = ctx.action.params.values || ctx.action.params;
    const repo = ctx.db.getRepository('executions');
    const jobRepo = ctx.db.getRepository('jobs');
    
    const filter: any = {
      $and: [
        { status: { $ne: 0 } },
        { status: { $ne: null } }
      ]
    };

    if (days && Number(days) > 0) {
      const date = new Date();
      date.setDate(date.getDate() - Number(days));
      filter.createdAt = {
        $lt: date.toISOString(),
      };
    }

    const execs = await repo.find({ filter, fields: ['id'] });
    const ids = execs.map((e: any) => e.get('id'));
    
    let deletedCount = 0;
    if (ids.length > 0) {
       await jobRepo.destroy({ filter: { executionId: { $in: ids } } });
       deletedCount = await repo.destroy({ filter: { id: { $in: ids } } });
    }

    ctx.body = { success: true, deletedCount };
    await next();
  },
};

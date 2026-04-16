import { Context } from '@nocobase/actions';

export const tasksActions = {
  async list(ctx: Context, next: () => Promise<void>) {
    const repo = ctx.db.getRepository('asyncTasks');
    const { page = 1, pageSize = 20, statusFilter } = ctx.action.params;

    const filter: any = {};
    if (statusFilter !== undefined && statusFilter !== '') {
       filter.status = statusFilter === 'null' ? null : Number(statusFilter);
    }

    const [rows, count] = await repo.findAndCount({
      filter,
      appends: ['createdBy'],
      offset: (page - 1) * pageSize,
      limit: pageSize,
      sort: ['-createdAt'],
    });

    ctx.body = {
      data: rows,
      meta: { count, page: Number(page), pageSize: Number(pageSize) },
    };
    await next();
  },

  async cancel(ctx: Context, next: () => Promise<void>) {
    const { filterByTk } = ctx.action.params;
    if (!filterByTk) {
      ctx.throw(400, 'Task ID is required');
    }

    const repo = ctx.db.getRepository('asyncTasks');
    const task = await repo.findOne({ filterByTk });
    if (!task) {
      ctx.throw(404, 'Task not found');
    }

    // Status: RUNNING = 0, PENDING = null
    const status = task.get('status');
    if (status !== 0 && status !== null) {
      ctx.throw(400, 'Task is not running or pending');
    }

    // Try to cancel via pub/sub for cross-instance support
    const pluginName = '@nocobase/plugin-async-task-manager';
    try {
      await ctx.app.pubSubManager.publish(`${pluginName}.task.cancel`, {
        taskId: filterByTk,
      });
    } catch {
      // Fallback: direct DB update
    }

    await repo.update({
      filterByTk,
      values: {
        status: -2, // CANCELED
        doneAt: new Date(),
      },
    });

    ctx.body = { success: true };
    await next();
  },

  async retry(ctx: Context, next: () => Promise<void>) {
    const { filterByTk } = ctx.action.params;
    if (!filterByTk) {
      ctx.throw(400, 'Task ID is required');
    }

    const repo = ctx.db.getRepository('asyncTasks');
    const task = await repo.findOne({ filterByTk });
    if (!task) {
      ctx.throw(404, 'Task not found');
    }

    const status = task.get('status');
    // Only retry failed (-1) or canceled (-2) tasks
    if (status !== -1 && status !== -2) {
      ctx.throw(400, 'Only failed or canceled tasks can be retried');
    }

    await repo.update({
      filterByTk,
      values: {
        status: null, // PENDING
        result: null,
        progressCurrent: 0,
        startedAt: null,
        doneAt: null,
      },
    });

    // Re-queue the task
    const pluginName = '@nocobase/plugin-async-task-manager';
    try {
      await ctx.app.eventQueue.publish(`${pluginName}.task`, {
        taskId: filterByTk,
      });
    } catch {
      // Queue may not be available
    }

    ctx.body = { success: true };
    await next();
  },
};

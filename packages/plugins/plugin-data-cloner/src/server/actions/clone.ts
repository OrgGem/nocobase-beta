import { Context, Next } from '@nocobase/actions';
import { SchemaValidatorService } from '../services/SchemaValidatorService';
import { CloneEngineService } from '../services/CloneEngineService';

export async function validateAction(ctx: Context, next: Next) {
  const { source, target } = ctx.action.params.values;

  if (!source || !target) {
    ctx.throw(400, 'Source and Target datasource are required');
  }

  if (source === target) {
    ctx.throw(400, 'Source and Target datasource must be different');
  }

  const validator = new SchemaValidatorService(ctx.app);
  
  try {
    const result = await validator.validate(source, target);
    
    // Nếu tạo Task luôn từ đây thì có thể inject vào DB db.getRepository('clone_tasks')
    ctx.body = result;
  } catch (error) {
    ctx.throw(500, error.message);
  }
  
  await next();
}

export async function startCloneAction(ctx: Context, next: Next) {
  const { taskId, chunkSize } = ctx.action.params.values;

  if (!taskId) {
    ctx.throw(400, 'Missing taskId');
  }

  const task = await ctx.app.db.getRepository('clone_tasks').findById(taskId);
  if (!task) {
    ctx.throw(404, 'Task not found');
  }

  const engine = new CloneEngineService(ctx.app);

  // Run in background so request doesn't hang
  engine.startTask(taskId, { chunkSize: chunkSize || 1000 }).catch(async (err) => {
    ctx.app.logger.error(`Task ${taskId} failed:`, err);
    await engine.updateTaskStatus(taskId, 'error');
  });

  ctx.body = { message: 'Clone progress started in background', taskId };

  await next();
}

export async function pauseCloneAction(ctx: Context, next: Next) {
  const { taskId } = ctx.action.params.values;

  if (!taskId) {
    ctx.throw(400, 'Missing taskId');
  }

  const task = await ctx.app.db.getRepository('clone_tasks').findById(taskId);
  if (!task) {
    ctx.throw(404, 'Task not found');
  }

  const engine = new CloneEngineService(ctx.app);
  await engine.pauseTask(taskId);

  ctx.body = { message: 'Task paused', taskId };
  await next();
}
